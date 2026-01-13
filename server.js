// server.js
// Run: node server.js
// Open: http://localhost:3000
//
// Changes added:
// 1) Hide QR on mobile
// 2) More mobile-friendly live results
// 3) Comments: add + delete own
// 4) Upvote/downvote comments (unique per voter)
// 5) Replies to comments (threaded)

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

// --- In-memory "database"
const votesByVoterId = new Map(); // voterId -> { nickname, choice, ts }
const countsByChoice = new Map(); // choice -> Set(voterId)
for (let i = 1; i <= 5; i++) countsByChoice.set(String(i), new Set());

// Comments:
// comment = { id, voterId, nickname, text, parentId, createdAt, deleted }
const commentsById = new Map(); // id -> comment
// Votes on comments:
// commentVotes = Map(commentId -> Map(voterId -> -1|0|+1))
const commentVotes = new Map();

function ensureVoterId(req, res) {
  let voterId = req.cookies.voterId;
  if (!voterId) {
    voterId = nanoid(16);
    res.cookie("voterId", voterId, {
      httpOnly: true,
      sameSite: "lax",
      // secure: true, // enable behind HTTPS
      maxAge: 365 * 24 * 60 * 60 * 1000,
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
  const record = { nickname, choice, ts: Date.now() };
  votesByVoterId.set(voterId, record);

  return { ok: true, record };
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

function buildCommentTreeForClient(voterId) {
  // Flatten -> client can render threaded, but we also provide parentId
  const items = Array.from(commentsById.values())
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

  return items;
}

function computeState(voterId) {
  return {
    ...computeVoteSummary(),
    comments: buildCommentTreeForClient(voterId),
  };
}

function broadcastState() {
  // Broadcast a generic state without per-user fields like "mine"/"myVote"
  // We'll compute per-socket on demand when they connect or request refresh.
  // For simplicity: emit a "poke" so clients re-fetch /api/state.
  io.emit("poke");
}

// --- Routes

app.get("/", (req, res) => {
  ensureVoterId(req, res);
  res.type("html").send(indexHtml);
});

app.get("/api/state", (req, res) => {
  const voterId = ensureVoterId(req, res);
  res.json({
    voterId,
    ...computeState(voterId),
  });
});

app.post("/api/vote", (req, res) => {
  const voterId = ensureVoterId(req, res);
  const { nickname, choice } = req.body || {};

  const result = applyVote(voterId, nickname, choice);
  if (!result.ok) return res.status(400).json(result);

  broadcastState();
  res.json({ ok: true, voterId, ...computeState(voterId) });
});

app.get("/api/qr", async (req, res) => {
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

  // parentId optional; if provided, must exist and not be deleted entirely
  if (parentId) {
    const p = commentsById.get(String(parentId));
    if (!p) return res.status(400).json({ ok: false, error: "Parent comment not found." });
  }

  const id = nanoid(10);
  const c = {
    id,
    voterId,
    nickname: nick,
    text: t,
    parentId: parentId ? String(parentId) : null,
    createdAt: Date.now(),
    deleted: false,
  };
  commentsById.set(id, c);

  broadcastState();
  res.json({ ok: true, ...computeState(voterId) });
});

app.delete("/api/comments/:id", (req, res) => {
  const voterId = ensureVoterId(req, res);
  const id = String(req.params.id);
  const c = commentsById.get(id);
  if (!c) return res.status(404).json({ ok: false, error: "Comment not found." });

  if (c.voterId !== voterId) {
    return res.status(403).json({ ok: false, error: "You can only delete your own comment." });
  }

  // Soft-delete so replies don't break the thread
  c.deleted = true;
  c.text = "";
  commentsById.set(id, c);

  broadcastState();
  res.json({ ok: true, ...computeState(voterId) });
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

  broadcastState();
  res.json({ ok: true, ...computeState(voterId) });
});

// --- Socket.IO
io.on("connection", (socket) => {
  socket.emit("poke");
});

// --- HTML
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

    .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; }
    h1 { margin: 0 0 12px; font-size: 20px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    .muted { color: #666; font-size: 13px; }
    .small { font-size: 12px; color: #777; }
    .row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }

    input[type="text"], textarea {
      padding: 10px; border-radius: 10px; border: 1px solid #ccc; flex: 1; min-width: 180px;
      font-family: inherit;
    }
    textarea { width: 100%; min-width: 0; resize: vertical; }

    button { padding: 10px 12px; border-radius: 10px; border: 1px solid #ccc; background: #fafafa; cursor: pointer; }
    button:hover { background: #f2f2f2; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    .qr { display: grid; place-items: center; }
    .qr img { width: 280px; height: 280px; image-rendering: pixelated; border-radius: 10px; border: 1px solid #eee; }

    /* 1) Hide QR on mobile */
    @media (max-width: 900px) {
      .qrCard { display: none; }
      .wrap { grid-template-columns: 1fr; }
    }

    .choices { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
    .choiceBtn { font-weight: 700; font-size: 16px; padding: 14px 0; }

    /* 2) Mobile-friendly results counts grid */
    .counts { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
    @media (max-width: 900px) {
      .counts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 420px) {
      .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    .countBox { text-align: center; padding: 10px; border-radius: 10px; border: 1px solid #eee; background: #fcfcfc; }
    .countNum { font-size: 20px; font-weight: 800; }
    .badge { font-weight: 800; padding: 4px 10px; border-radius: 999px; border: 1px solid #ddd; background: #fff; }

    .topline { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }

    .list { margin-top: 10px; max-height: 340px; overflow: auto; border: 1px solid #eee; border-radius: 10px; }
    .item { display: flex; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
    .item:last-child { border-bottom: none; }

    /* Comments */
    .comments { margin-top: 10px; border: 1px solid #eee; border-radius: 10px; overflow: hidden; }
    .comment { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
    .comment:last-child { border-bottom: none; }
    .commentHead { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
    .commentMeta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .commentText { margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
    .commentActions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
    .pill { padding: 6px 10px; border-radius: 999px; border: 1px solid #ddd; background: #fff; font-weight: 700; font-size: 13px; }
    .indent { margin-left: 18px; border-left: 2px solid #f0f0f0; padding-left: 10px; }
    .danger { border-color: #f1c0c0; background: #fff6f6; }
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
      <p class="muted">On mobile, scan the QR from a laptop/TV screen. On mobile view, the QR is hidden.</p>

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

      <hr style="border:none;border-top:1px solid #eee;margin:16px 0;" />

      <div class="topline">
        <h2>Live Results</h2>
        <div class="small" id="uniqueVoters"></div>
      </div>

      <div class="counts" id="counts"></div>

      <h2 style="margin-top:16px;">Latest votes</h2>
      <div class="list" id="latest"></div>
    </div>

    <div class="card">
      <div class="topline">
        <h2>Comments</h2>
        <div class="small">You can delete your own comments.</div>
      </div>

      <textarea id="commentText" rows="3" placeholder="Write a comment... (max 500 chars)"></textarea>
      <div class="row">
        <button id="postComment">Post comment</button>
        <button id="cancelReply" style="display:none;">Cancel reply</button>
        <span class="muted" id="replyingTo" style="align-self:center;"></span>
      </div>

      <div class="comments" id="comments"></div>
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

    const commentTextEl = document.getElementById('commentText');
    const postCommentBtn = document.getElementById('postComment');
    const cancelReplyBtn = document.getElementById('cancelReply');
    const replyingToEl = document.getElementById('replyingTo');
    const commentsEl = document.getElementById('comments');

    urlText.textContent = 'URL: ' + window.location.href;

    const savedNick = localStorage.getItem('qrVoteNick');
    if (savedNick) nickEl.value = savedNick;

    let state = null;
    let replyParentId = null;

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

    function renderState(s) {
      // counts
      countsEl.innerHTML = '';
      for (let i=1; i<=5; i++) {
        const n = (s.counts && s.counts[i]) || 0;
        const box = document.createElement('div');
        box.className = 'countBox';
        box.innerHTML =
          '<div class="badge">Choice ' + i + '</div>' +
          '<div class="countNum">' + n + '</div>' +
          '<div class="small">unique</div>';
        countsEl.appendChild(box);
      }
      uniqueVotersEl.textContent = 'Unique voters: ' + (s.uniqueVoters || 0);

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

    // --- Comments rendering (threaded)
    function renderComments(comments) {
      // build children map
      const byId = new Map(comments.map(c => [c.id, c]));
      const children = new Map();
      comments.forEach(c => {
        const p = c.parentId || null;
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(c);
      });

      function sortChildren(arr) {
        // sort by score desc, then time asc (feel free to tweak)
        arr.sort((a,b) => (b.score - a.score) || (a.createdAt - b.createdAt));
        return arr;
      }

      commentsEl.innerHTML = '';
      const roots = sortChildren(children.get(null) || []);

      roots.forEach(root => {
        commentsEl.appendChild(renderCommentNode(root, children, 0));
      });

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

      const head = document.createElement('div');
      head.className = 'commentHead';

      const meta = document.createElement('div');
      meta.className = 'commentMeta';
      meta.innerHTML =
        '<span class="badge">' + escapeHtml(c.nickname || 'anon') + '</span>' +
        '<span class="small">' + new Date(c.createdAt).toLocaleString() + '</span>' +
        '<span class="pill">Score: ' + (c.score || 0) + '</span>';

      const right = document.createElement('div');
      right.innerHTML = '<span class="small">' + (mine ? 'you' : '') + '</span>';

      head.appendChild(meta);
      head.appendChild(right);

      const text = document.createElement('div');
      text.className = 'commentText muted';
      text.innerHTML = deleted
        ? '<i>' + escapeHtml(c.text) + '</i>'
        : escapeHtml(c.text);

      const actions = document.createElement('div');
      actions.className = 'commentActions';

      const upBtn = document.createElement('button');
      upBtn.className = 'pill';
      upBtn.textContent = (c.myVote === 1 ? '▲ Upvoted' : '▲ Upvote');
      upBtn.disabled = deleted;
      upBtn.onclick = () => voteOnComment(c.id, c.myVote === 1 ? 0 : 1);

      const downBtn = document.createElement('button');
      downBtn.className = 'pill';
      downBtn.textContent = (c.myVote === -1 ? '▼ Downvoted' : '▼ Downvote');
      downBtn.disabled = deleted;
      downBtn.onclick = () => voteOnComment(c.id, c.myVote === -1 ? 0 : -1);

      const replyBtn = document.createElement('button');
      replyBtn.className = 'pill';
      replyBtn.textContent = '↩ Reply';
      replyBtn.disabled = deleted;
      replyBtn.onclick = () => startReply(c.id, c.nickname);

      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(replyBtn);

      if (mine) {
        const delBtn = document.createElement('button');
        delBtn.className = 'pill danger';
        delBtn.textContent = '🗑 Delete';
        delBtn.onclick = () => deleteComment(c.id);
        actions.appendChild(delBtn);
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

    socket.on('poke', () => {
      // server tells everyone to refresh state
      fetchState();
    });

    fetchState();
  </script>
</body>
</html>`;

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
