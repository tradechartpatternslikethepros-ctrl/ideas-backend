// server.patched.cjs
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// ───────────────────────────────────────────────────────────────────────────────
// Environment
// ───────────────────────────────────────────────────────────────────────────────
const {
  PORT = 8080,

  // Auth
  API_TOKEN,                 // for Authorization: Bearer <token>
  MAIL_SECRET,               // for X-Mail-Secret: <secret>

  // Mail
  MAIL_FROM = 'Pro Members <no-reply@example.com>',
  SMTP_URL,                  // e.g. smtp://USER:PASS@host:587
  NOTIFY_TO,                 // single fallback email
  SUBSCRIBERS,               // comma-separated list of recipients

  // CORS
  ALLOW_ORIGINS,             // CSV allowlist, supports patterns like *.wixsite.com
} = process.env;

const app = express();

// ───────────────────────────────────────────────────────────────────────────────
// CORS allowlist helpers
// ───────────────────────────────────────────────────────────────────────────────
function hostMatches(pattern, host) {
  if (!pattern || !host) return false;
  try { pattern = new URL(pattern).hostname; } catch {}
  pattern = pattern.toLowerCase().trim();
  host = host.toLowerCase().trim();
  if (!pattern.startsWith('*.')) return pattern === host;
  const suffix = pattern.slice(1); // ".domain.com"
  return host.endsWith(suffix);
}
function parseAllowlist(list) {
  return (list || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
const allowlist = parseAllowlist(
  ALLOW_ORIGINS ||
    [
      'https://www.tradechartpatternslikethepros.com',
      'https://tradechartpatternslikethepros.com',
      'https://editor.wix.com',
      'https://www.wix.com',
      '*.wixsite.com',
      '*.wixstatic.com',
      '*.parastorage.com',
      '*.filesusr.com',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ].join(',')
);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow server-to-server / curl
    let hostname;
    try { hostname = new URL(origin).hostname; }
    catch { return cb(new Error('Invalid Origin'), false); }
    const ok = allowlist.some(p => hostMatches(p, hostname));
    return cb(ok ? null : new Error('CORS blocked'), ok);
  },
  credentials: true,
  maxAge: 86400,
};

// ───────────────────────────────────────────────────────────────────────────────
// App middleware
// ───────────────────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(compression());
app.use(morgan('tiny'));

// Global rate limit (safe default; routes can add more)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ───────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ───────────────────────────────────────────────────────────────────────────────
function bearer(req) {
  const h = req.headers.authorization || '';
  const [, token] = h.split(' ');
  return token || null;
}

