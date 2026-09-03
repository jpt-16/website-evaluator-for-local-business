// Vercel serverless function: GET /api/analyze?domain=example.com
//
// Runs real checks against a live domain: reachability, HTTPS, a
// mobile-friendly heuristic, page speed + accessibility + SEO via Google
// PageSpeed Insights, a social-links scan, a stale-copyright check, and a
// contact-info check. Google Reviews isn't checked at all — there's no
// reliable free way to verify that from a domain alone, and a wrong guess
// is worse than not showing it.
//
// The page is rendered with a real headless Chromium (puppeteer-core +
// @sparticuz/chromium) rather than a plain fetch, so content injected by
// client-side JS — very common for social icons on site-builder platforms
// like Wix/Squarespace — is actually visible to the checks below. If the
// browser itself fails to launch (bundle/runtime issue on a given
// deployment), this falls back to a plain fetch so the tool degrades
// instead of breaking outright.

// Both puppeteer-core and @sparticuz/chromium are ES Modules — Vercel's
// runtime doesn't support require()-ing them directly (throws
// ERR_REQUIRE_ESM), so both are loaded via dynamic import() instead, and
// lazily (inside renderWithBrowser, not at module load time) so a
// failure here still hits the plain-fetch fallback rather than crashing
// every request before the handler even runs.
let puppeteerPromise = null;
function loadPuppeteer() {
  if (!puppeteerPromise) puppeteerPromise = import('puppeteer-core').then((m) => m.default);
  return puppeteerPromise;
}
let chromiumPromise = null;
function loadChromium() {
  if (!chromiumPromise) chromiumPromise = import('@sparticuz/chromium').then((m) => m.default);
  return chromiumPromise;
}

const UA = 'Mozilla/5.0 (compatible; JTBuildsCo-WebsiteHealthReport/1.0)';
const FETCH_TIMEOUT_MS = 8000;
const BROWSER_NAV_TIMEOUT_MS = 12000;
const PAGESPEED_TIMEOUT_MS = 15000;
// PSI's own reliability notes acknowledge transient failures under load —
// one retry meaningfully cuts how often a site that's actually fine falls
// back to 'unknown' just because of a momentary blip. Only safe to afford
// (without risking Vercel's 60s function timeout) because this check now
// runs concurrently with the vision check below, not after it.
const PAGESPEED_MAX_ATTEMPTS = 2;
const CRAWL_FILE_TIMEOUT_MS = 5000;
const VISION_TIMEOUT_MS = 20000;

// NVIDIA's build.nvidia.com hosts several vision-capable models for free
// (no card, ~1000-5000 one-time credits, 40 req/min account-wide) behind
// an OpenAI-compatible endpoint. Overridable via env var since NVIDIA's
// catalog changes over time.
const VISION_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const VISION_MODEL = process.env.DESIGN_VISION_MODEL || 'meta/llama-3.2-11b-vision-instruct';
// The hosted endpoint caps the whole request body around 250KB; stay well
// under that (as base64 *text* characters, not raw image bytes) so a
// screenshot never risks a rejected request. If it doesn't fit, the vision
// check is skipped for that request rather than erroring.
const VISION_MAX_IMAGE_B64_CHARS = 170000;

const VISION_DESIGN_PROMPT =
  "You are looking at a screenshot of a local service business's website homepage. It already passed a basic technical check (custom fonts, real photography, modern layout code) — your job is to judge whether it actually LOOKS good to a prospective customer, which is a different question. A site can use all the right technology and still look cluttered, cramped, dated, or amateurish.\n\n" +
  'Consider: layout consistency, whitespace/spacing, visual hierarchy (is it obvious what matters most at a glance?), image quality and cropping, and color palette cohesion. Weigh all of that into one overall verdict — reserve "good" for a site that would genuinely look professional and trustworthy to a visitor, not just technically competent.\n\n' +
  'Respond with ONLY a single JSON object and nothing else — no markdown code fences, no explanation outside the JSON. It must have exactly these two fields: {"status": "good" | "warning" | "bad", "description": "one or two plain-English sentences written directly to the site owner, starting with \\"Your site...\\", explaining the verdict in specific, concrete terms — not generic praise or criticism"}';

// Free NVIDIA credits are a fixed one-time allotment (1000-5000 total),
// not a renewing quota — these two caps exist to make that last, not just
// to prevent abuse. Both are on top of (not instead of) the per-IP rate
// limit below, since that alone doesn't bound a vision call specifically:
// a single IP staying under it for an hour, or several different IPs,
// could still burn through the free credits or trip NVIDIA's own 40/min
// account-wide limit.
const VISION_BUDGET_WINDOW_MS = 60 * 60 * 1000;
const VISION_BUDGET_MAX = Number(process.env.DESIGN_VISION_MAX_PER_HOUR) || 100;
let visionCallLog = []; // timestamps, across all IPs
const VISION_RPM_WINDOW_MS = 60 * 1000;
const VISION_RPM_MAX = 30; // stay safely under NVIDIA's account-wide 40/min
let visionRpmLog = []; // timestamps, across all IPs

