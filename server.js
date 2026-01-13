// server.js
// Run: node server.js
// Open: http://localhost:3000
//
// Features:
// - Displays QR code pointing to its own URL (best effort).
// - Unique vote counting per browser/device using a cookie voterId.
// - Nickname + choice (1-5) displayed live to everyone via Socket.IO.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const cookieParser = require("cookie-parser");
const { nanoid } = require("nanoid");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cookieParser());

// --- In-memory "database" (for demo). Replace with Redis/Postgres for production.
const votesByVoterId = new Map(); // voterId -> { nickname, choice, ts }
const countsByChoice = new Map(); // choice -> Set(voterId)
for (let i = 1; i <= 5; i++) countsByChoice.set(String(i), new Set());

function ensureVoterId(req, res) {
  let voterId = req.cookies.voterId;
  if (!voterId) {
    voterId = nanoid(16);
    // cookie is what makes "unique" counting work (per browser/device)
    res.cookie("voterId", voterId, {
      httpOnly: true,
      sameSite: "lax",
      // secure: true, // enable when behind HTTPS
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  return voterId;
}

function computeSummary() {
  const counts = {};
  for (let i = 1; i <= 5; i++) {
    counts[i] = countsByChoice.get(String(i)).size;
  }

  // latest votes list (sorted desc)
  const latest = Array.from(votesByVoterId.entries())
    .map(([voterId, v]) => ({ voterId, ...v }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 200); // limit

  return { counts, latest, uniqueVoters: votesByVoterId.size };
}

function applyVote(voterId, nicknameRaw, choiceRaw) {
  const choice = String(choiceRaw);
  const nickname = String(nicknameRaw || "").trim().slice(0, 24) || "anon";

  if (!["1", "2", "3", "4", "5"].includes(choice)) {
    return { ok: false, error: "Choice must be 1-5." };
  }

  // Remove previous choice membership if any
  const prev = votesByVoterId.get(voterId);
  if (prev && prev.choice && countsByChoice.has(String(prev.choice))) {
    countsByChoice.get(String(prev.choice)).delete(voterId);
  }

  // Add new membership
  countsByChoice.get(choice).add(voterId);

  const record = { nickname, choice, ts: Date.now() };
  votesByVoterId.set(voterId, record);

  return { ok: true, record };
}

// --- Routes

app.get("/", async (req, res) => {
  // Ensure cookie exists for visitors too
  ensureVoterId(req, res);
  res.type("html").send(indexHtml);
});

app.get("/api/state", (req, res) => {
  ensureVoterId(req, res);
  res.json({
    voterId: req.cookies.voterId,
    ...computeSummary(),
  });
});

app.post("/api/vote", (req, res) => {
  const voterId = ensureVoterId(req, res);
  const { nickname, choice } = req.body || {};

  const result = applyVote(voterId, nickname, choice);
  if (!result.ok) return res.status(400).json(result);

  const summary = computeSummary();
  io.emit("state", summary);

  res.json({ ok: true, voterId, ...summary });
});

app.get("/api/qr", async (req, res) => {
  // Best-effort public URL:
  // - If behind reverse proxy, set X-Forwarded-Proto/Host properly.
  // - You can also set PUBLIC_URL env var (recommended for production).
  const publicUrl =
    process.env.PUBLIC_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${
      req.headers["x-forwarded-host"] || req.get("host")
    }/`;

  try {
    const png = await QRCode.toBuffer(publicUrl, {
      type: "png",
      margin: 1,
      scale: 8,
    });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    res.status(500).send("Failed to generate QR.");
  }
});

// --- Socket.IO
io.on("connection", (socket) => {
  socket.emit("state", computeSummary());
});

// --- HTML (single-page)
const indexHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>QR Vote</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; }
    .wrap { display: grid; grid-template-columns: 360px 1fr; gap: 24px; align-items: start; }
    @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; }
    h1 { margin: 0 0 12px; font-size: 20px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    .qr { display: grid; place-items: center; }
    .qr img { width: 280px; height: 280px; image-rendering: pixelated; border-radius: 10px; border: 1px solid #eee; }
    .muted { color: #666; font-size: 13px; }
    .row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
    input[type="text"] { padding: 10px; border-radius: 10px; border: 1px solid #ccc; flex: 1; min-width: 180px; }
    button { padding: 10px 12px; border-radius: 10px; border: 1px solid #ccc; background: #fafafa; cursor: pointer; }
    button:hover { background: #f2f2f2; }
    .choices { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
    .choiceBtn { font-weight: 700; font-size: 16px; padding: 14px 0; }
    .counts { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
    .countBox { text-align: center; padding: 10px; border-radius: 10px; border: 1px solid #eee; background: #fcfcfc; }
    .countNum { font-size: 20px; font-weight: 800; }
    .list { margin-top: 10px; max-height: 420px; overflow: auto; border: 1px solid #eee; border-radius: 10px; }
    .item { display: flex; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
    .item:last-child { border-bottom: none; }
    .badge { font-weight: 800; padding: 4px 10px; border-radius: 999px; border: 1px solid #ddd; background: #fff; }
    .small { font-size: 12px; color: #777; }
    .topline { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>QR Vote</h1>
      <div class="qr">
        <img id="qrImg" src="/api/qr" alt="QR code" />
      </div>
      <p class="muted" id="urlText"></p>

      <h2>Vote (on this device)</h2>
      <div class="row">
        <input id="nick" type="text" placeholder="Nickname (max 24 chars)" maxlength="24" />
        <button id="saveNick">Save</button>
      </div>

      <div class="choices">
        <button class="choiceBtn" data-choice="1">1</button>
        <button class="choiceBtn" data-choice="2">2</button>
        <button class="choiceBtn" data-choice="3">3</button>
        <button class="choiceBtn" data-choice="4">4</button>
        <button class="choiceBtn" data-choice="5">5</button>
      </div>

      <p class="muted" id="status"></p>
    </div>

    <div class="card">
      <div class="topline">
        <h2>Live Results</h2>
        <div class="small" id="uniqueVoters"></div>
      </div>

      <div class="counts" id="counts"></div>

      <h2 style="margin-top:16px;">Latest votes</h2>
      <div class="list" id="latest"></div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const countsEl = document.getElementById('counts');
    const latestEl = document.getElementById('latest');
    const statusEl = document.getElementById('status');
    const nickEl = document.getElementById('nick');
    const urlText = document.getElementById('urlText');
    const uniqueVotersEl = document.getElementById('uniqueVoters');

    // show the URL this page thinks it's on
    urlText.textContent = 'URL: ' + window.location.href;

    // Persist nickname locally too (convenience)
    const savedNick = localStorage.getItem('qrVoteNick');
    if (savedNick) nickEl.value = savedNick;

    document.getElementById('saveNick').addEventListener('click', () => {
      localStorage.setItem('qrVoteNick', nickEl.value.trim().slice(0,24));
      statusEl.textContent = 'Nickname saved.';
      setTimeout(()=> statusEl.textContent = '', 1200);
    });

    function renderState(state) {
      // counts
      countsEl.innerHTML = '';
      for (let i=1; i<=5; i++) {
        const n = (state.counts && state.counts[i]) || 0;
        const box = document.createElement('div');
        box.className = 'countBox';
        box.innerHTML = '<div class="badge">Choice ' + i + '</div>' +
                        '<div class="countNum">' + n + '</div>' +
                        '<div class="small">unique</div>';
        countsEl.appendChild(box);
      }

      uniqueVotersEl.textContent = 'Unique voters: ' + (state.uniqueVoters || 0);

      // latest list
      latestEl.innerHTML = '';
      (state.latest || []).forEach(v => {
        const item = document.createElement('div');
        item.className = 'item';
        const left = document.createElement('div');
        left.innerHTML = '<div><b>' + escapeHtml(v.nickname || 'anon') + '</b></div>' +
                         '<div class="small">' + new Date(v.ts).toLocaleString() + '</div>';
        const right = document.createElement('div');
        right.innerHTML = '<span class="badge">#' + escapeHtml(String(v.choice)) + '</span>';
        item.appendChild(left);
        item.appendChild(right);
        latestEl.appendChild(item);
      });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }

    async function fetchState() {
      const r = await fetch('/api/state');
      const state = await r.json();
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
      statusEl.textContent = 'Voted for ' + choice + ' ✅';
      setTimeout(()=> statusEl.textContent = '', 1200);
      localStorage.setItem('qrVoteNick', nickname);
    }

    document.querySelectorAll('.choiceBtn').forEach(btn => {
      btn.addEventListener('click', () => vote(btn.dataset.choice));
    });

    socket.on('state', (state) => {
      renderState(state);
    });

    fetchState();
  </script>
</body>
</html>`;

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
