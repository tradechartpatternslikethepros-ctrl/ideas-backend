// server.js — Ideas + Events API (SQLite + uploads)
// Works locally and on Render/Railway/Fly with a persistent disk.
//
// Endpoints:
//   GET  /ideas?limit=50
//   GET  /ideas/latest
//   POST /ideas           { title, symbol, levelText, take, imageData?, type? }
//   GET  /events?limit=8
//   POST /events          { timeUTC, title, impact?, currency? }
//   GET  /health
//
// Env (can be in env.txt for local dev):
//   PORT=8787
//   API_TOKEN=supersecret123
//   ALLOWED_ORIGIN=https://your-site.com   (optional; empty = open CORS)
//   BASE_URL=https://ideas-backend.onrender.com  (optional; builds absolute image URLs)
//   DATA_DIR=/data        (for cloud; mount your persistent disk here)
//   DB_PATH=/data/ideas.db        (optional override)
//   UPLOAD_DIR=/data/uploads      (optional override)

import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

// ---------- Load env (.env or env.txt) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
if (fs.existsSync(path.join(__dirname, 'env.txt'))) {
  dotenv.config({ path: path.join(__dirname, 'env.txt') });
} else if (fs.existsSync(path.join(__dirname, '.env'))) {
  dotenv.config();
}

// ---------- Config ----------
const app = express();
const PORT = Number(process.env.PORT || 8787);
const API_TOKEN = process.env.API_TOKEN || '';           // if set, required for POST
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // if set, restrict CORS
const BASE_URL_ENV = process.env.BASE_URL || '';         // e.g. https://ideas-backend.onrender.com

// Use mountable data dir for DB + uploads (great for Render/Railway volumes)
const DATA_DIR   = process.env.DATA_DIR   || process.cwd();
const DB_PATH    = process.env.DB_PATH    || path.join(DATA_DIR, 'ideas.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');

// Ensure dirs
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '20mb' })); // allow base64 images
app.use(morgan('tiny'));
app.use(
  cors({
    origin: ALLOWED_ORIGIN ? [ALLOWED_ORIGIN] : true,
  })
);

// ---------- DB (SQLite) ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`-- ideas
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  type TEXT DEFAULT 'post',       -- 'idea' | 'post'
  title TEXT NOT NULL,
  symbol TEXT,
  levelText TEXT,
  take TEXT,
  imageUrl TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_createdAt ON ideas (createdAt DESC);

-- events
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  timeUTC TEXT NOT NULL,          -- ISO in UTC
  title TEXT NOT NULL,
  impact TEXT,                    -- 'low' | 'med' | 'high'
  currency TEXT,                  -- e.g. USD/EUR
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events (timeUTC ASC);
`);

const insertIdea   = db.prepare(`INSERT INTO ideas (id, type, title, symbol, levelText, take, imageUrl, createdAt)
  VALUES (@id, @type, @title, @symbol, @levelText, @take, @imageUrl, @createdAt)`);
const listIdeas    = db.prepare(`SELECT * FROM ideas ORDER BY datetime(createdAt) DESC LIMIT ?`);
const latestIdea   = db.prepare(`SELECT * FROM ideas ORDER BY datetime(createdAt) DESC LIMIT 1`);
const getIdeaById  = db.prepare(`SELECT * FROM ideas WHERE id = ?`);

const insertEvent  = db.prepare(`INSERT INTO events (id, timeUTC, title, impact, currency, createdAt)
  VALUES (@id, @timeUTC, @title, @impact, @currency, @createdAt)`);
const listUpcoming = db.prepare(`
  SELECT * FROM events
  WHERE datetime(timeUTC) >= datetime('now')
  ORDER BY datetime(timeUTC) ASC
  LIMIT ?
