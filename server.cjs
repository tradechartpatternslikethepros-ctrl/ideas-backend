// server.cjs  — full production server (CJS) for Railway or local
// Features:
//  - Ideas CRUD-lite: list, latest, create, like, comment
//  - Email notify routes (post + signal) with header secret
//  - SSE /events stream for live pings
//  - CORS allowlist with wildcards
//  - File persistence (ideas.db JSON) + optional base64 image save
//  - Works for both "/..." and "/api/..." paths
//  - Ready for Railway (PORT env), logs routes at boot

// -------------------- imports --------------------
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

// -------------------- config --------------------
const env = (k, d) => (process.env[k] && String(process.env[k]).trim()) || d;

const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = env('DATA_FILE', path.join(process.cwd(), 'ideas.db'));
const UPLOAD_DIR = env('UPLOAD_DIR', path.join(process.cwd(), 'uploads'));
const API_TOKEN = env(
  'API_TOKEN',
  // fallback to your provided token so it just works if not set in Railway
  '4a6ffbf3209fb1392341615d5b6abc6f4db5998a22d825f2615dfd22e3965dfa'
);
const MAIL_SECRET = env('MAIL_SECRET', 'superlongrandomstring');
const SMTP_URL = env(
  'SMTP_URL',
  'smtp://559c7d76b88bbc4988c014de3630f96c:8ef6a407c50354ec9101604ad9899aad@in-v3.mailjet.com:587'
);
const MAIL_FROM = env(
  'MAIL_FROM',
  'Pro Members <no-reply@tradechartpatternslikethepros.com>'
);
const NOTIFY_TO = env(
  'NOTIFY_TO',
  'alerts@tradechartpatternslikethepros.com'
);
const SUBSCRIBERS = env(
  'SUBSCRIBERS',
  'alerts@tradechartpatternslikethepros.com,tinomorgado@me.com'
);

// comma-separated; supports wildcards like *.wixsite.com
const ALLOW_ORIGINS = env(
  'ALLOW_ORIGINS',
  [
    'https://www.tradechartpatternslikethepros.com',
    'https://tradechartpatternslikethepros.com',
    '*.filesusr.com',
    '*.wixsite.com',
    '*.wixstatic.com',
    '*.parastorage.com',
    'https://editor.wix.com',
    'https://www.wix.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ].join(',')
);

// -------------------- app --------------------
const app = express();
app.set('trust proxy', 1); // behind Railway/Cloudflare

// body parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// uploads (for saved base64 images)
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', etag: true }));

// CORS allowlist (wildcards)
const originGlobs = ALLOW_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
const globToRegex = glob => {
  if (glob === '*') return /^.*$/i;
  let g = glob.replace(/\./g, '\\.').replace(/\*/g, '.*');
  if (!/^https?:\/\//.test(g)) g = 'https?:\\/\\/' + g;
  return new RegExp('^' + g + '$', 'i');
};
const allowlist = originGlobs.map(globToRegex);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl, server-to-server
      const ok = allowlist.some(rx => rx.test(origin));
      return cb(ok ? null : new Error('Not allowed by CORS'), ok);
    },
    credentials: false
  })
);

// basic rate limit (per IP via trust proxy)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// -------------------- persistence --------------------
const state = {
  ideas: []
};

async function load() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const json = JSON.parse(raw);
    if (Array.isArray(json)) state.ideas = json;
    else if (Array.isArray(json.ideas)) state.ideas = json.ideas;
  } catch (_) {
    state.ideas = [];
    await persist();
  }
}

let persistWrite = Promise.resolve();
async function persist() {
  const snapshot = JSON.stringify(state.ideas, null, 2);
  // serialize writes
  persistWrite = persistWrite.then(() =>
    fsp.writeFile(DATA_FILE, snapshot, 'utf8').catch(() => {})
  );
  return persistWrite;
}

// -------------------- utils --------------------
const uuid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

