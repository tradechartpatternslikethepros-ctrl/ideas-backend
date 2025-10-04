/* server.patched.cjs */
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

let morgan = null;
try { morgan = require("morgan"); } catch {}

const PORT = Number(process.env.PORT) || 8080;

/* ---------- ENV / Config ---------- */
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS
  ? process.env.ALLOW_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : [
      "*.filesusr.com",
      "*.wixsite.com",
      "*.wixstatic.com",
      "*.parastorage.com",
      "https://www.tradechartpatternslikethepros.com",
      "https://tradechartpatternslikethepros.com",
      "https://editor.wix.com",
      "https://www.wix.com",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://www-tradechartpatternslikethepros-com.filesusr.com",
    ]
);

const AUTH_TOKEN =
  process.env.API_TOKEN ||
  process.env.TOKEN ||
  "4a6ffbf3209fb1392341615d5b6abc6f4db5998a22d825f2615dfd22e3965dfa";

const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC_LIKES = String(process.env.PUBLIC_LIKES || "true").toLowerCase() === "true";

/* Email env (already set in your Railway):
   SMTP_URL="smtp://USERNAME:PASSWORD@smtp.sendgrid.net:587"
   NOTIFY_FROM="Pro Members <no-reply@tradechartpatternslikethepros.com>"
   NOTIFY_TO="alerts@tradechartpatternslikethepros.com"
*/
const SMTP_URL = process.env.SMTP_URL || "";
const NOTIFY_FROM = process.env.NOTIFY_FROM || "";
const NOTIFY_TO = (process.env.NOTIFY_TO || "").split(",").map(s => s.trim()).filter(Boolean);

/* ---------- Helpers ---------- */
const nowISO = () => new Date().toISOString();
const uid = (p = "idea") => `${p}_${crypto.randomBytes(6).toString("base64url")}`;

function isWildcard(pattern) { return typeof pattern === "string" && pattern.startsWith("*."); }
function hostnameFromOrigin(origin) { try { return new URL(origin).hostname; } catch { return ""; } }
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOW_ORIGINS.includes("*") || ALLOW_ORIGINS.includes(origin)) return true;
  const host = hostnameFromOrigin(origin);
  if (!host) return false;
  for (const pat of ALLOW_ORIGINS) {
    if (isWildcard(pat)) {
      const suffix = pat.slice(1);
      if (host.endsWith(suffix)) return true;
    }
  }
  return false;
}

/** auth */
function requireAuth(req, res, next) {
  const auth = req.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token && token === AUTH_TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
}
/** likes may be public if PUBLIC_LIKES=true */
const requireAuthMaybe = PUBLIC_LIKES ? (_req, _res, next) => next() : requireAuth;

/** summary */
const summarize = (idea) => idea.levelText || idea.take || "";

