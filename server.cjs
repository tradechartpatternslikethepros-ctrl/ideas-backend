// server.cjs
// Deps: express cors multer nanoid nodemailer morgan
// Start: node server.cjs

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { nanoid } = require("nanoid");
const nodemailer = require("nodemailer");
let morgan = null; try { morgan = require("morgan"); } catch {}

const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = path.join(__dirname, "ideas.db");
const UPLOADS_DIR = path.join(__dirname, "uploads");

// ---- CORS allowlist ----
const RAW_ALLOW = String(process.env.ALLOW_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const WILDCARDS = RAW_ALLOW.filter(s => s.startsWith("*.")).map(s => s.slice(1)); // ".filesusr.com"
const EXACTS = new Set(RAW_ALLOW.filter(s => !s.startsWith("*.")));

// ---- App setup ----
const app = express();
if (morgan) app.use(morgan("tiny"));
app.disable("x-powered-by");
app.set("etag", false);
app.use((_, res, next) => { res.set("Cache-Control","no-store"); res.set("Pragma","no-cache"); res.set("Expires","0"); next(); });
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    try {
      if (EXACTS.has(origin)) return cb(null, true);
      const host = new URL(origin).hostname;
      if (WILDCARDS.some(suf => host.endsWith(suf))) return cb(null, true);
    } catch {}
    return cb(null, false);
  },
  credentials: false,
  optionsSuccessStatus: 200
}));

// ---- Storage ----
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ ideas: [] }, null, 2));

const upload = multer({ dest: UPLOADS_DIR });

function load() { try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return { ideas: [] }; } }
function save(s) { fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2)); }

let state = load(); // { ideas: [ ... ] }

// ---- Email ----
const NOTIFY_TO = (process.env.NOTIFY_TO || "").split(",").map(s => s.trim()).filter(Boolean);
const SUBSCRIBERS = new Set((process.env.SUBSCRIBERS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

let mailer = null;
if (process.env.SMTP_URL) {
  mailer = nodemailer.createTransport(process.env.SMTP_URL);
} else if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") !== "false",
    auth: (process.env.SMTP_USER && process.env.SMTP_PASS) ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
} else {
  // dev fallback: log emails to console
  mailer = nodemailer.createTransport({ jsonTransport: true });
}

async function sendMail({ subject, html, to = [] }) {
  const merged = [...new Set([...(to||[]), ...NOTIFY_TO])].filter(Boolean);
  const paidOnly = merged.filter(e => SUBSCRIBERS.size ? SUBSCRIBERS.has(e.toLowerCase()) : true);
  const finalTo = paidOnly.length ? paidOnly.join(", ") : (NOTIFY_TO[0] || "console@logs.local");
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || "Pro Members <no-reply@example.com>",
      to: finalTo,
      subject: subject || "(no subject)",
      html: html || "<p>(empty)</p>"
    });
  } catch (e) {
    console.warn("[email] failed:", e.message);
  }
}