function sanitizeIdea(idea) {
  // expose everything except potential internal fields
  const {
    id,
    title,
    content,
    symbol,
    tf,
    likes = 0,
    comments = [],
    imageUrl,
    createdAt,
    updatedAt
  } = idea;
  return {
    id,
    title,
    content,
    symbol,
    tf,
    likes,
    comments,
    imageUrl,
    createdAt,
    updatedAt
  };
}

async function saveBase64ImageMaybe(b64) {
  try {
    if (!b64 || typeof b64 !== 'string') return null;
    const m = b64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return null;
    const ext = m[1].split('/')[1].toLowerCase().replace('+xml', '');
    const buf = Buffer.from(m[2], 'base64');
    const name = uuid() + '.' + (ext || 'png');
    const filePath = path.join(UPLOAD_DIR, name);
    await fsp.writeFile(filePath, buf);
    return `/uploads/${name}`;
  } catch {
    return null;
  }
}

// helper to mount both /x and /api/x
const dual = (method, p, h) => {
  app[method](p, h);
  app[method]('/api' + p, h);
};

// -------------------- email --------------------
let transporter = null;
if (SMTP_URL) {
  try {
    transporter = nodemailer.createTransport(SMTP_URL);
    // probe connection on boot (non-blocking)
    transporter
      .verify()
      .then(() => console.log('Mail: SMTP configured'))
      .catch(err => console.log('Mail: SMTP verify failed', err?.message || err));
  } catch (e) {
    console.log('Mail: transporter init failed', e?.message || e);
  }
}

async function sendEmail({ subject, text, html, to }) {
  if (!transporter) throw new Error('SMTP not configured');
  const opts = {
    from: MAIL_FROM,
    to: to || SUBSCRIBERS,
    subject,
    text: text || html?.replace(/<[^>]+>/g, ' '),
    html
  };
  return transporter.sendMail(opts);
}

// -------------------- routes --------------------
dual('get', '/', (_req, res) => {
  res.json({
    name: 'ideas-backend',
    version: 1,
    routes: [
      'GET /, /api',
      'GET /health, /api/health, /api/v1/health',
      'GET /events, /api/events (SSE)',
      'GET /ideas, /api/ideas',
      'GET /ideas/latest, /api/ideas/latest',
      'POST /ideas, /api/ideas  (x-api-token)',
      'PUT /ideas/:id/likes, /api/ideas/:id/likes',
      'POST /ideas/:id/comments, /api/ideas/:id/comments',
      'POST /notify-post, /api/notify-post  (x-mail-secret)',
      'POST /notify-signal, /api/notify-signal (x-mail-secret)'
    ]
  });
});
dual('get', '/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/v1/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- SSE heartbeat for clients that want "live" feel ----
const sseClients = new Set();
dual('get', '/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders?.();
  res.write('retry: 15000\n\n');

  const client = { res };
  sseClients.add(client);
  req.on('close', () => sseClients.delete(client));
});
function sseBroadcast(evt, data) {
  const payload = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res } of sseClients) res.write(payload);
}
setInterval(() => sseBroadcast('ping', { t: Date.now() }), 30000);

// ---- ideas list ----
dual('get', '/ideas', (_req, res) => {
  res.json(state.ideas.map(sanitizeIdea));
});

// ---- latest (single) ----
dual('get', '/ideas/latest', (_req, res) => {
  const latest = state.ideas[0] ? sanitizeIdea(state.ideas[0]) : null;
  res.json(latest);
});

// ---- create idea (requires x-api-token) ----
dual('post', '/ideas', async (req, res) => {
  try {
    const token = req.get('x-api-token');
    if (token !== API_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    const { title, content, symbol, tf, imageBase64 } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });

    let imageUrl = null;
    if (imageBase64) imageUrl = await saveBase64ImageMaybe(imageBase64);

    const idea = {
      id: uuid(),
      title: String(title).slice(0, 180),
      content: String(content).slice(0, 10000),
      symbol: symbol ? String(symbol).slice(0, 24) : undefined,
      tf: tf ? String(tf).slice(0, 16) : undefined,
      imageUrl: imageUrl || undefined,
      likes: 0,
      comments: [],
      createdAt: nowISO(),
      updatedAt: nowISO()
    };

    state.ideas.unshift(idea);
    await persist();
    sseBroadcast('new_idea', sanitizeIdea(idea));

    res.status(201).json(sanitizeIdea(idea));
  } catch (e) {
    res.status(500).json({ error: 'server', detail: e?.message || String(e) });
  }
});