/** sanitize idea (don’t leak Sets) */
function sanitizeIdea(idea) {
  return {
    id: idea.id,
    type: idea.type,
    title: idea.title,
    symbol: idea.symbol,
    link: idea.link,
    levelText: idea.levelText,
    take: idea.take,
    imageUrl: idea.imageUrl,
    imageData: idea.imageData,
    authorName: idea.authorName,
    authorId: idea.authorId,
    summary: idea.summary,
    createdAt: idea.createdAt,
    updatedAt: idea.updatedAt,
    likeCount: idea.likedBy.size,
    commentCount: idea.comments.length,
    comments: idea.comments.map(c => ({
      id: c.id,
      text: c.text,
      authorName: c.authorName,
      authorId: c.authorId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  };
}

/* ---------- Email ---------- */
let mailer = null;
if (SMTP_URL && NOTIFY_FROM && NOTIFY_TO.length) {
  try {
    mailer = nodemailer.createTransport(SMTP_URL);
    // (optional) verify transport on boot, but don’t crash if it fails
    mailer.verify().catch(() => {});
  } catch (_) { mailer = null; }
}

async function sendIdeaEmail(idea) {
  if (!mailer) return;
  const viewUrl = `${BASE_URL}/ideas/${encodeURIComponent(idea.id)}`;
  const subject =
    (idea.symbol ? `${idea.symbol} — ` : "") +
    (idea.title || "New Idea");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;background:#0b1220;color:#e7ebf5;padding:16px">
      <h2 style="margin:0 0 8px 0">New Idea Published</h2>
      <p style="margin:0 0 8px 0"><strong>${escapeHtml(idea.title || "")}</strong></p>
      ${idea.symbol ? `<p style="margin:0 0 8px 0"><strong>Symbol:</strong> ${escapeHtml(idea.symbol)}</p>` : ""}
      ${idea.levelText ? `<p style="margin:0 0 8px 0"><strong>Levels:</strong> ${escapeHtml(idea.levelText)}</p>` : ""}
      ${idea.take ? `<p style="margin:0 0 12px 0"><strong>Take:</strong> ${escapeHtml(idea.take)}</p>` : ""}
      <p style="margin:12px 0"><a href="${viewUrl}" style="background:#00d0ff;color:#001018;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:700">Open Idea</a></p>
      ${idea.link ? `<p style="margin:12px 0 0 0">Chart Link: <a href="${escapeAttr(idea.link)}">${escapeHtml(idea.link)}</a></p>` : ""}
      <p style="margin:18px 0 0 0;font-size:12px;opacity:.7">Sent by Pro Members Ideas</p>
    </div>
  `;

  const text =
`${idea.title || "New Idea"}
${idea.symbol ? `Symbol: ${idea.symbol}\n` : ""}${idea.levelText ? `Levels: ${idea.levelText}\n` : ""}${idea.take ? `Take: ${idea.take}\n` : ""}${idea.link ? `Chart: ${idea.link}\n` : ""}Open: ${viewUrl}
  `.trim();

  try {
    await mailer.sendMail({
      from: NOTIFY_FROM,
      to: NOTIFY_TO,
      subject,
      html,
      text,
    });
  } catch (_) {
    // swallow email errors; notifications are best-effort
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function escapeAttr(s){ return String(s || "").replace(/"/g, "&quot;"); }

/* ---------- App ---------- */
const app = express();
if (morgan) app.use(morgan("tiny"));
app.use(express.json({ limit: "2mb" }));

const corsOptions = {
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.warn("[CORS] blocked origin:", origin);
    const err = Object.assign(new Error("CORS: Origin not allowed"), { status: 403 });
    return cb(err);
  },
  credentials: true,
  methods: "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  allowedHeaders: "Authorization, Content-Type, X-User-Id, X-User-Name",
  exposedHeaders: "Content-Type, Content-Length, ETag",
  maxAge: 86400,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/* ---------- State (in-memory) ---------- */
const state = { ideas: [] };

/* ---------- SSE ---------- */
const clients = new Set();

function broadcast(event, payload) {
  const line = `event: ${event}\n` + `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch {}
  }
}

function sseHandler(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  res.write("retry: 5000\n\n");
  res.write("event: hello\n");
  res.write(`data: ${JSON.stringify({ ts: nowISO() })}\n\n`);
  clients.add(res);

  const hb = setInterval(() => { try { res.write(":\n\n"); } catch {} }, 10000);
  req.on("close", () => { clearInterval(hb); clients.delete(res); });
}

/* ---------- Routes ---------- */

// Health
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "production", uptime: process.uptime() });
});

// List ideas
app.get("/ideas", (_req, res) => {
  res.json(state.ideas.map(sanitizeIdea));
});

// Latest idea
app.get("/ideas/latest", (_req, res) => {
  if (!state.ideas.length) return res.status(204).end();
  const latest = [...state.ideas].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  res.json(sanitizeIdea(latest));
});

// Get single idea
app.get("/ideas/:id", (req, res) => {
  const idea = state.ideas.find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: "not found" });
  res.json(sanitizeIdea(idea));
});

// Create idea (send email after broadcast; best-effort)
app.post("/ideas", requireAuth, async (req, res) => {
  const {
    title = "",
    symbol = "",
    link = "",
    levelText = "",
    take = "",
    imageUrl = "",
    imageData = "",
    authorName = "Member",
    authorId = "",
  } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });

  const idea = {
    id: uid("idea"),
    type: "idea",
    title,
    symbol,
    link,
    levelText,
    take,
    imageUrl,
    imageData,
    authorName,
    authorId,
    summary: summarize({ levelText, take }),
    likedBy: new Set(),
    comments: [],
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };

  state.ideas.push(idea);
  const out = sanitizeIdea(idea);
  broadcast("idea.created", out);
  res.status(201).json(out);

  // fire-and-forget email
  sendIdeaEmail(out).catch(() => {});
});