// ---- SSE (realtime) ----
const clients = new Set();
function sseBroadcast(event, payload) {
  const line = `event: ${event}\n` + `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch {} }
}
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write("retry: 5000\n\n");
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  clients.add(res);
  const hb = setInterval(() => { try { res.write(":\n\n"); } catch {} }, 10000);
  req.on("close", () => { clearInterval(hb); clients.delete(res); });
});

// ---- Static uploads ----
app.use("/uploads", express.static(UPLOADS_DIR, {
  fallthrough: false, etag: false, lastModified: false, cacheControl: false
}));

// ---- Helpers ----
function sanitizeFile(f) {
  if (!f) return null;
  return { filename: f.filename, originalname: f.originalname, url: `/uploads/${f.filename}` };
}
function ideaPublic(i, { withComments = false } = {}) {
  const base = {
    id: i.id, type: i.type || "post",
    title: i.title || "", symbol: i.symbol || "", link: i.link || "",
    levelText: i.levelText || "", take: i.take || "",
    imageUrl: i.imageUrl || "", imageData: i.imageData || "",
    createdAt: i.createdAt, updatedAt: i.updatedAt,
    likeCount: (i.likedBy ? i.likedBy.size || i.likedBy.length : 0),
    commentCount: (i.comments || []).length,
    authorName: i.authorName || "Member", authorId: i.authorId || ""
  };
  if (withComments) base.comments = (i.comments || []).map(c => ({
    id: c.id, text: c.text || "", authorName: c.authorName || "Member",
    authorId: c.authorId || "", createdAt: c.createdAt, updatedAt: c.updatedAt
  }));
  return base;
}
function idxById(id) { return state.ideas.findIndex(x => x.id === id); }

// ---- Health ----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Read ----
app.get("/ideas", (_req, res) => {
  res.json(state.ideas.map(i => ideaPublic(i)));
});

app.get("/ideas/latest", (_req, res) => {
  const latest = state.ideas.length ? ideaPublic(state.ideas[state.ideas.length - 1]) : null;
  res.json(latest || {});
});

app.get("/ideas/:id", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  res.json(ideaPublic(state.ideas[i], { withComments: true }));
});

// ---- Create (JSON or multipart with file) ----
app.post("/ideas", upload.single("file"), async (req, res) => {
  const now = new Date().toISOString();
  const body = req.is("multipart/form-data") ? req.body : (req.body || {});
  const f = req.file ? sanitizeFile(req.file) : null;

  const idea = {
    id: nanoid(12),
    type: body.type || "post",
    title: String(body.title || "").trim(),
    symbol: String(body.symbol || "").trim(),
    link: String(body.link || "").trim(),
    levelText: String(body.levelText || body.levels || "").trim(),
    take: String(body.take || body.myTake || "").trim(),
    imageUrl: f ? f.url : String(body.imageUrl || ""),
    imageData: String(body.imageData || ""), // base64 (optional)
    authorName: String(body.authorName || "Member"),
    authorId: String(body.authorId || ""),
    createdAt: now,
    updatedAt: now,
    likedBy: new Set(),     // store as Set in memory
    comments: []            // [{id,text,author...}]
  };

  state.ideas.push(idea);
  save({ ideas: state.ideas.map(x => ({ ...x, likedBy: Array.from(x.likedBy || []) })) });

  const pub = ideaPublic(idea);
  sseBroadcast("idea.created", pub);

  // Email: New idea
  try {
    await sendMail({
      subject: `New idea: ${pub.title || "(untitled)"}`,
      html: `<h3>${pub.title || "(untitled)"}</h3>
             <p><b>Symbol:</b> ${pub.symbol || "-"}<br/>
             <b>Levels:</b> ${pub.levelText || "-"}<br/>
             <b>Take:</b> ${pub.take || "-"}</p>`
    });
  } catch {}

  res.status(201).json(pub);
});

// ---- Update ----
app.patch("/ideas/:id", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  const it = state.ideas[i];
  const p = req.body || {};
  ["type","title","symbol","link","levelText","take","imageUrl","imageData","authorName","authorId"].forEach(k=>{
    if (p[k] !== undefined) it[k] = p[k];
  });
  it.updatedAt = new Date().toISOString();

  save({ ideas: state.ideas.map(x => ({ ...x, likedBy: Array.from(x.likedBy || []) })) });
  const pub = ideaPublic(it);
  sseBroadcast("idea.updated", pub);
  res.json(pub);
});

// ---- Delete ----
app.delete("/ideas/:id", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  const removed = ideaPublic(state.ideas[i]);
  state.ideas.splice(i, 1);
  save({ ideas: state.ideas.map(x => ({ ...x, likedBy: Array.from(x.likedBy || []) })) });
  sseBroadcast("idea.deleted", removed);
  res.status(204).end();
});

// ---- Likes (POST like, DELETE unlike) ----
app.post("/ideas/:id/like", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  const uid = String(req.get("X-User-Id") || "").trim() || "anon";
  if (!state.ideas[i].likedBy) state.ideas[i].likedBy = new Set();
  state.ideas[i].likedBy.add(uid);
  const likeCount = state.ideas[i].likedBy.size;
  save({ ideas: state.ideas.map(x => ({ ...x, likedBy: Array.from(x.likedBy || []) })) });
  sseBroadcast("idea.liked", { id: state.ideas[i].id, likeCount });
  res.json({ ok: true, likeCount });
});

app.delete("/ideas/:id/like", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  const uid = String(req.get("X-User-Id") || "").trim() || "anon";
  if (!state.ideas[i].likedBy) state.ideas[i].likedBy = new Set();
  state.ideas[i].likedBy.delete(uid);
  const likeCount = state.ideas[i].likedBy.size;
  save({ ideas: state.ideas.map(x => ({ ...x, likedBy: Array.from(x.likedBy || []) })) });
  sseBroadcast("idea.unliked", { id: state.ideas[i].id, likeCount });
  res.json({ ok: true, likeCount });
});

// ---- Comments CRUD ----
app.get("/ideas/:id/comments", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  const items = (state.ideas[i].comments || []).map(c => ({
    id: c.id, text: c.text, authorName: c.authorName, authorId: c.authorId,
    createdAt: c.createdAt, updatedAt: c.updatedAt
  }));
  res.json(items);
});

app.post("/ideas/:id/comments", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  const { text = "", authorId = "", authorName = "Member" } = req.body || {};
  const cm = {
    id: nanoid(10),
    text: String(text || "").trim(),
    authorId: String(authorId || ""),
    authorName: String(authorName || "Member"),
    createdAt: new Date().toISOString(),
    updatedAt: null
  };
  state.ideas[i].comments = state.ideas[i].comments || [];
  state.ideas[i].comments.push(cm);
  save({ ideas: state.ideas.map(x => ({ ...x, likedBy: Array.from(x.likedBy || []) })) });
  sseBroadcast("comment.created", { ideaId: state.ideas[i].id, comment: cm });
  res.status(201).json({ ok: true, items: state.ideas[i].comments.map(c => ({
    id: c.id, text: c.text, authorName: c.authorName, authorId: c.authorId,
    createdAt: c.createdAt, updatedAt: c.updatedAt
  })) });
});

app.patch("/ideas/:id/comments/:cid", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  const list = state.ideas[i].comments || [];
  const j = list.findIndex(c => c.id === req.params.cid);
  if (j === -1) return res.status(404).json({ error: "not_found" });
  if (req.body.text !== undefined) list[j].text = String(req.body.text);
  list[j].updatedAt = new Date().toISOString();
  save({ ideas: state.ideas.map(x => ({ ...x, likedBy: Array.from(x.likedBy || []) })) });
  sseBroadcast("comment.updated", { ideaId: state.ideas[i].id, comment: list[j] });
  res.json({ ok: true, items: list.map(c => ({
    id: c.id, text: c.text, authorName: c.authorName, authorId: c.authorId,
    createdAt: c.createdAt, updatedAt: c.updatedAt
  })) });
});

app.delete("/ideas/:id/comments/:cid", (req, res) => {
  const i = idxById(req.params.id);
  if (i === -1) return res.status(404).json({ error: "not_found" });
  const list = state.ideas[i].comments || [];
  const before = list.length;
  state.ideas[i].comments = list.filter(c => c.id !== req.params.cid);
  if (state.ideas[i].comments.length === before) return res.status(404).json({ error: "not_found" });
  save({ ideas: state.ideas.map(x => ({ ...x, likedBy: Array.from(x.likedBy || []) })) });
  sseBroadcast("comment.deleted", { ideaId: state.ideas[i].id, commentId: req.params.cid });
  res.status(204).end();
});

// ---- Email notify endpoints (optional; no secret required) ----
app.post("/api/notify-post", async (req, res) => {
  const p = req.body || {};
  try {
    await sendMail({
      subject: `New Post: ${p.title || "(untitled)"}`,
      html: `<h3>${p.title || "(untitled)"}</h3>
             <p><b>Symbol:</b> ${p.symbol || "-"}<br/>
             <b>Link:</b> ${p.link || "-"}<br/>
             <b>Levels:</b> ${p.levelText || "-"}<br/>
             <b>By:</b> ${p.authorName || "Member"} (${p.authorEmail || "-"})</p>`,
      to: Array.isArray(p.to) ? p.to : undefined
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/notify-signal", async (req, res) => {
  const p = req.body || {};
  try {
    await sendMail({
      subject: `Signal: ${String(p.type || "signal").toUpperCase()} — ${p.title || "(untitled)"}`,
      html: `<h3>${p.title || "(untitled)"} — ${String(p.type || "signal").toUpperCase()}</h3>
             <p><b>Symbol:</b> ${p.symbol || "-"}<br/>
             <b>When:</b> ${p.when || new Date().toISOString()}</p>`,
      to: Array.isArray(p.to) ? p.to : undefined
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`ideas-backend listening on ${PORT}`);
  console.log(`Allowed origins: ${RAW_ALLOW.join(", ")}`);
});
