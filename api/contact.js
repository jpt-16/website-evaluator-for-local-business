// Vercel serverless function: POST /api/contact
//
// Sends a lead's "get a free mockup" request via FormSubmit
// (formsubmit.co — free, no account/API key needed, just emails whatever
// you POST it to the target address). Every submission is also logged
// server-side first, so nothing is lost even if FormSubmit is slow/down —
// check Vercel's function logs as a fallback.
//
// No dependencies: uses the global fetch available in the Node 18+
// runtime Vercel deploys by default.
//
// One-time setup: the FIRST submission FormSubmit receives for a given
// target email sends that inbox a confirmation link that has to be
// clicked before any further emails go through. That's a FormSubmit
// anti-spam requirement, not something this code can skip.

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

  const to = process.env.CONTACT_TO_EMAIL || 'jptwohig16@gmail.com';

  try {
    const subject = 'New mockup request' + (businessName ? ' — ' + businessName : '');

    const formSubmitRes = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(to), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        _subject: subject,
        _template: 'table',
        _captcha: 'false',
        _replyto: email,
        Name: name,
        Email: email,
        Phone: phone || '(not provided)',
        Business: businessName || '(not provided)',
        'Site checked': domain || '(not provided)',
        Score: overallScore != null ? overallScore + '/100' : '(not available)',
        Message: message || '(no message)',
      }),
    });
    if (!formSubmitRes.ok) {
      console.error('[contact] FormSubmit error', formSubmitRes.status, await formSubmitRes.text());
    }
  } catch (e) {
    console.error('[contact] failed to send email via FormSubmit', e);
  }

  res.status(200).json({ ok: true });
};
