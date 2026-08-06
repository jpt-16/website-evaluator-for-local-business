// Vercel serverless function: GET /api/analyze?domain=example.com
//
// Runs real checks against a live domain (reachability, HTTPS, a
// mobile-friendly heuristic, page speed via Google PageSpeed Insights,
// and a social-links scan of the fetched HTML). Google Reviews is
// deliberately reported as "not automatically checked" rather than
// guessed — there's no reliable free signal for that from a domain
// alone, and a wrong guess is worse than an honest "we didn't check".
//
// No dependencies: uses the global fetch available in the Node 18+
// runtime Vercel deploys by default.

const UA = 'Mozilla/5.0 (compatible; JTBuildsCo-WebsiteHealthReport/1.0)';
const FETCH_TIMEOUT_MS = 8000;
const PAGESPEED_TIMEOUT_MS = 15000;

const SOCIAL_RE = /(facebook\.com|instagram\.com|twitter\.com|x\.com\/|linkedin\.com|tiktok\.com|youtube\.com|yelp\.com)/i;
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

  // --- Page speed: Google PageSpeed Insights, with a timing fallback --
  let speedStatus;
  let speedDesc;
  try {
    const key = process.env.PAGESPEED_API_KEY;
    const psUrl =
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&url=' +
      encodeURIComponent(usedUrl) +
      (key ? '&key=' + key : '');
    const psRes = await fetchWithTimeout(psUrl, {}, PAGESPEED_TIMEOUT_MS);
    if (!psRes.ok) throw new Error('pagespeed http ' + psRes.status);
    const psJson = await psRes.json();
    const score = psJson.lighthouseResult.categories.performance.score; // 0..1
    if (score >= 0.9) {
      speedStatus = 'good';
      speedDesc = 'Your site loads quickly on mobile.';
    } else if (score >= 0.5) {
      speedStatus = 'warning';
      speedDesc = 'Your site loads a bit slowly on mobile — some visitors may leave before it finishes.';
    } else {
      speedStatus = 'bad';
      speedDesc = 'Your site is slow to load on mobile, and slow sites lose visitors fast.';
    }
  } catch (e) {
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

  // --- Google Reviews: not automatically checked ----------------------
  const reviewsStatus = 'unknown';
  const reviewsDesc = "We can't verify Google reviews automatically from a domain alone — check your Google Business Profile directly.";

  // --- Business name (best-effort, from <title>) ----------------------
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  let businessName = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  businessName = businessName.split(/\s[|\-–·•—]\s/)[0].trim();
  if (!businessName) businessName = domain;
  if (businessName.length > 60) {
    businessName = businessName.slice(0, 60).replace(/\s+\S*$/, '') + '…';
  }

  // --- Overall score: average of the 5 measured categories -----------
  const measured = [hasWebsiteStatus, sslStatus, mobileStatus, speedStatus, socialStatus];
  const overallScore = Math.round(
    measured.reduce((sum, status) => sum + toneScore(status), 0) / measured.length
  );

  res.status(200).json({
    ok: true,
    businessName,
    town: domain,
    domain,
    preparedDate: 'just now',
    overallScore,
    hasWebsiteStatus,
    mobileStatus,
    speedStatus,
    reviewsStatus,
    sslStatus,
    socialStatus,
    descriptions: {
      hasWebsite: hasWebsiteDesc,
      mobile: mobileDesc,
      speed: speedDesc,
      reviews: reviewsDesc,
      ssl: sslDesc,
      social: socialDesc,
    },
  });
};
