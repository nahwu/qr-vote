// server.js
// Run: node server.js
// Open: http://localhost:3000
//
// Features:
// - Shows QR code to its own URL (hidden on mobile).
// - Voting choices 1-5 + nickname, unique per device/browser via cookie voterId.
// - Live results as a responsive bar chart (highlights top bar(s), shows %).
// - Comments with replies (threaded), delete own comment, upvote/downvote.
// - Admin delete any comment via ADMIN_TOKEN (set env var) + token stored locally in browser UI.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const cookieParser = require("cookie-parser");
const { nanoid } = require("nanoid");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // set this in docker-compose env

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cookieParser());

// --- In-memory "database"
const votesByVoterId = new Map(); // voterId -> { nickname, choice, ts }
const countsByChoice = new Map(); // choice -> Set(voterId)
for (let i = 1; i <= 5; i++) countsByChoice.set(String(i), new Set());

// comment = { id, voterId, nickname, text, parentId, createdAt, deleted }
const commentsById = new Map(); // id -> comment
// commentVotes = Map(commentId -> Map(voterId -> -1|+1))
const commentVotes = new Map();

function ensureVoterId(req, res) {
  let voterId = req.cookies.voterId;
  if (!voterId) {
    voterId = nanoid(16);
    res.cookie("voterId", voterId, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 365 * 24 * 60 * 60 * 1000,
      // secure: true, // enable behind HTTPS
    });
  }
  return voterId;
}

function applyVote(voterId, nicknameRaw, choiceRaw) {
  const choice = String(choiceRaw);
  const nickname = String(nicknameRaw || "").trim().slice(0, 24) || "anon";

  if (!["1", "2", "3", "4", "5"].includes(choice)) {
    return { ok: false, error: "Choice must be 1-5." };
  }

  const prev = votesByVoterId.get(voterId);
  if (prev?.choice && countsByChoice.has(String(prev.choice))) {
    countsByChoice.get(String(prev.choice)).delete(voterId);
  }

  countsByChoice.get(choice).add(voterId);
  votesByVoterId.set(voterId, { nickname, choice, ts: Date.now() });

  return { ok: true };
}

