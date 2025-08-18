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
app.set('trust proxy', 1);

/* ======================= Utils & Env ======================= */
function cleanEnv(v, fallback = '') {
  if (v == null) return fallback;
  const s = String(v).trim();
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
const API_TOKEN = cleanEnv(process.env.API_TOKEN);
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
    if (!origin) return cb(null, true);
    if (allowAll || allowSet.has(origin)) return cb(null, true);
    return cb(new Error('CORS: Origin not allowed'), false);
  },
  credentials: false,
  methods: ['GET','POST','PATCH','DELETE','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));
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

function isLikeWrite(req){
  const p = (req.path || '').toLowerCase();
  if (req.method === 'POST' && p === '/ideas' && req.body && req.body.op === 'like_toggle') return true;
  if (req.method === 'POST' && /^\/likes(\/toggle)?$/.test(p)) return true;
  if (req.method === 'DELETE' && /^\/likes$/.test(p)) return true;
  if (/^\/ideas\/(like|likes)(\/toggle)?$/.test(p)) return true;
  if (/^\/ideas\/[^/]+\/(like|likes)(\/toggle)?$/.test(p)) return true;
  if (req.method === 'PUT' && /^\/ideas\/[^/]+\/likes$/.test(p)) return true;
  return false;
}

function isAuthed(req) {
  if (!API_TOKEN) return true;
  const hdr = req.headers.authorization || '';
  const raw = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const token = cleanEnv(raw);
  return token === API_TOKEN;
}

function requireAuth(req, res, next){
  if (!isWrite(req)) return next();
  if (PUBLIC_LIKES && isLikeWrite(req)) return next();
  if (!isAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use(requireAuth);

function tokenKey(req){
  if (isAuthed(req) && API_TOKEN) return 'owner';
  if (PUBLIC_LIKES) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    return 'pub_' + sha1(ip + '|' + ua).slice(0, 12);
  }
  return 'anon';
}

/* ======================= In-memory stores ======================= */
let ideas = [];
const likesBy = Object.create(null);
const commentsBy = Object.create(null);
const images = new Map();
const uploads = new Map();

/* ======================= SSE ======================= */
const sseClients = new Set();
const evtClients = new Set();
const HEARTBEAT_MS = 25000;

function sseHeaders(res){
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
}
function sseSend(res, data){
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function broadcastIdeas(msg){ for (const c of sseClients) { try { sseSend(c, msg); } catch {} } }
function broadcastEvents(msg){ for (const c of evtClients) { try { sseSend(c, msg); } catch {} } }
setInterval(() => {
  for (const c of sseClients) { try { sseSend(c, { type: 'ping', ts: Date.now() }); } catch {} }
  for (const c of evtClients) { try { sseSend(c, { type: 'ping', ts: Date.now() }); } catch {} }
}, HEARTBEAT_MS);

app.get('/ideas/stream', (req,res) => {
  sseHeaders(res); sseClients.add(res);
  sseSend(res,{ type:'hello', ts:Date.now() });
  req.on('close', () => { sseClients.delete(res); try{res.end();}catch{} });
});
app.get('/events/stream', (req,res) => {
  sseHeaders(res); evtClients.add(res);
  sseSend(res,{ type:'hello', ts:Date.now() });
  req.on('close', () => { evtClients.delete(res); try{res.end();}catch{} });
});

/* ======================= Images & Uploads ======================= */
app.post('/images/upload', upload.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  const id = genId('img_');
  images.set(id,{ mime:req.file.mimetype||'application/octet-stream', buf:req.file.buffer, ts:Date.now() });
  res.json({ url:`${publicBase(req)}/images/${id}` });
});
app.get('/images/:id', (req,res) => {
  const img = images.get(req.params.id);
  if (!img) return res.status(404).end();
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control','public, max-age=31536000, immutable');
  res.send(img.buf);
});
app.post(['/upload','/uploads'], upload.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  const name = genId('').replace(/^id_/,'') + guessExt(req.file.mimetype);
  uploads.set(name,{ mime:req.file.mimetype, buf:req.file.buffer, ts:Date.now() });
  res.json({ url:`${publicBase(req)}/uploads/${name}` });
});
app.get('/uploads/:name', (req,res) => {
  const rec = uploads.get(req.params.name);
  if (!rec) return res.status(404).end();
  res.setHeader('Content-Type', rec.mime);
  res.setHeader('Cache-Control','public, max-age=31536000, immutable');
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
function getIdea(id){ return ideas.find(x => String(x.id)===String(id)); }
function saveIdea(obj){
  const now = nowISO();
  if (!obj.id) {
    obj.id = genId('idea_');
    obj.createdAt = now; obj.updatedAt = now;
    obj.likeCount=0; obj.commentCount=0;
    ideas.push(obj);
  } else {
    obj.updatedAt=now;
    const i=ideas.findIndex(x=>x.id===obj.id);
    if(i>=0) ideas[i]=obj; else ideas.push(obj);
  }
  return obj;
}
function deleteIdea(id){
  const i=ideas.findIndex(x=>String(x.id)===String(id));
  if(i>=0) ideas.splice(i,1);
}

/* ======================= Likes helpers ======================= */
function recalcLikeCount(id){
  const map = likesBy[id]||{};
  const count = Object.values(map).filter(Boolean).length;
  const it = getIdea(id); if(it) it.likeCount=count;
  return count;
}
function setLike(id,who,val){
  if(!likesBy[id]) likesBy[id]={};
  likesBy[id][who]=!!val;
  return recalcLikeCount(id);
}
function toggleLikeState(id,who){
  const cur = (likesBy[id]&&likesBy[id][who])||false;
  return setLike(id,who,!cur);
}

/* ======================= Comments helpers ======================= */
function listComments(id){ return commentsBy[id]||[]; }
function addComment(id,text,userId='User'){
  const cm={ id:genId('cm_'), userId, text:String(text||''), createdAt:nowISO() };
  if(!commentsBy[id]) commentsBy[id]=[];
  commentsBy[id].push(cm);
  const it=getIdea(id); if(it) it.commentCount=listComments(id).length;
  return cm;
}
function editComment(id,cid,text){
  const arr=commentsBy[id]||[];
  const i=arr.findIndex(c=>String(c.id)===String(cid));
  if(i<0) return false;
  arr[i].text=String(text||''); return true;
}
function deleteCommentById(id,cid){
  const arr=commentsBy[id]||[];
  const i=arr.findIndex(c=>String(c.id)===String(cid));
  if(i<0) return false;
  arr.splice(i,1);
  const it=getIdea(id); if(it) it.commentCount=arr.length;
  return true;
}

/* ======================= REST: Ideas & Ops ======================= */
app.get('/ideas', (req,res)=> res.json(ideas));
app.get('/ideas/latest', (req,res)=>{
  const sorted=[...ideas].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  res.json(sorted[0]||null);
});
app.get('/ideas/:id', (req,res)=>{
  const it=getIdea(req.params.id);
  if(!it) return res.status(404).json({error:'Not found'});
  res.json(it);
});
app.post('/ideas', (req,res)=>{
  if(req.body.op==='like_toggle'){
    const { id }=req.body;
    if(!id) return res.status(400).json({error:'Missing id'});
    const who=tokenKey(req);
    const count=toggleLikeState(id,who);
    return res.json({ok:true,likeCount:count,likesCount:count,liked:!!likesBy[id][who]});
  }
  const { title='', symbol='', summary='', type='idea' }=req.body||{};
  const obj=saveIdea({ title,symbol,summary,type });
  broadcastIdeas({type:'created',idea:obj});
  res.status(201).json(obj);
});
app.patch('/ideas/:id', (req,res)=>{
  const it=getIdea(req.params.id);
  if(!it) return res.status(404).json({error:'Not found'});
  Object.assign(it, req.body||{});
  saveIdea(it);
  broadcastIdeas({type:'updated',idea:it});
  res.json(it);
});
app.delete('/ideas/:id', (req,res)=>{
  const it=getIdea(req.params.id);
  if(!it) return res.status(404).json({error:'Not found'});
  deleteIdea(it.id);
  broadcastIdeas({type:'deleted',id:it.id});
  res.json({ok:true});
});

/* ======================= Comments routes ======================= */
app.get('/ideas/:id/comments',(req,res)=> res.json({items:listComments(req.params.id)}));
app.post('/ideas/:id/comments',(req,res)=>{
  const { text }=req.body||{};
  if(!text) return res.status(400).json({error:'Missing text'});
  const cm=addComment(req.params.id,text,'user');
  broadcastIdeas({type:'comment_added',ideaId:req.params.id,comment:cm});
  res.status(201).json(cm);
});
app.patch('/ideas/:id/comments/:cid',(req,res)=>{
  const ok=editComment(req.params.id,req.params.cid,req.body.text);
  if(!ok) return res.status(404).json({error:'Not found'});
  broadcastIdeas({type:'comment_edited',ideaId:req.params.id,commentId:req.params.cid});
  res.json({ok:true});
});
app.delete('/ideas/:id/comments/:cid',(req,res)=>{
  const ok=deleteCommentById(req.params.id,req.params.cid);
  if(!ok) return res.status(404).json({error:'Not found'});
  broadcastIdeas({type:'comment_deleted',ideaId:req.params.id,commentId:req.params.cid});
  res.json({ok:true});
});

/* ======================= Likes routes ======================= */
app.post(['/likes','/likes/toggle'],(req,res)=>{
  const { id }=req.body||{};
  if(!id) return res.status(400).json({error:'Missing id'});
  const who=tokenKey(req);
  const count=toggleLikeState(id,who);
  res.json({ok:true,likeCount:count,likesCount:count,liked:!!likesBy[id][who]});
});
app.delete('/likes',(req,res)=>{
  const { id }=req.body||{};
  if(!id) return res.status(400).json({error:'Missing id'});
  const who=tokenKey(req);
  setLike(id,who,false);
  res.json({ok:true,likeCount:recalcLikeCount(id)});
});
app.post(['/ideas/like','/ideas/likes','/ideas/like/toggle','/ideas/likes/toggle'],(req,res)=>{
  const { id }=req.body||{};
  if(!id) return res.status(400).json({error:'Missing id'});
  const who=tokenKey(req);
  const count=toggleLikeState(id,who);
  res.json({ok:true,likeCount:count,likesCount:count,liked:!!likesBy[id][who]});
});
app.post(['/ideas/:id/like','/ideas/:id/likes','/ideas/:id/like/toggle','/ideas/:id/likes/toggle'],(req,res)=>{
  const id=req.params.id;
  const who=tokenKey(req);
  const count=toggleLikeState(id,who);
  res.json({ok:true,likeCount:count,likesCount:count,liked:!!likesBy[id][who]});
});
app.put('/ideas/:id/likes',(req,res)=>{
  const id=req.params.id;
  const who=tokenKey(req);
  const { value }=req.body||{};
  const count=setLike(id,who,!!value);
  res.json({ok:true,likeCount:count,likesCount:count,liked:!!likesBy[id][who]});
});

/* ======================= Events stub ======================= */
app.get(['/events','/events/list'],(req,res)=> res.json([]));

/* ======================= Health ======================= */
app.get(['/','/health'],(req,res)=> res.json({ok:true,time:nowISO()}));

/* ======================= Start ======================= */
app.listen(PORT,()=> {
  console.log(`ideas-backend listening on :${PORT}`);
  console.log(`CORS allowed: ${allowAll?'*':[...allowSet].join(',')}`);
  console.log(`PUBLIC_LIKES: ${PUBLIC_LIKES?'ON':'OFF'}`);
  console.log(`Write ops require Authorization: Bearer <API_TOKEN>`);
});
