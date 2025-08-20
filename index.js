/* ultra-simple auth'd proxy for your dashboard */
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 8080;
const TARGET = process.env.BASE_URL;
if (!TARGET) {
  console.error('Missing BASE_URL in .env');
  process.exit(1);
}

/* ----- CORS ----- */
const allowList = [
  "https://www.tradechartpatternslikethepros.com",
  "https://tradechartpatternslikethepros.com",
  "https://www-tradechartpatternslikethepros-com.filesusr.com" // Wix CDN
];

const corsOpts = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow curl / same-origin
    if (allowList.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-User-Id','X-User-Name'],
  credentials: true,   // <-- allow cookies/headers to pass
  maxAge: 86400,
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));

/* ----- Healthcheck ----- */
app.get('/health', (req, res) => {
  res.json({ ok: true, target: TARGET, ts: Date.now() });
});

/* ----- Proxy auth header ----- */
function attachAuth(proxyReq, req) {
  const token = process.env.API_TOKEN || '';
  if (token) proxyReq.setHeader('Authorization', 'Bearer ' + token);

  // forward identity if the client sends it
  const uid = req.header('X-User-Id') || req.header('x-user-id');
  const uname = req.header('X-User-Name') || req.header('x-user-name');
  if (uid) proxyReq.setHeader('X-User-Id', uid);
  if (uname) proxyReq.setHeader('X-User-Name', uname);

  proxyReq.setHeader('x-forwarded-host', req.headers.host || '');
}

/* ----- One proxy handles everything under /events and /ideas (incl. SSE) ----- */
const proxyCommon = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  ws: true,               // allow upgrade
  logLevel: 'warn',
  onProxyReq: attachAuth,
});

app.use('/events', proxyCommon);
app.use('/ideas', proxyCommon);          // GET /ideas, POST /ideas
app.use('/likes', proxyCommon);          // if your backend exposes /likes root
app.use('/uploads', proxyCommon);        // (optional) if you later add upload endpoint
app.use('/ideas/stream', proxyCommon);   // SSE stream path

/* catch-all */
app.use('/', (req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    return res.status(200).send('Ideas proxy is running.');
  }
  return proxyCommon(req, res, next);
});

app.listen(PORT, () => {
  console.log(`✅ Proxy up on http://localhost:${PORT} → ${TARGET}`);
});