// Best-effort only — these live in the function instance's memory, so
// they reset on cold start and aren't shared across concurrent instances.
// That's fine for what they're for: taking the edge off casual repeat
// traffic and abuse, not providing a hard guarantee.
const CACHE_TTL_MS = 10 * 60 * 1000;
const resultCache = new Map(); // domain -> { at, data }
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateLimitLog = new Map(); // ip -> [timestamps]

// Allows any single subdomain label (not just "www.") — m.linkedin.com,
// business.facebook.com, uk.linkedin.com, etc. — while still anchoring on
// the real hostname so it can't match a substring inside an unrelated
// domain (e.g. "netflix.com", "definitely-not-linkedin.com").
const SOCIAL_RE = /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?(facebook\.com|instagram\.com|(?:twitter|x)\.com|linkedin\.com|tiktok\.com|youtube\.com|pinterest\.com|threads\.net|wa\.me|nextdoor\.com|snapchat\.com|yelp\.com)/i;
const TEL_LINK_RE = /href=["']tel:/i;
// Separators between digit groups are optional (not required) and include
// en/em dashes, so tightly-formatted numbers like "(555)123-4567" and
// unspaced ones like "5551234567" still match, not just "555-123-4567".
const PHONE_TEXT_RE = /(?:\+?1[\s.\-–—]?)?\(?\d{3}\)?[\s.\-–—]?\d{3}[\s.\-–—]?\d{4}\b/;
const COPYRIGHT_YEAR_RE = /(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})/gi;
// Literal HTML4-era tags — these have been deprecated for 20+ years, so
// their presence is a very reliable signal a site hasn't been rebuilt
// since, not a guess.
const DEPRECATED_MARKUP_RE = /<font[\s>]|<center[\s>]|<marquee[\s>]|<blink[\s>]/i;
// Matches a link whose href OR visible text is clearly a privacy policy /
// terms page — most sites use one of these two conventions, not both.
const PRIVACY_LINK_RE = /<a\b[^>]*href=["'][^"']*privacy[^"']*["']|>\s*privacy policy\s*</i;
const TERMS_LINK_RE = /<a\b[^>]*href=["'][^"']*terms[^"']*["']|>\s*terms(?:\s+(?:of|&amp;|and)\s+(?:service|use|conditions))?\s*</i;
// Structured data is the strongest signal (Google's own review markup);
// the text fallback catches sites that show reviews without schema.
const REVIEW_SCHEMA_RE = /"@type"\s*:\s*"(?:AggregateRating|Review)"/i;
const REVIEWS_TEXT_RE = /testimonial|what (?:our )?(?:customers|clients) (?:say|are saying)|customer reviews|read our reviews/i;
const JSONLD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const BUSINESS_TYPE_RE = /organization|localbusiness|business|store|shop|restaurant|professionalservice/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function decodeEntities(str) {
  return str.replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, k) => ENTITIES[k]);
}

function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

// The free, deterministic baseline for every request: concrete DOM/CSS
// signals, not a taste judgment. Catches "objectively hasn't been rebuilt"
// (default fonts, no photos, no modern layout, literal deprecated tags)
// but not "technically fine, still looks cluttered/amateurish" — that's
// what the vision check (below) exists to catch, layered on top of a
// 'good' verdict from this function specifically.
function heuristicDesignVerdict(html, designSignals) {
  if (!designSignals) {
    return {
      status: 'unknown',
      desc: "We couldn't fully render your site to check its visual design on the last check — try checking again in a bit.",
    };
  }
  const { usesCustomFont, usesModernLayout, realImages, layoutMode, fontFamily } = designSignals;
  const hasDeprecatedMarkup = DEPRECATED_MARKUP_RE.test(html);
  const positives = [usesCustomFont, usesModernLayout, realImages >= 2].filter(Boolean).length;

  // Concrete, site-specific phrases built from what was actually found —
  // reused across every tier below so the description reflects THIS site
  // (font name, exact photo count, which layout mode) instead of reading
  // identically for every site that happens to land in the same tier.
  const fontPhrase = usesCustomFont
    ? 'a custom font' + (fontFamily ? ' ("' + fontFamily + '")' : '')
    : 'default system fonts' + (fontFamily ? ' (currently "' + fontFamily + '")' : '');
  const imagePhrase = realImages === 0
    ? 'no real photography'
    : realImages === 1
    ? 'only one real photo'
    : realImages + ' real photos';
  const layoutPhrase = usesModernLayout
    ? 'a modern ' + (layoutMode || 'flex/grid') + ' layout'
    : 'an old-school layout with no flex/grid';

  if (hasDeprecatedMarkup) {
    return {
      status: 'bad',
      desc: "Your site still uses HTML from the early 2000s (like <font> or <center> tags) — a strong signal to visitors, and to Google, that it hasn't been rebuilt in a very long time.",
    };
  }
  if (positives === 3) {
    return {
      status: 'good',
      desc: 'Your site uses ' + fontPhrase + ', ' + imagePhrase + ', and ' + layoutPhrase + ' — it reads as current, not dated.',
    };
  }
  if (positives >= 1) {
    const missing = [];
    if (!usesCustomFont) missing.push(fontPhrase);
    if (!usesModernLayout) missing.push(layoutPhrase);
    if (realImages < 2) missing.push(imagePhrase);
    return {
      status: 'warning',
      desc: 'Your site has ' + joinList(missing) + " — small things individually, but often exactly what makes a site feel dated at first glance.",
    };
  }
  return {
    status: 'bad',
    desc: 'Your site relies on ' + fontPhrase + ', has ' + imagePhrase + ', and uses ' + layoutPhrase + " — together, that's what makes a site feel outdated the moment someone lands on it.",
  };
}

