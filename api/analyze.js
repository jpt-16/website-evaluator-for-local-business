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
    const t0 = Date.now();
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
        var all = document.querySelectorAll('body, body *');
        var cap = Math.min(all.length, 400);
        for (var j = 0; j < cap; j++) {
          var d = getComputedStyle(all[j]).display;
          if (d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid') {
            usesModernLayout = true;
            break;
          }
        }
        return { realImages: realImages, usesCustomFont: usesCustomFont, usesModernLayout: usesModernLayout };
      } catch (e) {
        return null;
      }
    });
    return {
      statusCode: response ? response.status() : 0,
      usedUrl,
      sslOk,
      html,
      elapsedMs: Date.now() - t0,
      designSignals,
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
    const t0 = Date.now();
    const response = await fetchWithTimeout(httpsUrl, fetchOpts, FETCH_TIMEOUT_MS);
    const html = await response.text();
    return { statusCode: response.status, usedUrl: httpsUrl, sslOk: true, html, elapsedMs: Date.now() - t0, designSignals: null };
  } catch (e) {
    const t0 = Date.now();
    const response = await fetchWithTimeout(httpUrl, fetchOpts, FETCH_TIMEOUT_MS);
    const html = await response.text();
    return { statusCode: response.status, usedUrl: httpUrl, sslOk: false, html, elapsedMs: Date.now() - t0, designSignals: null };
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

  let statusCode, usedUrl, sslOk, html, elapsedMs, designSignals;
  try {
    const rendered = await renderWithBrowser(httpsUrl, httpUrl, UA, BROWSER_NAV_TIMEOUT_MS);
    statusCode = rendered.statusCode;
    usedUrl = rendered.usedUrl;
    sslOk = rendered.sslOk;
    html = rendered.html;
    elapsedMs = rendered.elapsedMs;
    designSignals = rendered.designSignals;
  } catch (browserErr) {
    console.error('[analyze] headless render failed for', domain, '— falling back to plain fetch —', browserErr && browserErr.message);
    try {
      const plain = await fetchPlain(httpsUrl, httpUrl, UA);
      statusCode = plain.statusCode;
      usedUrl = plain.usedUrl;
      sslOk = plain.sslOk;
      html = plain.html;
      elapsedMs = plain.elapsedMs;
      designSignals = plain.designSignals;
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

  // --- Page speed, Accessibility, SEO: one Google PageSpeed Insights
  // call covers all three Lighthouse categories, with a timing-based
  // fallback for speed only if the API call itself fails (there's no
  // local equivalent for accessibility/SEO, so those just go unverified).
  let speedStatus, speedDesc;
  let accessibilityStatus, accessibilityDesc;
  let seoStatus, seoDesc;

  try {
    const key = process.env.PAGESPEED_API_KEY;
    // Masked diagnostic only — never logs the full key.
    console.log(
      '[analyze] PAGESPEED_API_KEY present:', !!key,
      key ? 'length: ' + key.length + ' looks-like: ' + key.slice(0, 4) + '...' + key.slice(-4) : ''
    );
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
    const cats = psJson.lighthouseResult.categories;
    if (!cats.accessibility || !cats.seo) {
      console.warn('[analyze] PageSpeed response missing categories for', usedUrl, '— got:', Object.keys(cats).join(', '));
    }

    speedStatus = scoreToStatus(cats.performance.score);
    speedDesc = speedStatus === 'good'
      ? 'Your site loads quickly on mobile.'
      : speedStatus === 'warning'
      ? 'Your site loads a bit slowly on mobile — some visitors may leave before it finishes.'
      : 'Your site is slow to load on mobile, and slow sites lose visitors fast.';

    if (cats.accessibility && cats.accessibility.score != null) {
      accessibilityStatus = scoreToStatus(cats.accessibility.score);
      accessibilityDesc = accessibilityStatus === 'good'
        ? 'Your site follows good accessibility practices for screen readers and assistive tech.'
        : accessibilityStatus === 'warning'
        ? 'Some accessibility basics could use attention — a few visitors using assistive tech may have a rougher time.'
        : 'Your site has real accessibility gaps, making it hard to use for visitors relying on assistive tech.';
    }

    if (cats.seo && cats.seo.score != null) {
      seoStatus = scoreToStatus(cats.seo.score);
      seoDesc = seoStatus === 'good'
        ? 'Your site follows the basics Google looks for.'
        : seoStatus === 'warning'
        ? 'A few basic SEO fundamentals are missing or incomplete.'
        : 'Your site is missing basic SEO fundamentals, making it harder for Google to find and rank you.';
    }
  } catch (e) {
    console.error('[analyze] PageSpeed Insights failed for', usedUrl, '—', e && e.message ? e.message : e);
    if (elapsedMs < 1200) {
      speedStatus = 'good';
      speedDesc = 'Your site responded quickly in our check.';
    } else if (elapsedMs < 3000) {
      speedStatus = 'warning';
      speedDesc = 'Your site took a little while to respond in our check — worth a closer look.';
    } else {
      speedStatus = 'bad';
      speedDesc = 'Your site was slow to respond in our check, and slow sites lose visitors fast.';
    }
  }

  // Distinct from a real "warning" verdict — this means we don't know,
  // not that we checked and it was mediocre. Excluded from the score
  // below rather than guessed at.
  if (!accessibilityStatus) {
    accessibilityStatus = 'unknown';
    accessibilityDesc = "We couldn't verify this on the last check (a technical issue on our end, not a reflection of your site) — try checking again in a bit.";
  }
  if (!seoStatus) {
    seoStatus = 'unknown';
    seoDesc = "We couldn't verify this on the last check (a technical issue on our end, not a reflection of your site) — try checking again in a bit.";
  }

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

  // --- Visual design (modern vs. dated look) ---------------------------
  // Can't judge taste, but "looks old and boring" tends to have concrete,
  // checkable fingerprints: default system fonts only, no real photography,
  // an old-school (non-flex/grid) layout, or literal HTML4-era tags like
  // <font>/<center>/<marquee>. This catches those, honestly, rather than
  // guessing at aesthetics. Only available when the headless browser
  // actually rendered the page (not the plain-fetch fallback), since it
  // needs a live DOM to check loaded fonts/images/computed layout.
  let designStatus, designDesc;
  if (designSignals) {
    const hasDeprecatedMarkup = DEPRECATED_MARKUP_RE.test(html);
    const positives = [
      designSignals.usesCustomFont,
      designSignals.usesModernLayout,
      designSignals.realImages >= 2,
    ].filter(Boolean).length;

    if (hasDeprecatedMarkup) {
      designStatus = 'bad';
      designDesc = "Your site still uses HTML from the early 2000s (like <font> or <center> tags) — a strong signal to visitors, and to Google, that it hasn't been rebuilt in a very long time.";
    } else if (positives === 3) {
      designStatus = 'good';
      designDesc = 'Your site uses custom fonts, real photography, and a modern layout — it reads as current, not dated.';
    } else if (positives >= 1) {
      designStatus = 'warning';
      const missing = [];
      if (!designSignals.usesCustomFont) missing.push('custom fonts');
      if (!designSignals.usesModernLayout) missing.push('a modern layout');
      if (designSignals.realImages < 2) missing.push('real photography');
      designDesc = 'Your site is missing ' + joinList(missing) + " — small things individually, but often exactly what makes a site feel dated at first glance.";
    } else {
      designStatus = 'bad';
      designDesc = "Your site relies on default system fonts, has no real photography, and uses an old-school layout — together, that's what makes a site feel outdated the moment someone lands on it.";
    }
  } else {
    designStatus = 'unknown';
    designDesc = "We couldn't fully render your site to check its visual design on the last check — try checking again in a bit.";
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
  // verify (usually all 10 — 'unknown' only shows up when PageSpeed or the
  // headless render itself failed, and is excluded here rather than
  // counted as a strike against the site).
  const measured = [
    hasWebsiteStatus, sslStatus, mobileStatus, speedStatus, socialStatus,
    accessibilityStatus, seoStatus, freshnessStatus, contactStatus, designStatus,
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
    },
  };

  resultCache.set(domain, { at: Date.now(), data: responseData });
  res.status(200).json(responseData);
};
