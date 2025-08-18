/* ideas-backend — Express server (CommonJS)
 * Features:
 * - CORS with ALLOW_ORIGINS="*" or CSV list
 * - Auth for write ops via API_TOKEN (Bearer)
 * - PUBLIC_LIKES=true lets anyone like/unlike (only likes bypass auth)
 * - Ideas CRUD + latest
 * - Comments (list/add/edit/delete)
 * - Likes (many routes + single-wire op) to match the frontend's discovery
 * - Image upload (in-memory) + GET /images/:id
 * - Legacy-style uploads (/upload, /uploads, GET /uploads/:name)
 * - SSE realtime on /ideas/stream (and /events/stream stub)
 * - Events JSON (/events, /events/list) stub
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // honor X-Forwarded-For on Railway/NGINX/etc.

/* ======================= Utils & Env ======================= */
function cleanEnv(v, fallback = '') {
  if (v == null) return fallback;
  const s = String(v).trim();
  // strip wrapping quotes if user pasted them
  return s.replace(/^['"]+|['"]+$/g, '');
}
function boolEnv(v, def = false) {
  const s = cleanEnv(v, '').toLowerCase();
  if (!s) return def;
  return ['1', 'true', 'yes', 'on'].includes(s);
}
function sha1(s) {
  try { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
  catch { return String(s); }
}

const PORT = Number(cleanEnv(process.env.PORT || 8080));
const API_TOKEN = cleanEnv(process.env.API_TOKEN); // if set, required for writes
const PUBLIC_LIKES = boolEnv(process.env.PUBLIC_LIKES, false);
const BASE_URL = cleanEnv(process.env.BASE_URL, '');
const ALLOW_ORIGINS = (cleanEnv(process.env.ALLOW_ORIGINS, '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean));

const allowAll = ALLOW_ORIGINS.includes('*');
const allowSet = new Set(ALLOW_ORIGINS);

/* ======================= Middleware ======================= */
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl / same-origin
    if (allowAll || allowSet.has(origin)) return cb(null, true);
    return cb(new Error('CORS: Origin not allowed'), false);
  },
  credentials: false,
  methods: ['GET','POST','PATCH','DELETE','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' })); // base64 images can be big
app.use(express.urlencoded({ extended: false }));

/* ======================= Helpers ======================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const nowISO = () => new Date().toISOString();
const genId = (p='id_') => p + Math.random().toString(36).slice(2,8) + Date.now().toString(36);

function publicBase(req) {
  const envBase = BASE_URL && BASE_URL.replace(/\/+$/,'');
  if (envBase) return envBase;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

const isWrite = (req) => /^(POST|PUT|PATCH|DELETE)$/i.test(req.method);

// Detect “like” routes so we can optionally bypass auth when PUBLIC_LIKES=true
function isLikeWrite(req){
  const p = (req.path || '').toLowerCase();

  // Single-wire like op on POST /ideas
  if (req.method === 'POST' && p === '/ideas' && req.body && req.body.op === 'like_toggle') return true;

  // Top-level likes
  if (req.method === 'POST' && /^\/likes(\/toggle)?$/.test(p)) return true;
  if (req.method === 'DELETE' && /^\/likes$/.test(p)) return true;

  // Flat /ideas likes (no id)
  if (/^\/ideas\/(like|likes)(\/toggle)?$/.test(p)) return true;

  // Nested under idea id
  if (/^\/ideas\/[^/]+\/(like|likes)(\/toggle)?$/.test(p)) return true;

  // PUT delta route /ideas/:id/likes
  if (req.method === 'PUT' && /^\/ideas\/[^/]+\/likes$/.test(p)) return true;

  return false;
}

function isAuthed(req) {
  if (!API_TOKEN) return true; // no auth required if unset
  const hdr = req.headers.authorization || '';
  const raw = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const token = cleanEnv(raw);
  return token === API_TOKEN;
}

function requireAuth(req, res, next){
  if (!isWrite(req)) return next();
  if (PUBLIC_LIKES && isLikeWrite(req)) return next(); // likes are public
  if (!isAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use(requireAuth);

// Identify the "who" of a like
function tokenKey(req){
  // If fully authed, group them under a privileged key
  if (isAuthed(req) && API_TOKEN) return 'owner';

  // If public likes allowed, derive a soft fingerprint
  if (PUBLIC_LIKES) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    return 'pub_' + sha1(ip + '|' + ua).slice(0, 12);
  }

  // Fallback
  return 'anon';
}

/* ======================= In-memory stores ======================= */
// ideas: {id, title, symbol, levelText, take, imageUrl, imageData, type, createdAt, updatedAt, likeCount, commentCount}
let ideas = [];
// likesBy[ideaId] = { [whoKey]: true/false }
const likesBy = Object.create(null);
// commentsBy[ideaId] = [ {id, userId, text, createdAt} ]
const commentsBy = Object.create(null);

// images map (in-memory) for /images/:id
const images = new Map();

// legacy-style uploads (/uploads/:name)
const uploads = new Map();

/* ======================= SSE ======================= */
const sseClients = new Set();   // idea updates
const evtClients = new Set();   // events stream
const HEARTBEAT_MS = 25000;

function sseHeaders(res){
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
}
function sseSend(res, data){
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function broadcastIdeas(msg){
  for (const client of sseClients) { try { sseSend(client, msg); } catch {} }
}
function broadcastEvents(msg){
  for (const client of evtClients) { try { sseSend(client, msg); } catch {} }
}
setInterval(() => {
  for (const c of sseClients) { try { sseSend(c, { type: 'ping', ts: Date.now() }); } catch {} }
  for (const c of evtClients) { try { sseSend(c, { type: 'ping', ts: Date.now() }); } catch {} }
}, HEARTBEAT_MS);

app.get('/ideas/stream', (req, res) => {
  sseHeaders(res);
  sseClients.add(res);
  sseSend(res, { type: 'hello', ts: Date.now() });
  req.on('close', () => { sseClients.delete(res); try { res.end(); } catch {} });
});
app.get('/events/stream', (req, res) => {
  sseHeaders(res);
  evtClients.add(res);
  sseSend(res, { type: 'hello', ts: Date.now() });
  req.on('close', () => { evtClients.delete(res); try { res.end(); } catch {} });
});

/* ======================= Images & Uploads ======================= */
// New-style in-memory image API
app.post('/images/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const id = genId('img_');
  images.set(id, { mime: req.file.mimetype || 'application/octet-stream', buf: req.file.buffer, ts: Date.now() });
  const url = `${publicBase(req)}/images/${id}`;
  res.json({ url });
});
app.get('/images/:id', (req, res) => {
  const img = images.get(req.params.id);
  if (!img) return res.status(404).end();
  res.setHeader('Content-Type', img.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(img.buf);
});

// Legacy /upload & /uploads support (for existing URLs like /uploads/abc.png)
app.post(['/upload', '/uploads'], upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const name = genId('').replace(/^id_/, '') + guessExt(req.file.mimetype);
  uploads.set(name, { mime: req.file.mimetype || 'application/octet-stream', buf: req.file.buffer, ts: Date.now() });
  const url = `${publicBase(req)}/uploads/${name}`;
  res.json({ url });
});
app.get('/uploads/:name', (req, res) => {
  const rec = uploads.get(req.params.name);
  if (!rec) return res.status(404).end();
  res.setHeader('Content-Type', rec.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rec.buf);
});
function guessExt(mime){
  if (/png/i.test(mime)) return '.png';
  if (/jpe?g/i.test(mime)) return '.jpg';
  if (/gif/i.test(mime)) return '.gif';
  if (/webp/i.test(mime)) return '.webp';
  return '';
}

/* ======================= Ideas core ======================= */
function getIdea(id){ return ideas.find(x => String(x.id) === String(id)); }
function saveIdea(obj){
  const now = nowISO();
  if (!obj.id) {
    obj.id = genId('idea_');
    obj.createdAt = obj.createdAt || now;
    obj.updatedAt = now;
    obj.likeCount = obj.likeCount || 0;
    obj.commentCount = obj.commentCount || 0;
    ideas.push(obj);
  } else {
    obj.updatedAt = now;
    const i = ideas.findIndex(x => x.id === obj.id);
    if (i >= 0) ideas[i] = obj; else ideas.push(obj);
  }
  return obj;
}
function deleteIdea(id){
  const i = ideas.findIndex(x => String(x.id) === String(id));
  if (i >= 0) ideas.splice(i,1);
}

/* ======================= Likes helpers ======================= */
function recalcLikeCount(ideaId){
  const map = likesBy[ideaId] || {};
  const count = Object.values(map).filter(Boolean).length;
  const it = getIdea(ideaId);
  if (it) it.likeCount = count;
  return count;
}
function setLike(ideaId, who, value){
  if (!likesBy[ideaId]) likesBy[ideaId] = {};
  likesBy[ideaId][who] = !!value;
  return recalcLikeCount(ideaId);
}
function toggleLikeState(ideaId, who){
  const cur = (likesBy[ideaId] && likesBy[ideaId][who]) || false;
  return setLike(ideaId, who, !cur);
}

/* ======================= Comments helpers ======================= */
function listComments(ideaId){ return (commentsBy[ideaId] || []); }
function addComment(ideaId, text, userId='User'){
  const cm = { id: genId('cm_'), userId, text: String(text||''), createdAt: nowISO() };
  if (!commentsBy[ideaId]) commentsBy[ideaId] = [];
  commentsBy[ideaId].push(cm);
  const it = getIdea(ideaId); if (it) it.commentCount = listComments(ideaId).length;
  return cm;
}
function editComment(ideaId, commentId, text){
  const arr = commentsBy[ideaId] || [];
  const i = arr.findIndex(c => String(c.id) === String(commentId));
  if (i < 0) return false;
  arr[i].text = String(text || '');
  return true;
}
function deleteCommentById(ideaId, commentId){
  const arr = commentsBy[ideaId] || [];
  const i = arr.findIndex(c => String(c.id) === String(commentId));
  if (i < 0) return false;
  arr.splice(i,1);
  const it = getIdea(ideaId); if (it) it.commentCount = arr.length;
  return true;
}

/* ======================= REST: Ideas ======================= */
app.get('/ideas', (req, res) => res.json(ideas));

app.get('/ideas/latest', (req, res) => {
  if (!ideas.length) return res.status(204).end();
  const latest = [...ideas].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  res.json(latest);
});

app.get('/ideas/:id', (req, res) => {
  const it = getIdea(req.params.id);
  if (!it) return res.status(404).json({ error: 'Not found' });
  res.json(it);
});

app.post('/ideas', (req, res) => {
  // Single-wire OPs can arrive here too
  const body = req.body || {};
  const op = (body.op || '').toString();

  if (op) {
    try {
      switch (op) {
        case 'like_toggle': {
          const id = String(body.id || '');
          if (!getIdea(id)) return res.status(404).json({ error: 'Idea not found' });
          const who = tokenKey(req);
          const like = (typeof body.like === 'boolean') ? body.like : null;
          const count = (like === null) ? toggleLikeState(id, who) : setLike(id, who, !!like);
          const liked = !!(likesBy[id] && likesBy[id][who]);
          broadcastIdeas({ type: 'like', id, likeCount: count, liked });
          return res.json({ ok: true, id, likeCount: count, likesCount: count, liked });
        }
        case 'comment_list': {
          const id = String(body.id || '');
          return res.json(listComments(id));
        }
        case 'comment_add': {
          const id = String(body.id || '');
          if (!getIdea(id)) return res.status(404).json({ error: 'Idea not found' });
          const cm = addComment(id, body.text || '', 'You');
          broadcastIdeas({ type: 'comment_new', id, comment: cm });
          return res.json(listComments(id));
        }
        case 'comment_edit': {
          const { id, commentId, text } = body;
          if (!editComment(String(id), String(commentId), text || '')) return res.status(404).json({ error: 'Comment not found' });
          broadcastIdeas({ type: 'comment_edit', id, commentId });
          return res.json(listComments(String(id)));
        }
        case 'comment_delete': {
          const { id, commentId } = body;
          if (!deleteCommentById(String(id), String(commentId))) return res.status(404).json({ error: 'Comment not found' });
          broadcastIdeas({ type: 'comment_delete', id, commentId });
          return res.json(listComments(String(id)));
        }
        case 'post_edit': {
          const { id, patch } = body;
          const it = getIdea(String(id));
          if (!it) return res.status(404).json({ error: 'Not found' });
          const next = { ...it, ...patch, id: it.id, updatedAt: nowISO() };
          saveIdea(next);
          broadcastIdeas({ type: 'idea_update', id: it.id });
          return res.json({ ok: true, id: it.id });
        }
        case 'post_delete': {
          const { id } = body;
          if (!getIdea(String(id))) return res.status(404).json({ error: 'Not found' });
          deleteIdea(String(id));
          broadcastIdeas({ type: 'post_delete', id: String(id) });
          return res.json({ ok: true });
        }
        default:
          // continue to create
      }
    } catch (e) {
      return res.status(400).json({ error: 'Bad op', detail: String(e.message || e) });
    }
  }

  // Create idea/post
  const {
    title = '',
    symbol = '',
    levelText = '',
    take = '',
    type = 'idea',
    imageUrl = '',
    imageData = '',
    summary = ''
  } = body;

  const it = saveIdea({
    id: undefined,
    title: String(title),
    symbol: String(symbol),
    levelText: String(levelText),
    take: String(take),
    type: String(type || 'idea'),
    imageUrl: imageUrl === null ? null : String(imageUrl || ''),
    imageData: String(imageData || ''),
    summary: String(summary || levelText || ''),
    createdAt: nowISO()
  });

  broadcastIdeas({ type: 'idea_new', id: it.id, title: it.title });
  res.status(201).json(it);
});

app.patch('/ideas/:id', (req, res) => {
  const it = getIdea(req.params.id);
  if (!it) return res.status(404).json({ error: 'Not found' });
  const { title, symbol, levelText, take, imageUrl, imageData, type, summary } = req.body || {};
  const next = {
    ...it,
    ...(title !== undefined ? { title: String(title) } : {}),
    ...(symbol !== undefined ? { symbol: String(symbol) } : {}),
    ...(levelText !== undefined ? { levelText: String(levelText) } : {}),
    ...(summary !== undefined ? { summary: String(summary) } : {}),
    ...(take !== undefined ? { take: String(take) } : {}),
    ...(type !== undefined ? { type: String(type) } : {}),
    ...(imageUrl !== undefined ? { imageUrl: imageUrl === null ? null : String(imageUrl) } : {}),
    ...(imageData !== undefined ? { imageData: String(imageData) } : {}),
    updatedAt: nowISO()
  };
  saveIdea(next);
  broadcastIdeas({ type: 'idea_update', id: next.id });
  res.json(next);
});

app.delete('/ideas/:id', (req, res) => {
  const id = String(req.params.id);
  if (!getIdea(id)) return res.status(404).json({ error: 'Not found' });
  deleteIdea(id);
  broadcastIdeas({ type: 'post_delete', id });
  res.status(204).end();
});

/* ======================= REST: Comments ======================= */
app.get('/ideas/:id/comments', (req, res) => { const items = listComments(String(req.params.id)); res.json({ items }); });
app.post('/ideas/:id/comments', (req, res) => {
  const id = String(req.params.id);
  if (!getIdea(id)) return res.status(404).json({ error: 'Idea not found' });
  const { text = '' } = req.body || {};
  const cm = addComment(id, text, 'You');
  broadcastIdeas({ type: 'comment_new', id, comment: cm });
  res.status(201).json(cm);
});
app.patch('/ideas/:id/comments/:cid', (req, res) => {
  const { id, cid } = req.params;
  if (!editComment(String(id), String(cid), (req.body && req.body.text) || '')) {
    return res.status(404).json({ error: 'Comment not found' });
  }
  broadcastIdeas({ type: 'comment_edit', id, commentId: cid });
  res.json({ ok: true });
});
app.delete('/ideas/:id/comments/:cid', (req, res) => {
  const { id, cid } = req.params;
  if (!deleteCommentById(String(id), String(cid))) {
    return res.status(404).json({ error: 'Comment not found' });
  }
  broadcastIdeas({ type: 'comment_delete', id, commentId: cid });
  res.status(204).end();
});

/* ======================= REST: Likes (multiple shapes) ======================= */
// Top-level (body carries { id, like? })
app.post('/likes',        (req, res) => likeSetFromBody(req, res, true));
app.delete('/likes',      (req, res) => likeSetFromBody(req, res, false));
app.post('/likes/toggle', (req, res) => likeToggleFromBody(req, res));

// Flat under /ideas (with id in body)
app.post('/ideas/like',          (req, res) => likeSetFromBody(req, res, true));
app.post('/ideas/likes',         (req, res) => likeSetFromBody(req, res, true));
app.delete('/ideas/like',        (req, res) => likeSetFromBody(req, res, false));
app.delete('/ideas/likes',       (req, res) => likeSetFromBody(req, res, false));
app.post('/ideas/like/toggle',   (req, res) => likeToggleFromBody(req, res));
app.post('/ideas/likes/toggle',  (req, res) => likeToggleFromBody(req, res));

// Nested under idea id
app.post('/ideas/:id/like',         (req, res) => likeSet(req, res, true));
app.post('/ideas/:id/likes',        (req, res) => likeSet(req, res, true));
app.delete('/ideas/:id/like',       (req, res) => likeSet(req, res, false));
app.delete('/ideas/:id/likes',      (req, res) => likeSet(req, res, false));
app.post('/ideas/:id/like/toggle',  (req, res) => likeToggle(req, res));
app.post('/ideas/:id/likes/toggle', (req, res) => likeToggle(req, res));
app.put('/ideas/:id/likes', (req, res) => {
  // PUT with {delta: 1|-1}
  const id = String(req.params.id);
  if (!getIdea(id)) return res.status(404).json({ error: 'Idea not found' });
  const who = tokenKey(req);
  const delta = Number((req.body && req.body.delta) || 0);
  const cur = (likesBy[id] && likesBy[id][who]) || false;
  const target = delta > 0 ? true : delta < 0 ? false : !cur;
  const count = setLike(id, who, target);
  broadcastIdeas({ type: 'like', id, likeCount: count, liked: target });
  res.json({ ok: true, likeCount: count, likesCount: count, liked: target });
});
app.post('/ideas/:id/toggleLike', (req, res) => likeToggle(req, res)); // alias

function likeSetFromBody(req, res, value){
  const id = String((req.body && req.body.id) || '');
  if (!id || !getIdea(id)) return res.status(404).json({ error: 'Idea not found' });
  const who = tokenKey(req);
  const like = (typeof req.body.like === 'boolean') ? req.body.like : value;
  const count = setLike(id, who, !!like);
  broadcastIdeas({ type: 'like', id, likeCount: count, liked: !!like });
  res.json({ ok: true, likeCount: count, likesCount: count, liked: !!like });
}
function likeToggleFromBody(req, res){
  const id = String((req.body && req.body.id) || '');
  if (!id || !getIdea(id)) return res.status(404).json({ error: 'Idea not found' });
  const who = tokenKey(req);
  const count = toggleLikeState(id, who);
  const liked = !!(likesBy[id] && likesBy[id][who]);
  broadcastIdeas({ type: 'like', id, likeCount: count, liked });
  res.json({ ok: true, likeCount: count, liked });
}
function likeSet(req, res, value){
  const id = String(req.params.id);
  if (!getIdea(id)) return res.status(404).json({ error: 'Idea not found' });
  const who = tokenKey(req);
  const like = (typeof req.body.like === 'boolean') ? req.body.like : value;
  const count = setLike(id, who, !!like);
  broadcastIdeas({ type: 'like', id, likeCount: count, liked: !!like });
  res.json({ ok: true, likeCount: count, likesCount: count, liked: !!like });
}
function likeToggle(req, res){
  const id = String(req.params.id);
  if (!getIdea(id)) return res.status(404).json({ error: 'Idea not found' });
  const who = tokenKey(req);
  const count = toggleLikeState(id, who);
  const liked = !!(likesBy[id] && likesBy[id][who]);
  broadcastIdeas({ type: 'like', id, likeCount: count, liked });
  res.json({ ok: true, likeCount: count, liked });
}

/* ======================= Events JSON (stub) ======================= */
let sampleEvents = [
  // { title:'CPI Y/Y', currency:'USD', impact:'high', timeUTC:'2025-08-18T12:30:00Z', isPublished:false, readyForPublish:false }
];
app.get('/events', (req, res) => res.json(sampleEvents));
app.get('/events/list', (req, res) => res.json(sampleEvents));

/* ======================= Health & Root ======================= */
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (req, res) => {
  res.type('text').send('ideas-backend: OK. Try GET /ideas, /ideas/latest, POST /ideas, GET /ideas/stream (SSE).');
});

/* ======================= Start ======================= */
app.listen(PORT, () => {
  console.log(`ideas-backend listening on :${PORT}`);
  console.log(`CORS allowed: ${allowAll ? '*' : [...allowSet].join(', ')}`);
  console.log(`PUBLIC_LIKES: ${PUBLIC_LIKES ? 'ON (likes do not require auth)' : 'OFF (likes require auth)'}`);
  if (API_TOKEN) console.log('Write ops require Authorization: Bearer <API_TOKEN>');
});