function normalizeDomain(raw) {
  let v = (raw || '').trim();
  if (!v) return null;
  v = v.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].split(':')[0];
  v = v.replace(/^www\./i, '');
  const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
  if (!HOSTNAME_RE.test(v)) return null;
  return v.toLowerCase();
}

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(id);
  }
}

// null means "exclude from the score average" — used for 'unknown'
// (couldn't verify), which shouldn't count against or for the site.
function toneScore(tone) {
  if (tone === 'good') return 95;
  if (tone === 'warning') return 60;
  if (tone === 'bad') return 25;
  return null;
}

function scoreToStatus(score) {
  if (score >= 0.9) return 'good';
  if (score >= 0.5) return 'warning';
  return 'bad';
}

function getClientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Returns false (and records nothing further) once an IP has made
// RATE_LIMIT_MAX requests within the trailing window.
function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = (rateLimitLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    rateLimitLog.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  rateLimitLog.set(ip, timestamps);
  return true;
}

// Returns false once VISION_BUDGET_MAX vision-model calls have happened
// (from any IP) within the trailing hour — protects the finite free
// credit pool, not just fair use per IP.
function checkVisionBudget() {
  const now = Date.now();
  visionCallLog = visionCallLog.filter((t) => now - t < VISION_BUDGET_WINDOW_MS);
  if (visionCallLog.length >= VISION_BUDGET_MAX) return false;
  visionCallLog.push(now);
  return true;
}

// Returns false once VISION_RPM_MAX vision-model calls have happened
// (from any IP) within the trailing minute — keeps this account under
// NVIDIA's own hard 40/min rate limit even under concurrent load.
function checkVisionRpm() {
  const now = Date.now();
  visionRpmLog = visionRpmLog.filter((t) => now - t < VISION_RPM_WINDOW_MS);
  if (visionRpmLog.length >= VISION_RPM_MAX) return false;
  visionRpmLog.push(now);
  return true;
}

// Only called when the heuristic above already says 'good' — this exists
// specifically to catch the false positive it can't: a site that's
// technically current (custom font, real photos, modern layout) but still
// looks cluttered, cramped, or amateurish. Returns null (keep the
// heuristic's 'good' verdict as-is) on any failure — missing API key,
// budget/rate exhausted, oversized image, timeout, malformed response —
// rather than blocking or guessing.
async function evaluateVisualDesignWithVision(screenshotBase64) {
  const apiKey = process.env.NVIDIA_API_KEY;
  // Masked diagnostic only — never logs the full key. Logged every time
  // this function is even attempted (not just on failure), so "key never
  // reached the function" is distinguishable from "key was rejected".
  console.log(
    '[analyze] NVIDIA_API_KEY present:', !!apiKey,
    apiKey ? 'length: ' + apiKey.length + ' looks-like: ' + apiKey.slice(0, 6) + '...' + apiKey.slice(-4) : ''
  );
  if (!apiKey) return null;
  if (screenshotBase64.length > VISION_MAX_IMAGE_B64_CHARS) {
    console.warn('[analyze] vision design check skipped — screenshot too large for the hosted request-body limit');
    return null;
  }
  if (!checkVisionBudget()) {
    console.warn('[analyze] vision design check skipped — hourly budget of', VISION_BUDGET_MAX, 'calls exhausted');
    return null;
  }
  if (!checkVisionRpm()) {
    console.warn('[analyze] vision design check skipped — per-minute budget of', VISION_RPM_MAX, 'calls exhausted');
    return null;
  }
  try {
    const res = await fetchWithTimeout(VISION_API_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 300,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_DESIGN_PROMPT },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + screenshotBase64 } },
          ],
        }],
      }),
    }, VISION_TIMEOUT_MS);

    if (!res.ok) {
      console.error('[analyze] vision design check http', res.status, (await res.text().catch(() => '')).slice(0, 400));
      return null;
    }
    const json = await res.json();
    const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!text) {
      console.error('[analyze] vision design check — response had no message content:', JSON.stringify(json).slice(0, 400));
      return null;
    }

    // The model is asked for pure JSON, but defensively pull out just the
    // {...} block in case it wraps it in prose or a code fence anyway.
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('[analyze] vision design check — no JSON object found in response text:', String(text).slice(0, 400));
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch (e) {
      console.error('[analyze] vision design check — JSON.parse failed on:', match[0].slice(0, 400));
      return null;
    }
    if (!parsed || !['good', 'warning', 'bad'].includes(parsed.status) || !parsed.description) {
      console.error('[analyze] vision design check — parsed JSON missing expected shape:', JSON.stringify(parsed).slice(0, 400));
      return null;
    }
    console.log('[analyze] vision design check succeeded — status:', parsed.status);
    return { status: parsed.status, desc: String(parsed.description).slice(0, 500) };
  } catch (e) {
    console.error('[analyze] vision design check failed —', e && e.message ? e.message : e);
    return null;
  }
}

