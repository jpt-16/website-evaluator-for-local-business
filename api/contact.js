// Vercel serverless function: POST /api/contact
//
// Sends a lead's "get a free mockup" request via Resend (resend.com —
// simple REST API, generous free tier). Every submission is also logged
// server-side first, so nothing is lost if RESEND_API_KEY/CONTACT_TO_EMAIL
// aren't configured yet — check Vercel's function logs as a fallback.
//
// No dependencies: uses the global fetch available in the Node 18+
// runtime Vercel deploys by default.

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

  // Always logged first — this is the safety net if email sending below
  // fails or isn't configured yet.
  console.log('[contact] new lead:', JSON.stringify({
    name, email, phone, businessName, domain, overallScore, message,
    at: new Date().toISOString(),
  }));

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL;

  if (apiKey && to) {
    try {
      const subject = 'New mockup request' + (businessName ? ' — ' + businessName : '');
      const lines = [
        'Name: ' + name,
        'Email: ' + email,
        phone ? 'Phone: ' + phone : null,
        businessName ? 'Business: ' + businessName : null,
        domain ? 'Site checked: ' + domain : null,
        overallScore != null ? 'Score: ' + overallScore + '/100' : null,
        '',
        message ? 'Message:\n' + message : '(no message)',
      ].filter((line) => line !== null).join('\n');

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.CONTACT_FROM_EMAIL || 'Website Health Report <onboarding@resend.dev>',
          to: [to],
          reply_to: email,
          subject,
          text: lines,
        }),
      });
      if (!emailRes.ok) {
        console.error('[contact] Resend error', emailRes.status, await emailRes.text());
      }
    } catch (e) {
      console.error('[contact] failed to send email', e);
    }
  } else {
    console.warn('[contact] RESEND_API_KEY / CONTACT_TO_EMAIL not set — lead was only logged, not emailed.');
  }

  res.status(200).json({ ok: true });
};