// Update idea
app.patch("/ideas/:id", requireAuth, (req, res) => {
  const idea = state.ideas.find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: "not found" });

  const allowed = ["title", "symbol", "link", "levelText", "take", "imageUrl", "imageData", "authorName", "authorId"];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) idea[k] = req.body[k] ?? idea[k];
  }
  idea.summary = summarize(idea);
  idea.updatedAt = nowISO();

  const out = sanitizeIdea(idea);
  broadcast("idea.updated", out);
  res.json(out);
});

// Delete idea
app.delete("/ideas/:id", requireAuth, (req, res) => {
  const idx = state.ideas.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const [removed] = state.ideas.splice(idx, 1);
  broadcast("idea.deleted", { id: removed.id });
  res.status(204).end();
});

// Like / Unlike (PUBLIC_LIKES controls auth)
app.post("/ideas/:id/like", requireAuthMaybe, (req, res) => {
  const idea = state.ideas.find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: "not found" });

  const userId = (req.get("X-User-Id") || "").trim();
  const userName = (req.get("X-User-Name") || "Member").trim();
  if (!userId) return res.status(400).json({ error: "X-User-Id header required" });

  idea.likedBy.add(userId);
  idea.updatedAt = nowISO();
  broadcast("idea.liked", { id: idea.id, likeCount: idea.likedBy.size, userId, userName });
  res.json({ id: idea.id, likeCount: idea.likedBy.size });
});

app.delete("/ideas/:id/like", requireAuthMaybe, (req, res) => {
  const idea = state.ideas.find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: "not found" });

  const userId = (req.get("X-User-Id") || "").trim();
  if (!userId) return res.status(400).json({ error: "X-User-Id header required" });

  idea.likedBy.delete(userId);
  idea.updatedAt = nowISO();
  broadcast("idea.unliked", { id: idea.id, likeCount: idea.likedBy.size, userId });
  res.json({ id: idea.id, likeCount: idea.likedBy.size });
});

// Add comment
app.post("/ideas/:id/comments", requireAuth, (req, res) => {
  const idea = state.ideas.find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: "not found" });

  const text = (req.body && req.body.text) || "";
  if (!text.trim()) return res.status(400).json({ error: "text required" });

  const authorId = (req.get("X-User-Id") || req.body.authorId || "").trim();
  const authorName = (req.get("X-User-Name") || req.body.authorName || "Member").trim();

  const comment = {
    id: uid("cmt"),
    text,
    authorId,
    authorName,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  idea.comments.push(comment);
  idea.updatedAt = nowISO();

  const payload = { ideaId: idea.id, comment };
  broadcast("comment.created", payload);
  res.status(201).json(comment);
});

// Edit comment
app.patch("/ideas/:id/comments/:cid", requireAuth, (req, res) => {
  const idea = state.ideas.find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: "not found" });

  const c = idea.comments.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: "comment not found" });

  const text = (req.body && req.body.text) || "";
  if (!text.trim()) return res.status(400).json({ error: "text required" });

  c.text = text;
  c.updatedAt = nowISO();
  idea.updatedAt = nowISO();

  const payload = { ideaId: idea.id, comment: c };
  broadcast("comment.updated", payload);
  res.json(c);
});

// Delete comment
app.delete("/ideas/:id/comments/:cid", requireAuth, (req, res) => {
  const idea = state.ideas.find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: "not found" });

  const idx = idea.comments.findIndex(x => x.id === req.params.cid);
  if (idx === -1) return res.status(404).json({ error: "comment not found" });

  const [removed] = idea.comments.splice(idx, 1);
  idea.updatedAt = nowISO();

  broadcast("comment.deleted", { ideaId: idea.id, id: removed.id });
  res.status(204).end();
});

// SSE endpoints
app.get("/events", sseHandler);
app.get("/ideas/stream", sseHandler);

/* ---------- 404 -> JSON ---------- */
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ error: "not found", path: req.originalUrl });
});

/* ---------- Error handler ---------- */
app.use((err, _req, res, _next) => {
  console.error(err);
  const code = Number.isInteger(err.status) ? err.status : 500;
  res.status(code).json({ error: err.message || "Internal Server Error" });
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`ideas-backend listening on ${PORT}`);
  console.log("Allowed origins:", ALLOW_ORIGINS.join(", ") || "*");
  if (mailer) {
    console.log("Email: ON (SMTP_URL detected)");
    console.log("Notify From:", NOTIFY_FROM);
    console.log("Notify To:", NOTIFY_TO.join(", "));
  } else {
    console.log("Email: OFF (missing SMTP_URL/NOTIFY_FROM/NOTIFY_TO)");
  }
});