// robots.txt / sitemap.xml existing is a real, if minor, crawlability
// signal — separate from PageSpeed's on-page SEO score, which doesn't
// check either. A non-2xx or any fetch error (timeout, DNS, etc.) both
// just count as "not present" — same honest-guess-free spirit as
// everything else here, no special-casing failure modes.
async function checkCrawlFile(url) {
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, CRAWL_FILE_TIMEOUT_MS);
    return res.ok;
  } catch (e) {
    return false;
  }
}

// A single attempt at the PageSpeed Insights call — throws on any failure
// (timeout, network error, non-2xx) so the retry loop below can catch it.
async function fetchPageSpeedOnce(usedUrl) {
  const key = process.env.PAGESPEED_API_KEY;
  // Sent in both cases defensively: Google's API discovery docs for this
  // endpoint document the `category` enum in uppercase, but the response's
  // own category keys are lowercase.
  const categoryParams =
    'category=performance&category=PERFORMANCE' +
    '&category=accessibility&category=ACCESSIBILITY' +
    '&category=seo&category=SEO';
  const psUrl =
    'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile' +
    '&' + categoryParams + '&url=' +
    encodeURIComponent(usedUrl) +
    (key ? '&key=' + key : '');
  const psRes = await fetchWithTimeout(psUrl, {}, PAGESPEED_TIMEOUT_MS);
  if (!psRes.ok) {
    const errBody = await psRes.text().catch(() => '');
    throw new Error('pagespeed http ' + psRes.status + (errBody ? ' — ' + errBody.slice(0, 400) : ''));
  }
  const psJson = await psRes.json();
  return psJson.lighthouseResult.categories;
}

// Page Speed, Accessibility, and SEO Basics all come from one PageSpeed
// Insights call — Lighthouse computes all three together, so there's no
// extra network cost to getting all of them from a single request.
//
// All three go to 'unknown' ("Not Verified") if PSI fails even after a
// retry — including Speed, which used to silently fall back to a local
// timing guess (how long *our own server* took to fetch the page) under
// the exact same status labels as a real Lighthouse score. That let the
// same unchanged site show as "Failing" one run and "Good" the next
// purely because two different measurement methods disagreed, with no
// indication either had happened — worse than just saying "couldn't
// verify," which Accessibility/SEO already do honestly when this fails.
async function runPageSpeedCheck(usedUrl) {
  const key = process.env.PAGESPEED_API_KEY;
  // Masked diagnostic only — never logs the full key.
  console.log(
    '[analyze] PAGESPEED_API_KEY present:', !!key,
    key ? 'length: ' + key.length + ' looks-like: ' + key.slice(0, 4) + '...' + key.slice(-4) : ''
  );

  let cats = null;
  for (let attempt = 1; attempt <= PAGESPEED_MAX_ATTEMPTS; attempt++) {
    try {
      cats = await fetchPageSpeedOnce(usedUrl);
      break;
    } catch (e) {
      console.error('[analyze] PageSpeed Insights attempt', attempt, 'of', PAGESPEED_MAX_ATTEMPTS, 'failed for', usedUrl, '—', e && e.message ? e.message : e);
    }
  }

  const result = {};
  if (cats) {
    if (!cats.accessibility || !cats.seo) {
      console.warn('[analyze] PageSpeed response missing categories for', usedUrl, '— got:', Object.keys(cats).join(', '));
    }

    result.speedStatus = scoreToStatus(cats.performance.score);
    result.speedDesc = result.speedStatus === 'good'
      ? 'Your site loads quickly on mobile.'
      : result.speedStatus === 'warning'
      ? 'Your site loads a bit slowly on mobile — some visitors may leave before it finishes.'
      : 'Your site is slow to load on mobile, and slow sites lose visitors fast.';

    if (cats.accessibility && cats.accessibility.score != null) {
      result.accessibilityStatus = scoreToStatus(cats.accessibility.score);
      result.accessibilityDesc = result.accessibilityStatus === 'good'
        ? 'Your site follows good accessibility practices for screen readers and assistive tech.'
        : result.accessibilityStatus === 'warning'
        ? 'Some accessibility basics could use attention — a few visitors using assistive tech may have a rougher time.'
        : 'Your site has real accessibility gaps, making it hard to use for visitors relying on assistive tech.';
    }

    if (cats.seo && cats.seo.score != null) {
      result.seoStatus = scoreToStatus(cats.seo.score);
      result.seoDesc = result.seoStatus === 'good'
        ? 'Your site follows the basics Google looks for.'
        : result.seoStatus === 'warning'
        ? 'A few basic SEO fundamentals are missing or incomplete.'
        : 'Your site is missing basic SEO fundamentals, making it harder for Google to find and rank you.';
    }
  }

  if (!result.speedStatus) {
    result.speedStatus = 'unknown';
    result.speedDesc = "We couldn't verify this on the last check (a technical issue on our end, not a reflection of your site) — try checking again in a bit.";
  }
  if (!result.accessibilityStatus) {
    result.accessibilityStatus = 'unknown';
    result.accessibilityDesc = "We couldn't verify this on the last check (a technical issue on our end, not a reflection of your site) — try checking again in a bit.";
  }
  if (!result.seoStatus) {
    result.seoStatus = 'unknown';
    result.seoDesc = "We couldn't verify this on the last check (a technical issue on our end, not a reflection of your site) — try checking again in a bit.";
  }
  return result;
}