/** Require Authorization: Bearer <API_TOKEN> */
function requireAuth(req, res, next) {
  if (!API_TOKEN) return res.status(500).json({ error: 'API_TOKEN not set on server' });
  const token = bearer(req);
  if (!token || token !== API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/** Require X-Mail-Secret: <MAIL_SECRET> */
function requireMailSecret(req, res, next) {
  if (!MAIL_SECRET) return res.status(500).json({ error: 'MAIL_SECRET not set on server' });
  const key = req.headers['x-mail-secret'];
  if (!key || key !== MAIL_SECRET) return res.status(401).json({ error: 'invalid mail secret' });
  next();
}

/**
 * Allow EITHER Bearer token OR Mail secret.
 * Use this for email notify endpoints so the dashboard can choose.
 */
function requireEitherAuth(req, res, next) {
  const passBearer = API_TOKEN && bearer(req) === API_TOKEN;
  const passSecret = MAIL_SECRET && req.headers['x-mail-secret'] === MAIL_SECRET;
  if (passBearer || passSecret) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function parseRecipients() {
  const list =
    (SUBSCRIBERS && SUBSCRIBERS.split(',').map(s => s.trim()).filter(Boolean)) ||
    [];
  if (!list.length && NOTIFY_TO) list.push(NOTIFY_TO);
  return list;
}

// ───────────────────────────────────────────────────────────────────────────────
// Mailer
// ───────────────────────────────────────────────────────────────────────────────
let transporter = null;
if (SMTP_URL) {
  try {
    transporter = nodemailer.createTransport(SMTP_URL);
    console.log('Mail: SMTP configured');
  } catch (e) {
    console.error('Mail: failed to configure SMTP:', e.message);
  }
} else {
  console.log('Mail: SMTP_URL missing (emails will be logged to console)');
}

async function sendMail({ subject, html, text, to }) {
  const recipients = to && to.length ? to : parseRecipients();
  if (!recipients.length) {
    console.warn('Mail: no recipients; skipping');
    return { ok: true, skipped: true };
  }
  const mail = {
    from: MAIL_FROM,
    to: recipients.join(','),
    subject,
    text: text || html?.replace(/<[^>]+>/g, ' ').trim(),
    html: html || `<pre>${(text || '').trim()}</pre>`,
    headers: { 'List-Unsubscribe': '<mailto:no-reply@invalid>' },
  };
  if (transporter) {
    const info = await transporter.sendMail(mail);
    return { ok: true, sent: true, id: info.messageId };
  } else {
    console.log('[MAIL - DRYRUN]', mail);
    return { ok: true, logged: true };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Demo stores (swap to DB when ready)
// ───────────────────────────────────────────────────────────────────────────────
const ideas = [];
const events = []; // e.g. { id, title, when, status }

// ───────────────────────────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────────────────────────
app.get(['/', '/api'], (req, res) =>
  res.json({
    name: 'Ideas Backend',
    ok: true,
    docs: ['/health', '/api/health', '/ideas/latest', '/notify-post', '/notify-signal'],
  })
);

app.get(['/health', '/api/health', '/api/v1/health'], (req, res) =>
  res.json({ ok: true })
);

// Latest ideas (demo)
app.get(['/ideas/latest', '/api/ideas/latest'], (req, res) => {
  const list = ideas.slice(-15).reverse();
  res.json({ ok: true, ideas: list });
});

// Create idea (protected with Bearer)
app.post(['/ideas', '/api/ideas'], requireAuth, (req, res) => {
  const {
    title,
    symbol,
    link,
    levelText,
    authorName,
    authorEmail,
    audience = 'public',
    source = 'dashboard',
    type = 'post',
    image,
  } = req.body || {};
  const id = crypto.randomUUID();
  const when = new Date().toISOString();
  const idea = {
    id, title, symbol, link, levelText, authorName, authorEmail,
    audience, source, type, image, createdAt: when,
  };
  ideas.push(idea);
  res.json({ ok: true, idea });
});

// Events (demo)
app.get(['/events', '/api/events'], (req, res) => {
  res.json({ ok: true, events });
});

// ───────────────────────────────────────────────────────────────────────────────
// Email notify (POST + SIGNAL) — allows Bearer OR Mail Secret
// ───────────────────────────────────────────────────────────────────────────────
function sanitize(x, max = 5000) {
  return String(x ?? '').toString().slice(0, max);
}
function renderEmail(kind, p) {
  const subject =
    kind === 'post'
      ? `[TCPP] New Post — ${p.title}`
      : `[TCPP] ${String(kind).toUpperCase()} — ${p.title}`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial">
      <h2 style="margin:0 0 8px">${subject}</h2>
      <p><b>By:</b> ${sanitize(p.authorName || 'Member', 120)}${p.symbol ? ` · <b>Symbol:</b> ${sanitize(p.symbol, 40)}` : ''}</p>
      <p><b>When:</b> ${sanitize(p.createdAt || p.when || new Date().toISOString(), 64)} · <b>Audience:</b> ${sanitize(p.audience || 'paid', 20)}</p>
      ${p.link ? `<p><b>Link:</b> <a href="${sanitize(p.link, 2048)}">${sanitize(p.link, 2048)}</a></p>` : ''}
      ${p.imageUrl ? `<p><img alt="chart" src="${sanitize(p.imageUrl, 2048)}" style="max-width:640px;border:1px solid #eee;border-radius:8px"/></p>` : ''}
      ${p.levelText ? `<p><b>Levels:</b> ${sanitize(p.levelText, 2000)}</p>` : ''}
      <hr style="border:none;border-top:1px solid #ddd;margin:16px 0"/>
      <p style="color:#888;font-size:12px;margin:0">Trade Chart Patterns Like The Pros</p>
    </div>
  `;
  return { subject, html };
}

async function handleNotify(kind, req, res) {
  const body = req.body || {};
  const payload = {
    title: sanitize(body.title || '(no title)', 200),
    symbol: sanitize(body.symbol || '', 40),
    link: sanitize(body.link || '', 2048),
    levelText: sanitize(body.levelText || body.levels || '', 2000),
    authorName: sanitize(body.authorName || 'Member', 120),
    authorEmail: sanitize(body.authorEmail || '', 200),
    audience: sanitize(body.audience || 'paid', 20),
    source: sanitize(body.source || 'dashboard', 40),
    type: sanitize(body.type || kind, 20),
    imageUrl: sanitize(body.imageUrl || '', 2048),
    createdAt: sanitize(body.createdAt || body.when || new Date().toISOString(), 64),
  };

  // Also append to in-memory ideas (nice for testing)
  const id = crypto.randomUUID();
  ideas.push({
    id,
    ...payload,
    createdAt: new Date().toISOString(),
  });

  const { subject, html } = renderEmail(kind, payload);

  try {
    const result = await sendMail({ subject, html, to: parseRecipients() });
    return res.json({ ok: true, kind, id, mail: result });
  } catch (e) {
    console.error(`notify-${kind} mail error:`, e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// New post emails
app.post(['/notify-post', '/api/notify-post'], requireEitherAuth, handleNotify.bind(null, 'post'));

// Signal emails (LIVE/TP/SL/etc.) — send kind via `type` in body (defaults to 'signal')
app.post(['/notify-signal', '/api/notify-signal'], requireEitherAuth, (req, res) => {
  const kind = sanitize(req.body?.type || 'signal', 16).toLowerCase(); // 'live' | 'tp' | 'sl' | 'signal'
  return handleNotify(kind, req, res);
});

// ───────────────────────────────────────────────────────────────────────────────
// Fallback 404
// ───────────────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

// ───────────────────────────────────────────────────────────────────────────────
// Boot
// ───────────────────────────────────────────────────────────────────────────────
function listRoutes(app) {
  const routes = [];
  app._router?.stack?.forEach(m => {
    if (m.route?.path) {
      routes.push(`${Object.keys(m.route.methods).join(',').toUpperCase()} ${m.route.path}`);
    } else if (m.name === 'router' && m.handle?.stack) {
      m.handle.stack.forEach(h => {
        if (h.route?.path) {
          routes.push(`${Object.keys(h.route.methods).join(',').toUpperCase()} ${h.route.path}`);
        }
      });
    }
  });
  console.log('ROUTES:\n' + routes.sort().join('\n'));
}

app.listen(PORT, () => {
  console.log(`Ideas backend running on :${PORT}`);
  console.log('CORS allowlist:', allowlist.join(' | '));
  console.log(SMTP_URL ? 'Mail: SMTP configured' : 'Mail: SMTP_URL missing (emails will be logged to console)');
  if (!API_TOKEN)   console.warn('WARN: API_TOKEN not set — Bearer auth disabled.');
  if (!MAIL_SECRET) console.warn('WARN: MAIL_SECRET not set — X-Mail-Secret disabled.');
  listRoutes(app);
});
