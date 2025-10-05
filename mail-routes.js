// mail-routes.js
const express = require('express');
const nodemailer = require('nodemailer');

const router = express.Router();

const {
  SMTP_URL,
  NOTIFY_FROM = 'Pro Members <no-reply@tradechartpatternslikethepros.com>',
  NOTIFY_TO = 'alerts@tradechartpatternslikethepros.com',         // fallback
  SUBSCRIBERS = '',                                               // comma-separated paid users
  MAIL_WEBHOOK_SECRET = '',                                       // optional shared secret
} = process.env;

if (!SMTP_URL) {
  console.warn('[mail] SMTP_URL not set — email routes will 500 until you set it.');
}

const x = (s) => (s || '').split(',').map(v => v.trim()).filter(Boolean);

// transport: works with your Mailjet SMTP_URL
const transporter = SMTP_URL ? nodemailer.createTransport(SMTP_URL) : null;

// optional auth guard (shared secret via header)
function checkSecret(req, res, next) {
  if (!MAIL_WEBHOOK_SECRET) return next(); // no secret required
  const got = req.get('x-mail-secret') || req.query.secret;
  if (got !== MAIL_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// util sender
async function sendMail({ to, cc, subject, html, text }) {
  if (!transporter) throw new Error('SMTP transport not configured');
  const mail = {
    from: NOTIFY_FROM,
    to: x(to).length ? x(to) : x(NOTIFY_TO),
    cc: x(cc),
    subject,
    text: text || (html ? html.replace(/<[^>]+>/g, ' ') : ''),
    html: html || text,
  };
  return transporter.sendMail(mail);
}

/* POST /api/notify-post
   Payload (from dashboard):
   {
     id, title, symbol, link, imageUrl, imageData,
     authorName, authorEmail, createdAt,
     audience: "paid",
     adminEmail: "tinomorgado@me.com",
     source: "dashboard",
     type: "post"
   }
*/
router.post('/api/notify-post', checkSecret, async (req, res) => {
  try {
    const p = req.body || {};
    const list = p.audience === 'paid' ? x(process.env.SUBSCRIBERS) : x(NOTIFY_TO);
    if (!list.length) return res.status(400).json({ error: 'No recipients (SUBSCRIBERS/NOTIFY_TO not set)' });

    const subject = `New post: ${p.title || '(untitled)'}${p.symbol ? ' — ' + p.symbol : ''}`;

    const linkRow = p.link ? `<p><strong>Link:</strong> <a href="${p.link}">${p.link}</a></p>` : '';
    const imgRow  = p.imageUrl ? `<p><img src="${p.imageUrl}" alt="chart" style="max-width:100%"/></p>` : '';
    const html = `
      <div style="font-family:ui-sans-serif,system-ui">
        <h2>${subject}</h2>
        <p>By <strong>${p.authorName || 'Member'}</strong> — ${new Date(p.createdAt || Date.now()).toLocaleString()}</p>
        <p>${(p.levelText || '').replace(/\\n/g,'<br>')}</p>
        ${linkRow}
        ${imgRow}
        <hr>
        <p><em>Sent from Pro Members Dashboard</em></p>
      </div>
    `;

    await sendMail({
      to: list.join(','),
      cc: x(p.adminEmail).join(','),
      subject,
      html
    });

    res.json({ ok: true, sentTo: list.length, subject });
  } catch (e) {
    console.error('[notify-post]', e);
    res.status(500).json({ error: 'mail failed' });
  }
});

/* POST /api/notify-signal
   Payload: { type: "live"|"tp"|"sl", title, symbol, link, ideaId, user:{id,name,email}, when }
*/
router.post('/api/notify-signal', checkSecret, async (req, res) => {
  try {
    const p = req.body || {};
    const list = p.audience === 'paid' ? x(process.env.SUBSCRIBERS) : x(NOTIFY_TO);
    if (!list.length) return res.status(400).json({ error: 'No recipients (SUBSCRIBERS/NOTIFY_TO not set)' });

    const TAG = (p.type || 'signal').toUpperCase();
    const subject = `[${TAG}] ${p.title || p.symbol || 'Update'}`;

    const html = `
      <div style="font-family:ui-sans-serif,system-ui">
        <h2>${subject}</h2>
        <p><strong>Symbol:</strong> ${p.symbol || '—'}</p>
        ${p.link ? `<p><strong>Link:</strong> <a href="${p.link}">${p.link}</a></p>` : ''}
        <p><strong>When:</strong> ${new Date(p.when || Date.now()).toLocaleString()}</p>
        ${p.user ? `<p><strong>Posted by:</strong> ${p.user.name || p.user.id} (${p.user.email || ''})</p>` : ''}
        <hr>
        <p><em>Sent from Pro Members Dashboard</em></p>
      </div>
    `;

    await sendMail({
      to: list.join(','),
      cc: x(p.adminEmail).join(','),
      subject,
      html
    });

    res.json({ ok: true, sentTo: list.length, subject });
  } catch (e) {
    console.error('[notify-signal]', e);
    res.status(500).json({ error: 'mail failed' });
  }
});

module.exports = router;