// ---- like / unlike ----
dual('put', '/ideas/:id/likes', async (req, res) => {
  const { id } = req.params;
  const { delta } = req.body || {};
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return res.status(400).json({ error: 'delta must be a number' });
  }
  const idea = state.ideas.find(i => i.id === id);
  if (!idea) return res.status(404).json({ error: 'idea not found' });
  idea.likes = Math.max(0, (idea.likes || 0) + Math.trunc(delta));
  idea.updatedAt = nowISO();
  await persist();
  sseBroadcast('likes', { id: idea.id, likes: idea.likes });
  res.json(sanitizeIdea(idea));
});

// ---- add comment ----
dual('post', '/ideas/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { author, text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }
  const idea = state.ideas.find(i => i.id === id);
  if (!idea) return res.status(404).json({ error: 'idea not found' });

  const comment = {
    id: uuid(),
    author: (author && String(author).slice(0, 60)) || 'Anon',
    text: String(text).slice(0, 2000),
    createdAt: nowISO()
  };
  idea.comments = Array.isArray(idea.comments) ? idea.comments : [];
  idea.comments.unshift(comment);
  idea.updatedAt = comment.createdAt;
  await persist();
  sseBroadcast('comment', { ideaId: idea.id, comment });
  res.status(201).json(comment);
});

// ---- email notify (post created) ----
dual('post', '/notify-post', async (req, res) => {
  try {
    if (req.get('x-mail-secret') !== MAIL_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { title, url } = req.body || {};
    const subject = `New Post: ${title || 'Update'}`;
    const html = `<p><strong>${title || 'New Post'}</strong></p><p><a href="${url ||
      '#'}" target="_blank" rel="noopener">Open Dashboard</a></p>`;
    await sendEmail({ subject, html, to: NOTIFY_TO });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'mail_failed', detail: e?.message || String(e) });
  }
});

// ---- email notify (signal live/tp/sl) ----
dual('post', '/notify-signal', async (req, res) => {
  try {
    if (req.get('x-mail-secret') !== MAIL_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { symbol, tf, status, price, note, url } = req.body || {};
    const title = `Signal ${status || ''} — ${symbol || ''} ${tf || ''}`.trim();
    const html =
      `<p><strong>${title}</strong></p>` +
      (price ? `<p>Price: ${price}</p>` : '') +
      (note ? `<p>${String(note).slice(0, 500)}</p>` : '') +
      `<p><a href="${url || '#'}" target="_blank" rel="noopener">Open Dashboard</a></p>`;
    await sendEmail({ subject: title, html, to: SUBSCRIBERS });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'mail_failed', detail: e?.message || String(e) });
  }
});

// -------------------- boot --------------------
(async () => {
  await load();
  app.listen(PORT, () => {
    console.log(`Ideas backend running on :${PORT}`);
    console.log(
      'CORS allowlist:',
      originGlobs.join(' | ')
    );
    console.log('Mail:', transporter ? 'SMTP configured' : 'SMTP disabled');

    // log routes
    console.log('ROUTES:');
    const list = [];
    for (const layer of app._router.stack) {
      if (layer.route) {
        const p = layer.route.path;
        const methods = Object.keys(layer.route.methods)
          .filter(Boolean)
          .map(m => m.toUpperCase())
          .join(',');
        list.push(`${methods} ${p}`);
      }
    }
    // also show /api mirrors (dual)
    list.push('GET /api, GET /api/health, GET /api/v1/health, GET /api/events');
    list.push('GET /api/ideas, GET /api/ideas/latest');
    list.push('POST /api/ideas, PUT /api/ideas/:id/likes, POST /api/ideas/:id/comments');
    list.push('POST /api/notify-post, POST /api/notify-signal');
    for (const r of list) console.log(r);
  });
})();