// Renders the page in a real headless browser so client-side-injected
// content (social widgets, etc.) is visible, not just the initial HTML.
async function renderWithBrowser(httpsUrl, httpUrl, ua, timeoutMs) {
  const [puppeteer, chromium] = await Promise.all([loadPuppeteer(), loadChromium()]);
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    // Fixed desktop size so the visual-design screenshot (below) shows a
    // consistent, representative view rather than whatever puppeteer's
    // undocumented default happens to be — most local-business sites are
    // still designed desktop-first even when responsive.
    await page.setViewport({ width: 1280, height: 800 });
    let response, usedUrl, sslOk;
    try {
      response = await page.goto(httpsUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      usedUrl = httpsUrl;
      sslOk = true;
    } catch (e) {
      response = await page.goto(httpUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      usedUrl = httpUrl;
      sslOk = false;
    }
    // Give client-side widgets (social icons, embedded scripts) a beat to
    // inject content after the initial DOM is ready, without waiting for
    // every last network connection to go idle (some pages never do).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const html = await page.content();
    // Signals for the "visual design" check — only obtainable from a live,
    // rendered DOM (not a plain-fetch fallback), so this is null there.
    const designSignals = await page.evaluate(() => {
      try {
        var realImages = 0;
        var imgs = document.images || [];
        for (var i = 0; i < imgs.length; i++) {
          if (imgs[i].naturalWidth >= 100 && imgs[i].naturalHeight >= 100) realImages++;
        }
        var usesCustomFont = !!(document.fonts && document.fonts.size > 0);
        var usesModernLayout = false;
        var layoutMode = null;
        var all = document.querySelectorAll('body, body *');
        var cap = Math.min(all.length, 400);
        for (var j = 0; j < cap; j++) {
          var d = getComputedStyle(all[j]).display;
          if (d === 'flex' || d === 'inline-flex') {
            usesModernLayout = true;
            layoutMode = 'flexbox';
            break;
          }
          if (d === 'grid' || d === 'inline-grid') {
            usesModernLayout = true;
            layoutMode = 'grid';
            break;
          }
        }
        // Just for a concrete detail in the description text below — not
        // used for scoring. Filtered to skip internal CSS tokens/generic
        // keywords (e.g. "-apple-system", "sans-serif") that would look
        // like a bug if shown to a non-technical site owner; a real name
        // like "Arial" or "Poppins" is still shown either way.
        var fontFamily = null;
        try {
          var bodyFont = getComputedStyle(document.body).fontFamily;
          if (bodyFont) {
            var raw = bodyFont.split(',')[0].replace(/["']/g, '').trim();
            var GENERIC_FONT_RE = /^(-apple-system|blinkmacsystemfont|system-ui|ui-sans-serif|ui-serif|ui-monospace|sans-serif|serif|monospace|cursive|fantasy)$/i;
            if (raw && !GENERIC_FONT_RE.test(raw)) fontFamily = raw;
          }
        } catch (e) {}
        return {
          realImages: realImages,
          usesCustomFont: usesCustomFont,
          usesModernLayout: usesModernLayout,
          layoutMode: layoutMode,
          fontFamily: fontFamily,
        };
      } catch (e) {
        return null;
      }
    });

    // Only screenshot (and later, only spend a vision-model call) on sites
    // the free heuristic already thinks look "good" — that's specifically
    // where it can be wrong (technically current, still looks bad), and
    // bounding it to that subset keeps the added cost/latency contained
    // instead of hitting every single request. Quality is deliberately low
    // (still plenty to judge layout/whitespace/color) to comfortably fit
    // under the hosted vision API's request-body size limit as base64.
    let designScreenshot = null;
    if (heuristicDesignVerdict(html, designSignals).status === 'good') {
      try {
        designScreenshot = await page.screenshot({ type: 'jpeg', quality: 45, encoding: 'base64' });
      } catch (e) {
        designScreenshot = null; // non-fatal — vision check just gets skipped below
      }
    }

    return {
      statusCode: response ? response.status() : 0,
      usedUrl,
      sslOk,
      html,
      designSignals,
      designScreenshot,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Fallback if the headless browser itself fails to launch — a plain fetch
// won't see JS-injected content, but the tool still works in a degraded
// mode instead of breaking outright.
async function fetchPlain(httpsUrl, httpUrl, ua) {
  const fetchOpts = { headers: { 'User-Agent': ua, Accept: 'text/html,*/*' } };
  try {
    const response = await fetchWithTimeout(httpsUrl, fetchOpts, FETCH_TIMEOUT_MS);
    const html = await response.text();
    return { statusCode: response.status, usedUrl: httpsUrl, sslOk: true, html, designSignals: null, designScreenshot: null };
  } catch (e) {
    const response = await fetchWithTimeout(httpUrl, fetchOpts, FETCH_TIMEOUT_MS);
    const html = await response.text();
    return { statusCode: response.status, usedUrl: httpUrl, sslOk: false, html, designSignals: null, designScreenshot: null };
  }
}

// Prefers Organization/LocalBusiness structured data (JSON-LD) for the
// business name and location over the <title> tag, which is often noisy
// ("Home | Best Landscaper in Millbrook | Free Quotes | ..."). Returns
// null if no usable structured data is found.
function extractStructuredBusiness(html) {
  let match;
  while ((match = JSONLD_RE.exec(html))) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch (e) {
      continue;
    }
    const candidates = Array.isArray(data) ? data : data['@graph'] || [data];
    for (const node of candidates) {
      if (!node || typeof node !== 'object') continue;
      const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      const isBusiness = types.some((t) => typeof t === 'string' && BUSINESS_TYPE_RE.test(t));
      if (isBusiness && node.name) {
        let location = null;
        const addr = node.address;
        if (addr && typeof addr === 'object') {
          const locality = addr.addressLocality;
          const region = addr.addressRegion;
          location = locality && region ? locality + ', ' + region : locality || null;
        }
        return { name: String(node.name).trim(), location };
      }
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    res.status(429).json({
      ok: false,
      error: 'rate_limited',
      message: "You're checking sites a bit fast — wait a minute and try again.",
    });
    return;
  }

  const domain = normalizeDomain(req.query.domain);
  if (!domain) {
    res.status(200).json({
      ok: false,
      error: 'invalid_domain',
      message: "That doesn't look like a valid domain. Try something like yourbusiness.com.",
    });
    return;
  }

  const cached = resultCache.get(domain);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.status(200).json(cached.data);
    return;
  }

  const httpsUrl = 'https://' + domain;
  const httpUrl = 'http://' + domain;

  // Kicked off now so it overlaps with the render/PageSpeed work below
  // instead of adding to it — awaited later, right where it's needed.
  const crawlFilesPromise = Promise.all([
    checkCrawlFile(httpsUrl + '/robots.txt'),
    checkCrawlFile(httpsUrl + '/sitemap.xml'),
  ]);

  let statusCode, usedUrl, sslOk, html, designSignals, designScreenshot;
  try {
    const rendered = await renderWithBrowser(httpsUrl, httpUrl, UA, BROWSER_NAV_TIMEOUT_MS);
    statusCode = rendered.statusCode;
    usedUrl = rendered.usedUrl;
    sslOk = rendered.sslOk;
    html = rendered.html;
    designSignals = rendered.designSignals;
    designScreenshot = rendered.designScreenshot;
  } catch (browserErr) {
    console.error('[analyze] headless render failed for', domain, '— falling back to plain fetch —', browserErr && browserErr.message);
    try {
      const plain = await fetchPlain(httpsUrl, httpUrl, UA);
      statusCode = plain.statusCode;
      usedUrl = plain.usedUrl;
      sslOk = plain.sslOk;
      html = plain.html;
      designSignals = plain.designSignals;
      designScreenshot = plain.designScreenshot;
    } catch (fetchErr) {
      res.status(200).json({
        ok: false,
        error: 'unreachable',
        message: "We couldn't reach " + domain + ". Double check the domain and try again.",
      });
      return;
    }
  }

  const reachableOk = statusCode >= 200 && statusCode < 400;

  // --- Has a website ------------------------------------------------
  const hasWebsiteStatus = reachableOk ? 'good' : 'bad';
  const hasWebsiteDesc = reachableOk
    ? 'Your site is live and responding normally.'
    : 'We got an error (HTTP ' + statusCode + ') trying to load your site — visitors may be seeing the same thing.';

  // --- SSL / security -------------------------------------------------
  const sslStatus = sslOk ? 'good' : 'bad';
  const sslDesc = sslOk
    ? 'Your site loads securely over HTTPS — no browser warnings.'
    : 'Your site doesn’t load securely over HTTPS, so browsers may show visitors a "Not Secure" warning.';

  // --- Mobile-friendly (viewport meta heuristic) ----------------------
  const viewportMatch = html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i);
  let mobileStatus = 'bad';
  let mobileDesc = "We didn't find a mobile-friendly tag, so your site likely doesn't resize for phones — and most visitors are on their phones.";
  if (viewportMatch) {
    if (/width\s*=\s*device-width/i.test(viewportMatch[0])) {
      mobileStatus = 'good';
      mobileDesc = 'Your site is set up to adapt to phone screens.';
    } else {
      mobileStatus = 'warning';
      mobileDesc = 'Your site has a mobile tag, but it may not resize properly on phones — worth checking on an actual phone.';
    }
  }

  // --- Social media presence ------------------------------------------
  const socialStatus = SOCIAL_RE.test(html) ? 'good' : 'bad';
  const socialDesc = socialStatus === 'good'
    ? 'We found a link to at least one social profile on your site.'
    : "We didn't find any links to social profiles on your site.";

  // --- Page Speed / Accessibility / SEO (PageSpeed Insights, with a
  // retry) and Visual Design's vision layer, run concurrently -----------
  // Both are independent of each other and both can be slow, so running
  // them at the same time (rather than one after the other) is what makes
  // PageSpeed's retry affordable without risking Vercel's 60s function
  // timeout.
  const pageSpeedPromise = runPageSpeedCheck(usedUrl);

  const heuristic = heuristicDesignVerdict(html, designSignals);
  const visionPromise = (heuristic.status === 'good' && designScreenshot)
    ? evaluateVisualDesignWithVision(designScreenshot)
    : Promise.resolve(null);

  const [pageSpeedResult, visionVerdict] = await Promise.all([pageSpeedPromise, visionPromise]);

  const { speedStatus, speedDesc, accessibilityStatus, accessibilityDesc, seoStatus, seoDesc } = pageSpeedResult;

  let designStatus = heuristic.status;
  let designDesc = heuristic.desc;
  if (visionVerdict) {
    designStatus = visionVerdict.status;
    designDesc = visionVerdict.desc;
  }
  // else: vision call failed/unavailable/skipped — keep the heuristic's
  // 'good' verdict rather than blocking on it.

  // --- Site freshness (stale copyright year) ---------------------------
  let freshnessStatus = 'good';
  let freshnessDesc = "We didn't find anything that signals the site is out of date.";
  let latestCopyrightYear = null;
  let copyrightMatch;
  while ((copyrightMatch = COPYRIGHT_YEAR_RE.exec(html))) {
    const y = parseInt(copyrightMatch[1], 10);
    if (!latestCopyrightYear || y > latestCopyrightYear) latestCopyrightYear = y;
  }
  if (latestCopyrightYear) {
    const yearsStale = new Date().getFullYear() - latestCopyrightYear;
    if (yearsStale >= 2) {
      freshnessStatus = 'bad';
      freshnessDesc = 'Your site\'s footer still says © ' + latestCopyrightYear + ' — that\'s a quiet signal to visitors that nobody\'s minding the store.';
    } else if (yearsStale === 1) {
      freshnessStatus = 'warning';
      freshnessDesc = 'Your site\'s footer still shows ' + latestCopyrightYear + ' — a year behind isn\'t alarming, but it\'s worth a refresh.';
    } else {
      freshnessStatus = 'good';
      freshnessDesc = "Your site's footer shows a current copyright year.";
    }
  }

  // --- Contact info visibility ------------------------------------------
  let contactStatus, contactDesc;
  if (TEL_LINK_RE.test(html)) {
    contactStatus = 'good';
    contactDesc = 'Your phone number is a tap-to-call link — easy for mobile visitors to reach you instantly.';
  } else if (PHONE_TEXT_RE.test(html)) {
    contactStatus = 'warning';
    contactDesc = "Your phone number is on the site, but it's not a tap-to-call link — mobile visitors have to copy and dial it manually.";
  } else {
    contactStatus = 'bad';
    contactDesc = "We couldn't find a phone number anywhere on the site — visitors have no fast way to reach you.";
  }

  // --- Privacy Policy / Terms links -------------------------------------
  let privacyStatus, privacyDesc;
  if (PRIVACY_LINK_RE.test(html)) {
    privacyStatus = 'good';
    privacyDesc = 'Your site links to a privacy policy — visitors (and some ad/analytics platforms) expect to find one.';
  } else if (TERMS_LINK_RE.test(html)) {
    privacyStatus = 'warning';
    privacyDesc = "Your site links to terms of some kind, but we didn't find a clearly-labeled privacy policy — worth adding one explicitly.";
  } else {
    privacyStatus = 'bad';
    privacyDesc = "We didn't find a privacy policy or terms link anywhere on your site.";
  }

  // --- Reviews / testimonials presence ----------------------------------
  // Structured data (Review/AggregateRating schema) is the stronger
  // signal — it's what Google itself reads for review stars in search
  // results — with a plain-text fallback for sites that show reviews
  // without markup.
  const reviewsStatus = (REVIEW_SCHEMA_RE.test(html) || REVIEWS_TEXT_RE.test(html)) ? 'good' : 'bad';
  const reviewsDesc = reviewsStatus === 'good'
    ? 'Your site highlights customer reviews or testimonials — real social proof that helps convince new visitors.'
    : "We didn't find any reviews or testimonials on your site — visitors have no social proof that other customers trust you.";

  // --- Crawlability (robots.txt / sitemap.xml) --------------------------
  // Separate from PageSpeed's on-page SEO score, which checks neither —
  // this is about whether Google can efficiently discover and crawl the
  // site at all, not how well any single page is optimized.
  const [hasRobots, hasSitemap] = await crawlFilesPromise;
  let crawlabilityStatus, crawlabilityDesc;
  if (hasRobots && hasSitemap) {
    crawlabilityStatus = 'good';
    crawlabilityDesc = 'Your site has both a robots.txt and a sitemap.xml — Google can find and crawl it efficiently.';
  } else if (hasRobots || hasSitemap) {
    crawlabilityStatus = 'warning';
    const missing = hasRobots ? 'a sitemap.xml' : 'a robots.txt';
    crawlabilityDesc = 'Your site has ' + (hasRobots ? 'a robots.txt' : 'a sitemap.xml') + ' but not ' + missing + ' — adding the other makes it easier for Google to crawl everything.';
  } else {
    crawlabilityStatus = 'bad';
    crawlabilityDesc = "We didn't find a robots.txt or sitemap.xml — Google may be missing pages on your site simply because it can't find them.";
  }

  // --- Business name + location (structured data first, <title> fallback)
  const structured = extractStructuredBusiness(html);
  let businessName, location;
  if (structured && structured.name) {
    businessName = structured.name;
    location = structured.location;
  } else {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    businessName = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
    businessName = businessName.split(/\s[|\-–·•—]\s/)[0].trim();
    location = null;
  }
  if (!businessName) businessName = domain;
  if (businessName.length > 60) {
    businessName = businessName.slice(0, 60).replace(/\s+\S*$/, '') + '…';
  }

  // --- Overall score: average of whichever categories we could actually
  // verify (usually all 13 — 'unknown' only shows up when PageSpeed or the
  // headless render itself failed, and is excluded here rather than
  // counted as a strike against the site).
  const measured = [
    hasWebsiteStatus, sslStatus, mobileStatus, speedStatus, socialStatus,
    accessibilityStatus, seoStatus, freshnessStatus, contactStatus, designStatus,
    privacyStatus, reviewsStatus, crawlabilityStatus,
  ].map(toneScore).filter((score) => score !== null);
  const overallScore = Math.round(
    measured.reduce((sum, score) => sum + score, 0) / measured.length
  );

  const responseData = {
    ok: true,
    businessName,
    town: domain,
    location,
    preparedDate: 'just now',
    overallScore,
    hasWebsiteStatus,
    mobileStatus,
    speedStatus,
    sslStatus,
    socialStatus,
    accessibilityStatus,
    seoStatus,
    freshnessStatus,
    contactStatus,
    designStatus,
    privacyStatus,
    reviewsStatus,
    crawlabilityStatus,
    descriptions: {
      hasWebsite: hasWebsiteDesc,
      mobile: mobileDesc,
      speed: speedDesc,
      ssl: sslDesc,
      social: socialDesc,
      accessibility: accessibilityDesc,
      seo: seoDesc,
      freshness: freshnessDesc,
      contact: contactDesc,
      design: designDesc,
      privacy: privacyDesc,
      reviews: reviewsDesc,
      crawlability: crawlabilityDesc,
    },
  };

  resultCache.set(domain, { at: Date.now(), data: responseData });
  res.status(200).json(responseData);
};
