// Vercel serverless function: GET /api/analyze?domain=example.com
//
// Runs real checks against a live domain (reachability, HTTPS, a
// mobile-friendly heuristic, page speed + accessibility + SEO via Google
// PageSpeed Insights, a social-links scan, a stale-copyright check, and
// a contact-info check of the fetched HTML). Google Reviews isn't
// checked at all — there's no reliable free way to verify that from a
// domain alone, and a wrong guess is worse than not showing it.
//
// No dependencies: uses the global fetch available in the Node 18+
// runtime Vercel deploys by default.

const UA = 'Mozilla/5.0 (compatible; JTBuildsCo-WebsiteHealthReport/1.0)';
const FETCH_TIMEOUT_MS = 8000;
const PAGESPEED_TIMEOUT_MS = 15000;

// Anchored on the hostname itself (protocol + optional "www." immediately
// before the platform domain) rather than a bare substring — a substring
// match on "x.com" alone also matches inside "netflix.com"/"fedex.com",
// and the previous fix for that (requiring a trailing slash) missed a
// bare "https://x.com" link with nothing after it. This fixes both.
const SOCIAL_RE = /(?:https?:)?\/\/(?:www\.)?(facebook\.com|instagram\.com|(?:twitter|x)\.com|linkedin\.com|tiktok\.com|youtube\.com|pinterest\.com|threads\.net|wa\.me|nextdoor\.com|snapchat\.com|yelp\.com)/i;
const TEL_LINK_RE = /href=["']tel:/i;
const PHONE_TEXT_RE = /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
const COPYRIGHT_YEAR_RE = /(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function decodeEntities(str) {
  return str.replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, k) => ENTITIES[k]);
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

function toneScore(tone) {
  return tone === 'good' ? 95 : tone === 'warning' ? 60 : 25;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const domain = normalizeDomain(req.query.domain);
  if (!domain) {
    res.status(200).json({
      ok: false,
      error: 'invalid_domain',
      message: "That doesn't look like a valid domain. Try something like yourbusiness.com.",
    });
    return;
  }

  const httpsUrl = 'https://' + domain;
  const httpUrl = 'http://' + domain;
  const fetchOpts = { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } };

  let response = null;
  let usedUrl = null;
  let sslOk = false;
  let elapsedMs = 0;
  let html = '';

  try {
    const t0 = Date.now();
    response = await fetchWithTimeout(httpsUrl, fetchOpts, FETCH_TIMEOUT_MS);
    html = await response.text();
    elapsedMs = Date.now() - t0;
    usedUrl = httpsUrl;
    sslOk = true;
  } catch (e) {
    response = null;
  }

  if (!response) {
    try {
      const t0 = Date.now();
      response = await fetchWithTimeout(httpUrl, fetchOpts, FETCH_TIMEOUT_MS);
      html = await response.text();
      elapsedMs = Date.now() - t0;
      usedUrl = httpUrl;
      sslOk = false;
    } catch (e) {
      res.status(200).json({
        ok: false,
        error: 'unreachable',
        message: "We couldn't reach " + domain + ". Double check the domain and try again.",
      });
      return;
    }
  }

  const statusCode = response.status;
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
  function scoreToStatus(score) {
    if (score >= 0.9) return 'good';
    if (score >= 0.5) return 'warning';
    return 'bad';
  }

  let speedStatus, speedDesc;
  let accessibilityStatus, accessibilityDesc;
  let seoStatus, seoDesc;

  try {
    const key = process.env.PAGESPEED_API_KEY;
    // Masked diagnostic only — never logs the full key. Lets us confirm
    // whether Vercel is actually injecting the env var at all, and
    // whether its value matches what was set in Google Cloud, without
    // exposing the secret in logs.
    console.log(
      '[analyze] PAGESPEED_API_KEY present:', !!key,
      key ? 'length: ' + key.length + ' looks-like: ' + key.slice(0, 4) + '...' + key.slice(-4) : ''
    );
    // Sent in both cases defensively: Google's API discovery docs for this
    // endpoint document the `category` enum in uppercase, but the response's
    // own category keys are lowercase, and without being able to test
    // against the live API from this environment, it's cheaper to send
    // both than to guess wrong and silently lose accessibility/SEO again.
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
    // Previously this failed silently — accessibility/SEO would always
    // land on the generic "couldn't verify" fallback with no way to tell
    // why. Now it's visible in Vercel's function logs.
    console.error('[analyze] PageSpeed Insights failed for', usedUrl, '—', e && e.message ? e.message : e);

    // PageSpeed Insights is unavailable or timed out — fall back to a
    // rough estimate from how long our own fetch took to load the page.
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

  if (!accessibilityStatus) {
    accessibilityStatus = 'warning';
    accessibilityDesc = "We couldn't fully verify accessibility this time — worth checking manually, since it affects how many visitors can actually use your site.";
  }
  if (!seoStatus) {
    seoStatus = 'warning';
    seoDesc = "We couldn't fully verify SEO fundamentals this time — worth another look, since it affects how easily Google can find you.";
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

  // --- Business name (best-effort, from <title>) ----------------------
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  let businessName = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  businessName = businessName.split(/\s[|\-–·•—]\s/)[0].trim();
  if (!businessName) businessName = domain;
  if (businessName.length > 60) {
    businessName = businessName.slice(0, 60).replace(/\s+\S*$/, '') + '…';
  }

  // --- Overall score: average of the 9 measured categories -----------
  const measured = [
    hasWebsiteStatus, sslStatus, mobileStatus, speedStatus, socialStatus,
    accessibilityStatus, seoStatus, freshnessStatus, contactStatus,
  ];
  const overallScore = Math.round(
    measured.reduce((sum, status) => sum + toneScore(status), 0) / measured.length
  );

  res.status(200).json({
    ok: true,
    businessName,
    town: domain,
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
    },
  });
};