`);
const countEvents  = db.prepare(`SELECT COUNT(*) AS n FROM events`);

// ---------- Seed a few events on first boot ----------
if (!countEvents.get().n) {
  const now = Date.now();
  const seed = [
    { timeUTC: new Date(now +  1*3600e3).toISOString(), title: 'CPI (YoY)',  impact: 'high', currency: 'USD' },
    { timeUTC: new Date(now +  3*3600e3).toISOString(), title: 'ECB Presser',impact: 'med',  currency: 'EUR' },
    { timeUTC: new Date(now + 25*3600e3).toISOString(), title: 'GDP (QoQ)',  impact: 'low',  currency: 'GBP' },
  ];
  const tx = db.transaction((rows) => {
    rows.forEach((r) =>
      insertEvent.run({
        id: nanoid(12),
        createdAt: new Date().toISOString(),
        ...r,
      })
    );
  });
  tx(seed);
}

// ---------- Helpers ----------
function extFromMime(mime) {
  if (!mime) return 'png';
  const m = mime.toLowerCase();
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('png'))  return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif'))  return 'gif';
  if (m.includes('svg'))  return 'svg';
  return 'png';
}

function saveDataURLToFile(dataURL) {
  if (!dataURL || typeof dataURL !== 'string') return null;

  let mime = 'image/png';
  let base64 = dataURL;

  // Accept full data URLs or raw base64
  const match = /^data:(.+);base64,(.*)$/i.exec(dataURL);
  if (match) {
    mime = match[1];
    base64 = match[2];
  }

  const ext = extFromMime(mime);
  const id = nanoid(12);
  const filename = `${id}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filename;
}

function baseUrlFromReq(req) {
  if (BASE_URL_ENV) return BASE_URL_ENV.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString();
  const host  = req.get('host');
  return `${proto}://${host}`;
}

function requireBearer(req, res, next) {
  if (!API_TOKEN) return next(); // open if not configured
  const header = req.headers.authorization || '';
  const ok = header.startsWith('Bearer ') && header.slice(7) === API_TOKEN;
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Static files (uploaded images)
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '365d', immutable: true }));

// ---------- Routes: Ideas ----------

// GET /ideas?limit=50
app.get('/ideas', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  res.json(listIdeas.all(limit));
});

// GET /ideas/latest
app.get('/ideas/latest', (_req, res) => {
  const row = latestIdea.get();
  if (!row) return res.status(204).end(); // no content
  res.json(row);
});

// POST /ideas
app.post('/ideas', requireBearer, (req, res) => {
  try {
    const {
      title     = '',
      symbol    = '',
      levelText = '',
      take      = '',
      imageData = '',   // optional base64 (data URL or raw)
      type      = 'post'
    } = req.body || {};

    const trim = (s) => (typeof s === 'string' ? s.trim() : '');
    const data = {
      id: nanoid(12),
      type: trim(type) || 'post',
      title: trim(title),
      symbol: trim(symbol).toUpperCase(),
      levelText: trim(levelText),
      take: trim(take),
      imageUrl: null,
      createdAt: new Date().toISOString(),
    };

    if (!data.title) {
      return res.status(400).json({ error: 'title is required' });
    }

    if (imageData && typeof imageData === 'string' && imageData.length > 20) {
      const filename = saveDataURLToFile(imageData);
      if (filename) {
        data.imageUrl = `${baseUrlFromReq(req)}/uploads/${filename}`;
      }
    }

    insertIdea.run(data);
    res.status(201).json(getIdeaById.get(data.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Routes: Events ----------

// GET /events?limit=8
app.get('/events', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 100);
  res.json(listUpcoming.all(limit));
});

// POST /events (optional, guarded by API_TOKEN)
app.post('/events', requireBearer, (req, res) => {
  const { timeUTC = '', title = '', impact = 'low', currency = '' } = req.body || {};
  if (!timeUTC || !title) return res.status(400).json({ error: 'timeUTC and title are required' });

  const row = {
    id: nanoid(12),
    timeUTC: String(timeUTC),
    title: String(title).trim(),
    impact: String(impact || 'low').toLowerCase(),
    currency: String(currency || '').toUpperCase(),
    createdAt: new Date().toISOString(),
  };
  try {
    insertEvent.run(row);
    res.status(201).json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Health & Root ----------
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'ideas-backend',
    endpoints: ['/ideas', '/ideas/latest', '/events', '/health'],
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log('------------------------------------------');
  console.log(`Ideas API listening on http://localhost:${PORT}`);
  console.log(`DB:        ${DB_PATH}`);
  console.log(`Uploads:   ${UPLOAD_DIR}`);
  console.log(`CORS:      ${ALLOWED_ORIGIN ? ALLOWED_ORIGIN : 'open'}`);
  console.log(`Auth:      ${API_TOKEN ? 'Bearer token required (API_TOKEN set)' : 'OPEN (no API_TOKEN)'}`);
  if (BASE_URL_ENV) console.log(`BASE_URL:  ${BASE_URL_ENV}`);
  console.log('------------------------------------------');
});