function computeVoteSummary() {
  const counts = {};
  for (let i = 1; i <= 5; i++) counts[i] = countsByChoice.get(String(i)).size;

  const latest = Array.from(votesByVoterId.entries())
    .map(([voterId, v]) => ({ voterId, ...v }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 200);

  return { counts, latest, uniqueVoters: votesByVoterId.size };
}

function getCommentScore(commentId) {
  const m = commentVotes.get(commentId);
  if (!m) return 0;
  let score = 0;
  for (const v of m.values()) score += v;
  return score;
}

function getMyVote(commentId, voterId) {
  const m = commentVotes.get(commentId);
  if (!m) return 0;
  return m.get(voterId) || 0;
}

function buildCommentListForClient(voterId) {
  return Array.from(commentsById.values())
    .map((c) => ({
      id: c.id,
      parentId: c.parentId || null,
      nickname: c.nickname,
      text: c.deleted ? "[deleted]" : c.text,
      deleted: !!c.deleted,
      createdAt: c.createdAt,
      score: getCommentScore(c.id),
      mine: c.voterId === voterId,
      myVote: getMyVote(c.id, voterId),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function computeState(voterId) {
  return {
    ...computeVoteSummary(),
    comments: buildCommentListForClient(voterId),
  };
}

function broadcastPoke() {
  io.emit("poke");
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    res.status(500).json({ ok: false, error: "ADMIN_TOKEN not set on server." });
    return true;
  }
  const token = req.headers["x-admin-token"] || req.query.token;
  if (!token || String(token) !== String(ADMIN_TOKEN)) {
    res.status(403).json({ ok: false, error: "Admin auth failed." });
    return true;
  }
  return false;
}

// --- Routes

app.get("/", (req, res) => {
  ensureVoterId(req, res);
  res.type("html").send(indexHtml);
});

app.get("/api/state", (req, res) => {
  const voterId = ensureVoterId(req, res);
  res.json({ voterId, ...computeState(voterId) });
});

app.post("/api/vote", (req, res) => {
  const voterId = ensureVoterId(req, res);
  const { nickname, choice } = req.body || {};

  const result = applyVote(voterId, nickname, choice);
  if (!result.ok) return res.status(400).json(result);

  broadcastPoke();
  res.json({ ok: true, voterId, ...computeState(voterId) });
});

app.get("/api/qr", async (req, res) => {
  const publicUrl =
    process.env.PUBLIC_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${
      req.headers["x-forwarded-host"] || req.get("host")
    }/`;

  try {
    const png = await QRCode.toBuffer(publicUrl, { type: "png", margin: 1, scale: 8 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch {
    res.status(500).send("Failed to generate QR.");
  }
});

// --- Comments API

app.post("/api/comments", (req, res) => {
  const voterId = ensureVoterId(req, res);
  const { nickname, text, parentId } = req.body || {};

  const nick = String(nickname || "").trim().slice(0, 24) || "anon";
  const t = String(text || "").trim().slice(0, 500);
  if (!t) return res.status(400).json({ ok: false, error: "Comment cannot be empty." });

  if (parentId) {
    const p = commentsById.get(String(parentId));
    if (!p) return res.status(400).json({ ok: false, error: "Parent comment not found." });
  }

  const id = nanoid(10);
  commentsById.set(id, {
    id,
    voterId,
    nickname: nick,
    text: t,
    parentId: parentId ? String(parentId) : null,
    createdAt: Date.now(),
    deleted: false,
  });

  broadcastPoke();
  res.json({ ok: true, voterId, ...computeState(voterId) });
});

app.delete("/api/comments/:id", (req, res) => {
  const voterId = ensureVoterId(req, res);
  const id = String(req.params.id);

  const c = commentsById.get(id);
  if (!c) return res.status(404).json({ ok: false, error: "Comment not found." });

  if (c.voterId !== voterId) {
    return res.status(403).json({ ok: false, error: "You can only delete your own comment." });
  }

  // soft delete
  c.deleted = true;
  c.text = "";
  commentsById.set(id, c);

  broadcastPoke();
  res.json({ ok: true, voterId, ...computeState(voterId) });
});

// Admin soft delete any comment
app.delete("/api/admin/comments/:id", (req, res) => {
  if (requireAdmin(req, res)) return;

  const voterId = ensureVoterId(req, res);
  const id = String(req.params.id);

  const c = commentsById.get(id);
  if (!c) return res.status(404).json({ ok: false, error: "Comment not found." });

  c.deleted = true;
  c.text = "";
  commentsById.set(id, c);

  broadcastPoke();
  res.json({ ok: true, voterId, ...computeState(voterId) });
});

app.post("/api/comments/:id/vote", (req, res) => {
  const voterId = ensureVoterId(req, res);
  const id = String(req.params.id);

  const c = commentsById.get(id);
  if (!c) return res.status(404).json({ ok: false, error: "Comment not found." });

  const delta = Number(req.body?.delta);
  if (![1, -1, 0].includes(delta)) {
    return res.status(400).json({ ok: false, error: "delta must be 1, -1, or 0." });
  }

  if (!commentVotes.has(id)) commentVotes.set(id, new Map());
  const m = commentVotes.get(id);

  if (delta === 0) m.delete(voterId);
  else m.set(voterId, delta);

  broadcastPoke();
  res.json({ ok: true, voterId, ...computeState(voterId) });
});

// --- Socket.IO
io.on("connection", (socket) => {
  socket.emit("poke");
});

// --- HTML (single page)
const indexHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>QR Vote</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; }
    .wrap { display: grid; grid-template-columns: 360px 1fr; gap: 24px; align-items: start; }
    @media (max-width: 900px) { body { margin: 14px; } .wrap { grid-template-columns: 1fr; } }

    .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; background: #fff; }
    h1 { margin: 0 0 12px; font-size: 20px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    .muted { color: #666; font-size: 13px; }
    .small { font-size: 12px; color: #777; }
    .row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; align-items: center; }

    input[type="text"], input[type="password"], textarea {
      padding: 10px; border-radius: 10px; border: 1px solid #ccc; flex: 1; min-width: 180px;
      font-family: inherit;
    }
    textarea { width: 100%; min-width: 0; resize: vertical; }

    button { padding: 10px 12px; border-radius: 10px; border: 1px solid #ccc; background: #fafafa; cursor: pointer; }
    button:hover { background: #f2f2f2; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    .qr { display: grid; place-items: center; }
    .qr img { width: 280px; height: 280px; image-rendering: pixelated; border-radius: 10px; border: 1px solid #eee; }

    /* Hide QR on mobile */
    @media (max-width: 900px) { .qrCard { display: none; } }

    .choices { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
    .choiceBtn { font-weight: 800; font-size: 16px; padding: 14px 0; }

    .topline { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }

    .list { margin-top: 10px; max-height: 260px; overflow: auto; border: 1px solid #eee; border-radius: 12px; background: #fff; }
    .item { display: flex; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
    .item:last-child { border-bottom: none; }

    .badge { font-weight: 800; padding: 4px 10px; border-radius: 999px; border: 1px solid #ddd; background: #fff; }

    /* Chart */
    .chartWrap { border: 1px solid #eee; border-radius: 14px; padding: 10px; background: #fcfcfc; }
    canvas { width: 100%; height: 220px; display: block; }
    @media (max-width: 900px) { canvas { height: 200px; } }
    @media (max-width: 420px) { canvas { height: 180px; } }

    /* Admin UI */
    .adminBox {
      border: 1px solid #eee;
      border-radius: 12px;
      padding: 10px 12px;
      background: #fcfcfc;
      margin: 8px 0 12px;
    }
    .adminSummary {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      list-style: none;
      user-select: none;
    }
    .adminBox summary::-webkit-details-marker { display: none; }
    .adminPill {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid #ddd;
      background: #fff;
      font-weight: 800;
      font-size: 13px;
    }
    .adminInner { margin-top: 10px; }
    .adminField { display: grid; gap: 8px; }
    .adminLabel { font-size: 12px; color: #555; font-weight: 700; }
    .adminInputWrap { display: grid; grid-template-columns: 1fr 44px; gap: 8px; }
    .iconBtn {
      border-radius: 10px;
      border: 1px solid #ccc;
      background: #fff;
      cursor: pointer;
      padding: 10px 0;
    }
    .iconBtn:hover { background: #f3f3f3; }
    .adminActions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .dangerBtn { border-color: #f1c0c0; background: #fff6f6; }
    .dangerBtn:hover { background: #ffecec; }
    .adminHint { margin-top: 8px; }

    /* Comments polish */
    .comments {
      margin-top: 10px;
      border: 1px solid #eee;
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
    }
    .comment { padding: 12px 12px; border-bottom: 1px solid #f1f1f1; }
    .comment:last-child { border-bottom: none; }

    .commentHead {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .commentMeta {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .commentText {
      margin-top: 8px;
      font-size: 14px;
      color: #222;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .commentText.muted { color: #777; }

    .commentActions {
      margin-top: 10px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .actionBtn {
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid #ddd;
      background: #fff;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
    }
    .actionBtn:hover { background: #f6f6f6; }

    .voteGroup {
      display: inline-flex;
      border: 1px solid #ddd;
      border-radius: 999px;
      overflow: hidden;
      background: #fff;
    }
    .voteBtn {
      padding: 6px 10px;
      border: none;
      background: transparent;
      cursor: pointer;
      font-weight: 800;
      font-size: 13px;
    }
    .voteBtn:hover { background: #f6f6f6; }
    .voteBtn.active { background: #eef6ff; }

    .scorePill {
      padding: 6px 10px;
      border-left: 1px solid #ddd;
      border-right: 1px solid #ddd;
      background: #fafafa;
      font-weight: 800;
      font-size: 13px;
      display: inline-flex;
      align-items: center;
    }

    .indent {
      margin-left: 14px;
      border-left: 2px solid #f0f0f0;
      padding-left: 10px;
    }
    @media (max-width: 900px) {
      .indent { margin-left: 10px; }
      .comment { padding: 12px 10px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card qrCard">
      <h1>QR Vote</h1>
      <div class="qr">
        <img id="qrImg" src="/api/qr" alt="QR code" />
      </div>
      <p class="muted" id="urlText"></p>
    </div>

    <div class="card">
      <h1>Vote</h1>
      <p class="muted">On mobile, scan the QR from a laptop/TV screen. (QR is hidden on mobile view.)</p>

      <div class="row">
        <input id="nick" type="text" placeholder="Nickname (max 24 chars)" maxlength="24" />
        <button id="saveNick" type="button">Save</button>
      </div>

      <div class="choices">
        <button class="choiceBtn" data-choice="1" type="button">1</button>
        <button class="choiceBtn" data-choice="2" type="button">2</button>
        <button class="choiceBtn" data-choice="3" type="button">3</button>
        <button class="choiceBtn" data-choice="4" type="button">4</button>
        <button class="choiceBtn" data-choice="5" type="button">5</button>
      </div>

      <p class="muted" id="status"></p>

      <hr style="border:none;border-top:1px solid #eee;margin:16px 0;" />

      <div class="topline">
        <h2>Live Results</h2>
        <div class="small" id="uniqueVoters"></div>
      </div>

      <div class="chartWrap">
        <canvas id="resultsChart"></canvas>
        <div class="small muted" id="chartHint" style="margin-top:6px;"></div>
      </div>

      <h2 style="margin-top:16px;">Latest votes</h2>
      <div class="list" id="latest"></div>
    </div>

    <div class="card">
      <div class="topline">
        <h2>Comments</h2>
        <div class="small muted">Reply, vote, delete your own. Admin can moderate.</div>
      </div>

      <details class="adminBox">
        <summary class="adminSummary">
          <span class="adminPill">Admin</span>
          <span class="muted">Moderator controls</span>
        </summary>

        <div class="adminInner">
          <div class="adminField">
            <label class="adminLabel" for="adminToken">Admin token</label>

            <div class="adminInputWrap">
              <input id="adminToken" type="password" placeholder="Enter admin token" autocomplete="off" />
              <button id="toggleAdminToken" class="iconBtn" type="button" aria-label="Show/Hide token">👁</button>
            </div>

            <div class="adminActions">
              <button id="saveAdminToken" type="button">Save</button>
              <button id="clearAdminToken" type="button" class="dangerBtn">Clear</button>
              <span class="small muted" id="adminStatus"></span>
            </div>
          </div>

          <div class="small muted adminHint">
            Tip: token is stored only in this browser (localStorage).
          </div>
        </div>
      </details>

      <textarea id="commentText" rows="3" placeholder="Write a comment... (max 500 chars)"></textarea>
      <div class="row">
        <button id="postComment" type="button">Post</button>
        <button id="cancelReply" type="button" style="display:none;">Cancel reply</button>
        <span class="muted" id="replyingTo"></span>
      </div>

      <div class="comments" id="comments"></div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();

    const latestEl = document.getElementById('latest');
    const statusEl = document.getElementById('status');
    const nickEl = document.getElementById('nick');
    const urlText = document.getElementById('urlText');
    const uniqueVotersEl = document.getElementById('uniqueVoters');

    const chartCanvas = document.getElementById('resultsChart');
    const chartHint = document.getElementById('chartHint');

    const adminTokenEl = document.getElementById('adminToken');
    const toggleAdminTokenBtn = document.getElementById('toggleAdminToken');
    const adminStatusEl = document.getElementById('adminStatus');

    const saveAdminTokenBtn = document.getElementById('saveAdminToken');
    const clearAdminTokenBtn = document.getElementById('clearAdminToken');

    const commentTextEl = document.getElementById('commentText');
    const postCommentBtn = document.getElementById('postComment');
    const cancelReplyBtn = document.getElementById('cancelReply');
    const replyingToEl = document.getElementById('replyingTo');
    const commentsEl = document.getElementById('comments');

    urlText.textContent = 'URL: ' + window.location.href;

    const savedNick = localStorage.getItem('qrVoteNick');
    if (savedNick) nickEl.value = savedNick;

    const savedAdminToken = localStorage.getItem('qrVoteAdminToken') || '';
    adminTokenEl.value = savedAdminToken;

    toggleAdminTokenBtn.onclick = () => {
      adminTokenEl.type = (adminTokenEl.type === 'password') ? 'text' : 'password';
      toggleAdminTokenBtn.textContent = (adminTokenEl.type === 'password') ? '👁' : '🙈';
    };

    saveAdminTokenBtn.onclick = () => {
      localStorage.setItem('qrVoteAdminToken', adminTokenEl.value.trim());
      adminStatusEl.textContent = 'Saved.';
      setTimeout(() => adminStatusEl.textContent = '', 1500);
      statusEl.textContent = 'Admin token saved (local only).';
      setTimeout(()=> statusEl.textContent = '', 1200);
    };

    clearAdminTokenBtn.onclick = () => {
      adminTokenEl.value = '';
      localStorage.removeItem('qrVoteAdminToken');
      adminStatusEl.textContent = 'Cleared.';
      setTimeout(() => adminStatusEl.textContent = '', 1500);
      statusEl.textContent = 'Admin token cleared.';
      setTimeout(()=> statusEl.textContent = '', 1200);
    };

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }

    document.getElementById('saveNick').addEventListener('click', () => {
      localStorage.setItem('qrVoteNick', nickEl.value.trim().slice(0,24));
      statusEl.textContent = 'Nickname saved.';
      setTimeout(()=> statusEl.textContent = '', 1200);
    });

    let state = null;
    let replyParentId = null;

    async function fetchState() {
      const r = await fetch('/api/state');
      state = await r.json();
      renderState(state);
    }

    async function vote(choice) {
      const nickname = (nickEl.value || '').trim().slice(0,24);
      const r = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, choice })
      });
      if (!r.ok) {
        const e = await r.json().catch(()=>({error:'Vote failed'}));
        statusEl.textContent = e.error || 'Vote failed';
        return;
      }
      state = await r.json();
      renderState(state);
      statusEl.textContent = 'Voted for ' + choice + ' ✅';
      setTimeout(()=> statusEl.textContent = '', 1200);
      localStorage.setItem('qrVoteNick', nickname);
    }

    document.querySelectorAll('.choiceBtn').forEach(btn => {
      btn.addEventListener('click', () => vote(btn.dataset.choice));
    });

    // Pretty chart: highlight top bar(s), show %; NO backticks (safe inside indexHtml)
    function drawBarChart(counts, uniqueVoters) {
      const ctx = chartCanvas.getContext("2d");

      const dpr = window.devicePixelRatio || 1;
      const cssWidth = chartCanvas.clientWidth || 300;
      const cssHeight = chartCanvas.clientHeight || 200;
      chartCanvas.width = Math.max(1, Math.floor(cssWidth * dpr));
      chartCanvas.height = Math.max(1, Math.floor(cssHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = cssWidth, h = cssHeight;
      ctx.clearRect(0, 0, w, h);

      const values = [1,2,3,4,5].map(i => (counts && counts[i]) ? counts[i] : 0);
      const maxVal = Math.max(1, ...values);
      const peak = Math.max(...values);
      const maxIndices = values
        .map((v, idx) => ({ v, idx }))
        .filter(x => x.v === peak)
        .map(x => x.idx);

      const total = Math.max(0, uniqueVoters || 0);

      const padX = 16;
      const headerH = 26;
      const footerH = 26;
      const top = 10 + headerH;
      const bottom = footerH + 10;
      const chartH = h - top - bottom;
      const x0 = padX;
      const y0 = top + chartH;
      const chartW = w - padX * 2;

      const bg = "#ffffff";
      const grid = "#f0f0f0";
      const text = "#333333";
      const subtle = "#666666";
      const bar = "#e9e9e9";
      const barBorder = "#d6d6d6";
      const highlight = "#dbeafe";
      const highlightBorder = "#93c5fd";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // header
      ctx.fillStyle = text;
      ctx.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("Unique voters: " + total, x0, 18);

      // grid lines
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (let k = 0; k <= 3; k++) {
        const gy = top + (chartH * k) / 3;
        ctx.beginPath();
        ctx.moveTo(x0, gy);
        ctx.lineTo(x0 + chartW, gy);
        ctx.stroke();
      }

      const gap = 10;
      const barW = (chartW - gap * 4) / 5;

      function roundRect(x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height - r);
        ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
        ctx.lineTo(x + r, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      }

      values.forEach((v, idx) => {
        const x = x0 + idx * (barW + gap);
        const bh = (v / maxVal) * (chartH - 10);
        const y = y0 - bh;
        const isMax = maxIndices.includes(idx);

        ctx.fillStyle = isMax ? highlight : bar;
        roundRect(x, y, barW, bh, 10);
        ctx.fill();

        ctx.strokeStyle = isMax ? highlightBorder : barBorder;
        ctx.lineWidth = 1.25;
        ctx.stroke();

        const pct = total > 0 ? Math.round((v / total) * 100) : 0;
        const label = total > 0 ? (String(v) + " (" + pct + "%)") : String(v);

        ctx.fillStyle = text;
        ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.textAlign = "center";
        const labelY = Math.max(top + 12, y - 8);
        ctx.fillText(label, x + barW / 2, labelY);

        ctx.fillStyle = subtle;
        ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.fillText(String(idx + 1), x + barW / 2, h - 10);
      });

      if (peak > 0) {
        const topChoices = maxIndices.map(i => String(i + 1)).join(", ");
        chartHint.textContent = "Top choice: " + topChoices + " • Votes: " + peak;
      } else {
        chartHint.textContent = "No votes yet";
      }
    }

    const ro = new ResizeObserver(() => {
      if (state) drawBarChart(state.counts, state.uniqueVoters);
    });
    ro.observe(chartCanvas);

    function renderState(s) {
      uniqueVotersEl.textContent = 'Unique voters: ' + (s.uniqueVoters || 0);
      drawBarChart(s.counts, s.uniqueVoters);

      // latest votes
      latestEl.innerHTML = '';
      (s.latest || []).forEach(v => {
        const item = document.createElement('div');
        item.className = 'item';

        const left = document.createElement('div');
        left.innerHTML =
          '<div><b>' + escapeHtml(v.nickname || 'anon') + '</b></div>' +
          '<div class="small">' + new Date(v.ts).toLocaleString() + '</div>';

        const right = document.createElement('div');
        right.innerHTML = '<span class="badge">#' + escapeHtml(String(v.choice)) + '</span>';

        item.appendChild(left);
        item.appendChild(right);
        latestEl.appendChild(item);
      });

      renderComments(s.comments || []);
    }

    // --- Comments (threaded)
    function renderComments(comments) {
      const children = new Map();
      comments.forEach(c => {
        const p = c.parentId || null;
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(c);
      });

      function sortArr(arr) {
        arr.sort((a,b) => (b.score - a.score) || (a.createdAt - b.createdAt));
        return arr;
      }

      commentsEl.innerHTML = '';
      const roots = sortArr(children.get(null) || []);
      roots.forEach(root => commentsEl.appendChild(renderCommentNode(root, children, 0)));

      if (roots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'comment';
        empty.innerHTML = '<div class="muted">No comments yet. Be the first 🙂</div>';
        commentsEl.appendChild(empty);
      }
    }

    function renderCommentNode(c, children, depth) {
      const wrap = document.createElement('div');
      wrap.className = 'comment' + (depth > 0 ? ' indent' : '');

      const mine = !!c.mine;
      const deleted = !!c.deleted;
      const isAdmin = !!(localStorage.getItem('qrVoteAdminToken') || '').trim();

      const head = document.createElement('div');
      head.className = 'commentHead';

      const meta = document.createElement('div');
      meta.className = 'commentMeta';
      meta.innerHTML =
        '<span class="badge">' + escapeHtml(c.nickname || 'anon') + (mine ? ' (you)' : '') + '</span>' +
        '<span class="small">' + new Date(c.createdAt).toLocaleString() + '</span>';

      head.appendChild(meta);

      const text = document.createElement('div');
      text.className = 'commentText' + (deleted ? ' muted' : '');
      text.innerHTML = deleted ? '<i>' + escapeHtml(c.text) + '</i>' : escapeHtml(c.text);

      const actions = document.createElement('div');
      actions.className = 'commentActions';

      // Vote group: ▲ score ▼
      const voteGroup = document.createElement('div');
      voteGroup.className = 'voteGroup';

      const upBtn = document.createElement('button');
      upBtn.className = 'voteBtn' + (c.myVote === 1 ? ' active' : '');
      upBtn.type = 'button';
      upBtn.textContent = '▲';
      upBtn.disabled = deleted;
      upBtn.onclick = () => voteOnComment(c.id, c.myVote === 1 ? 0 : 1);

      const scoreSpan = document.createElement('div');
      scoreSpan.className = 'scorePill';
      scoreSpan.textContent = String(c.score || 0);

      const downBtn = document.createElement('button');
      downBtn.className = 'voteBtn' + (c.myVote === -1 ? ' active' : '');
      downBtn.type = 'button';
      downBtn.textContent = '▼';
      downBtn.disabled = deleted;
      downBtn.onclick = () => voteOnComment(c.id, c.myVote === -1 ? 0 : -1);

      voteGroup.appendChild(upBtn);
      voteGroup.appendChild(scoreSpan);
      voteGroup.appendChild(downBtn);

      const replyBtn = document.createElement('button');
      replyBtn.className = 'actionBtn';
      replyBtn.type = 'button';
      replyBtn.textContent = 'Reply';
      replyBtn.disabled = deleted;
      replyBtn.onclick = () => startReply(c.id, c.nickname);

      actions.appendChild(voteGroup);
      actions.appendChild(replyBtn);

      if (mine) {
        const delBtn = document.createElement('button');
        delBtn.className = 'actionBtn dangerBtn';
        delBtn.type = 'button';
        delBtn.textContent = 'Delete';
        delBtn.onclick = () => deleteComment(c.id);
        actions.appendChild(delBtn);
      }

      if (isAdmin) {
        const adminDelBtn = document.createElement('button');
        adminDelBtn.className = 'actionBtn dangerBtn';
        adminDelBtn.type = 'button';
        adminDelBtn.textContent = 'Admin delete';
        adminDelBtn.onclick = () => adminDeleteComment(c.id);
        actions.appendChild(adminDelBtn);
      }

      wrap.appendChild(head);
      wrap.appendChild(text);
      wrap.appendChild(actions);

      const kids = children.get(c.id) || [];
      kids.sort((a,b) => (b.score - a.score) || (a.createdAt - b.createdAt));
      kids.forEach(k => wrap.appendChild(renderCommentNode(k, children, depth + 1)));

      return wrap;
    }

    function startReply(parentId, nickname) {
      replyParentId = parentId;
      cancelReplyBtn.style.display = '';
      replyingToEl.textContent = 'Replying to ' + nickname;
      commentTextEl.focus();
    }

    cancelReplyBtn.onclick = () => {
      replyParentId = null;
      cancelReplyBtn.style.display = 'none';
      replyingToEl.textContent = '';
    };

    async function postComment() {
      const nickname = (nickEl.value || '').trim().slice(0,24) || 'anon';
      const text = (commentTextEl.value || '').trim().slice(0, 500);

      if (!text) {
        statusEl.textContent = 'Comment cannot be empty.';
        setTimeout(()=> statusEl.textContent = '', 1200);
        return;
      }

      const r = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, text, parentId: replyParentId })
      });

      const j = await r.json().catch(()=>null);
      if (!r.ok) {
        statusEl.textContent = (j && j.error) ? j.error : 'Failed to post comment';
        return;
      }

      localStorage.setItem('qrVoteNick', nickname);
      commentTextEl.value = '';
      cancelReplyBtn.click();
      state = j;
      renderState(state);
    }

    postCommentBtn.onclick = postComment;

    async function deleteComment(id) {
      const r = await fetch('/api/comments/' + encodeURIComponent(id), { method: 'DELETE' });
      const j = await r.json().catch(()=>null);
      if (!r.ok) {
        statusEl.textContent = (j && j.error) ? j.error : 'Delete failed';
        return;
      }
      state = j;
      renderState(state);
    }

    async function adminDeleteComment(id) {
      const token = (localStorage.getItem('qrVoteAdminToken') || '').trim();
      if (!token) {
        statusEl.textContent = 'No admin token saved.';
        return;
      }
      const r = await fetch('/api/admin/comments/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'x-admin-token': token }
      });
      const j = await r.json().catch(()=>null);
      if (!r.ok) {
        statusEl.textContent = (j && j.error) ? j.error : 'Admin delete failed';
        return;
      }
      state = j;
      renderState(state);
    }

    async function voteOnComment(id, delta) {
      const r = await fetch('/api/comments/' + encodeURIComponent(id) + '/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta })
      });
      const j = await r.json().catch(()=>null);
      if (!r.ok) {
        statusEl.textContent = (j && j.error) ? j.error : 'Vote failed';
        return;
      }
      state = j;
      renderState(state);
    }

    socket.on('poke', () => fetchState());
    fetchState();
  </script>
</body>
</html>`;

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
