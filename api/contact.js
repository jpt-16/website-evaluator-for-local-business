// Vercel serverless function: POST /api/contact
//
// The actual "email the lead to jptwohig16@gmail.com" delivery happens
// client-side (js/report.js posts straight to FormSubmit's AJAX endpoint
// from the browser) — FormSubmit ties a submission to a destination inbox
// by the request's Origin/Referer, which only a real browser request has.
// A server-to-server call from here has no Origin, so FormSubmit silently
// drops it.
//
// This endpoint exists purely as a non-blocking safety net: it logs every
// submission server-side (visible in Vercel's function logs) so a lead is
// never completely lost even if FormSubmit itself is slow/down/unreachable
// from the visitor's browser.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method not allowed.' });
    return;
  }

  let body;
  try {
    body = req.body && typeof req.body === 'object' ? req.body : await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ ok: false, message: "That didn't come through right — try again." });
    return;
  }

  // Honeypot: a hidden field real visitors never fill in. Pretend success
  // so bots don't learn anything from the response.
  if (body.company) {
    res.status(200).json({ ok: true });
    return;
  }

  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 200);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const message = String(body.message || '').trim().slice(0, 2000);
  const businessName = String(body.businessName || '').trim().slice(0, 120);
  const domain = String(body.domain || '').trim().slice(0, 200);
  const overallScore = Number.isFinite(body.overallScore) ? body.overallScore : null;

  if (!name || !EMAIL_RE.test(email)) {
    res.status(400).json({ ok: false, message: 'Please enter a valid name and email.' });
    return;
  }

  console.log('[contact] new lead:', JSON.stringify({
    name, email, phone, businessName, domain, overallScore, message,
    at: new Date().toISOString(),
  }));

  res.status(200).json({ ok: true });
};
