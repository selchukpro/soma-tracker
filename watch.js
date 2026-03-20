// ── watch.js — room management + multi-skeleton renderer ──

let currentUser    = null;
let currentProfile = null;
let activeRoomId   = null;
let roomChannel    = null;

// members: { userId: { username, keypoints, bodyScore, lastSeen, color } }
const members      = {};
const USER_COLORS  = [
  '#00ffc6','#ff3d6b','#a78bfa','#fbbf24',
  '#38bdf8','#fb923c','#4ade80','#f472b6'
];
let colorIndex = 0;

function assignColor(userId) {
  if (!members[userId]) {
    members[userId] = { color: USER_COLORS[colorIndex % USER_COLORS.length] };
    colorIndex++;
  }
  return members[userId].color;
}

// ── SKELETON CONNECTIONS ──────────────────────
const CONNECTIONS = [
  [0,1],[0,2],[1,3],[2,4],
  [5,6],[5,11],[6,12],[11,12],
  [5,7],[7,9],[6,8],[8,10],
  [11,13],[13,15],[12,14],[14,16]
];

// ── RENDERER ──────────────────────────────────
// canvas + requestAnimationFrame loop
const canvas = document.getElementById('room-canvas');
const ctx    = canvas.getContext('2d');
let renderRunning = false;

function startRenderer() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  renderRunning = true;
  renderLoop();
}
function stopRenderer() { renderRunning = false; }

function resizeCanvas() {
  const stage = document.getElementById('room-stage');
  canvas.width  = stage.offsetWidth;
  canvas.height = stage.offsetHeight;
}

function renderLoop() {
  if (!renderRunning) return;
  requestAnimationFrame(renderLoop);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const now      = Date.now();
  const activeMs = 3000; // hide skeleton after 3s of no data
  let   activeCount = 0;

  const userIds = Object.keys(members);
  if (!userIds.length) return;

  // Lay out skeletons side by side
  const cols    = Math.min(userIds.length, 3);
  const cellW   = canvas.width / cols;
  const cellH   = canvas.height;

  userIds.forEach((uid, idx) => {
    const m = members[uid];
    if (!m.keypoints) return;
    if (now - m.lastSeen > activeMs) return;
    activeCount++;

    const col    = idx % cols;
    const row    = Math.floor(idx / cols);
    const rows   = Math.ceil(userIds.length / cols);
    const cH     = cellH / rows;
    const offX   = col * cellW;
    const offY   = row * cH;
    const scaleX = cellW / 640;
    const scaleY = cH   / 480;

    drawUserSkeleton(m, offX, offY, scaleX, scaleY, cellW, cH);
  });

  // Show/hide empty state
  const empty = document.getElementById('room-empty');
  if (activeCount > 0) empty.classList.add('hidden');
  else                 empty.classList.remove('hidden');

  updateMemberBar();
}

function drawUserSkeleton(m, offX, offY, scaleX, scaleY, cellW, cellH) {
  const kps  = m.keypoints;
  const col  = m.color;
  const C    = 0.25;

  // Scale transform
  const tx = k => offX + k.x * scaleX;
  const ty = k => offY + k.y * scaleY;

  // Fade if stale
  const staleness = Math.max(0, 1 - (Date.now() - m.lastSeen) / 2000);

  ctx.save();
  ctx.globalAlpha = staleness;

  // Connections
  for (const [a, b] of CONNECTIONS) {
    const ka = kps[a], kb = kps[b];
    if (!ka || !kb || ka.s < C || kb.s < C) continue;
    ctx.beginPath();
    ctx.moveTo(tx(ka), ty(ka));
    ctx.lineTo(tx(kb), ty(kb));
    ctx.strokeStyle = col;
    ctx.lineWidth   = Math.max(1.5, 3 * Math.min(scaleX, scaleY));
    ctx.globalAlpha = Math.min(ka.s, kb.s) * staleness;
    ctx.stroke();
  }

  // Joints
  for (let i = 0; i < kps.length; i++) {
    const k = kps[i];
    if (!k || k.s < C) continue;
    const r = Math.max(3, (i === 0 ? 7 : i <= 4 ? 5 : 6) * Math.min(scaleX, scaleY));

    // Glow
    ctx.beginPath(); ctx.arc(tx(k), ty(k), r + 4, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.globalAlpha = k.s * .15 * staleness; ctx.fill();

    // Core
    ctx.beginPath(); ctx.arc(tx(k), ty(k), r, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.globalAlpha = Math.min(1, k.s * 1.2) * staleness; ctx.fill();

    // Inner
    ctx.beginPath(); ctx.arc(tx(k), ty(k), r * .4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.globalAlpha = k.s * .5 * staleness; ctx.fill();
  }

  // Username label
  ctx.globalAlpha = staleness;
  ctx.font = `bold ${Math.max(10, 13 * Math.min(scaleX, scaleY))}px Syne, sans-serif`;
  ctx.fillStyle   = col;
  ctx.textAlign   = 'center';

  // Find head position
  const head = kps[0];
  const labelY = head && head.s > 0.3
    ? ty(head) - 18 * Math.min(scaleX, scaleY)
    : offY + 20;
  const labelX = head && head.s > 0.3 ? tx(head) : offX + cellW / 2;

  ctx.fillText(m.username || 'athlete', labelX, labelY);

  // Body score badge
  if (m.bodyScore >= 40) {
    const bx = offX + cellW - 50 * scaleX;
    const by = offY + 10;
    ctx.fillStyle = 'rgba(10,10,15,.7)';
    ctx.fillRect(bx, by, 44, 18);
    ctx.font = `${Math.max(8, 9 * Math.min(scaleX, scaleY))}px Space Mono, monospace`;
    ctx.fillStyle = m.bodyScore >= 75 ? '#00ffc6' : m.bodyScore >= 50 ? '#fbbf24' : '#ff3d6b';
    ctx.fillText(m.bodyScore + '%', bx + 4, by + 13);
  }

  ctx.restore();
  ctx.textAlign = 'left';

  // Cell divider
  if (offX > 0) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(offX, offY); ctx.lineTo(offX, offY + cellH); ctx.stroke();
    ctx.restore();
  }
}

// ── MEMBER BAR ────────────────────────────────
function updateMemberBar() {
  const bar  = document.getElementById('member-bar');
  const now  = Date.now();
  let   html = '';
  let   online = 0;

  for (const [uid, m] of Object.entries(members)) {
    const isActive = m.keypoints && (now - m.lastSeen < 3000);
    if (isActive) online++;
    html += `
      <div class="member-chip ${isActive ? 'active' : ''}">
        <div class="member-dot"></div>
        <span class="member-name">${(m.username||'athlete').substring(0,10)}</span>
        ${isActive && m.bodyScore ? `<span class="member-score">${m.bodyScore}%</span>` : ''}
      </div>
    `;
  }

  bar.innerHTML = html || '<div style="font-family:Space Mono,monospace;font-size:9px;color:var(--muted);padding:4px 6px;">No members yet</div>';
  document.getElementById('room-member-count').textContent = online + ' online';
}

// ── ROOM LOGIC ────────────────────────────────
async function joinRoom(roomId) {
  roomId = roomId.toUpperCase().trim();
  activeRoomId = roomId;

  // Store in localStorage for "recent rooms"
  const recent = JSON.parse(localStorage.getItem('soma_recent_rooms') || '[]');
  if (!recent.find(r => r.id === roomId)) {
    recent.unshift({ id: roomId, name: 'Room ' + roomId, ts: Date.now() });
    localStorage.setItem('soma_recent_rooms', JSON.stringify(recent.slice(0, 5)));
  }

  // Update UI
  document.getElementById('room-name-display').textContent   = 'Room ' + roomId;
  document.getElementById('room-code-display').textContent   = 'CODE: ' + roomId;
  document.getElementById('room-share-code').textContent     = roomId;
  document.getElementById('go-train-btn').href = 'index.html?room=' + roomId;

  showView('room');
  startRenderer();

  // Subscribe to room channel
  roomChannel = subscribeToRoom(roomId, onSkeletonFrame);
}

function onSkeletonFrame(payload) {
  const uid = payload.user_id;
  if (!members[uid]) assignColor(uid);

  members[uid] = {
    ...members[uid],
    username:  payload.username,
    keypoints: payload.keypoints,
    bodyScore: payload.body_score || 0,
    lastSeen:  Date.now(),
    color:     members[uid]?.color || assignColor(uid)
  };
}

async function createAndJoinRoom() {
  const btn = document.getElementById('create-room-btn');
  btn.textContent = '…';
  btn.disabled    = true;

  try {
    const roomId = await createRoom('SOMA Room', 'watch');
    await joinRoom(roomId);
  } catch(e) {
    console.error(e);
  } finally {
    btn.textContent = 'Create Room';
    btn.disabled    = false;
  }
}

async function tryJoinRoom() {
  const input = document.getElementById('room-code-input');
  const errEl = document.getElementById('join-error');
  const code  = input.value.trim().toUpperCase();
  errEl.textContent = '';

  if (code.length < 4) { errEl.textContent = 'Enter a valid room code.'; return; }

  const exists = await roomExists(code).catch(() => true); // fail open
  if (!exists) { errEl.textContent = 'Room not found. Check the code.'; return; }

  await joinRoom(code);
}

function leaveRoom() {
  if (roomChannel) { supa.removeChannel(roomChannel); roomChannel = null; }
  stopRenderer();
  activeRoomId = null;
  Object.keys(members).forEach(k => delete members[k]);
  showView('lobby');
  loadRecentRooms();
}

function copyRoomCode() {
  if (!activeRoomId) return;
  navigator.clipboard.writeText(activeRoomId).then(() => {
    const btn = document.getElementById('copy-code-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy Code', 2000);
  });
}

// ── RECENT ROOMS ──────────────────────────────
function loadRecentRooms() {
  const recent = JSON.parse(localStorage.getItem('soma_recent_rooms') || '[]');
  if (!recent.length) return;

  const section = document.getElementById('recent-rooms-section');
  const list    = document.getElementById('recent-rooms-list');
  section.style.display = 'block';

  list.innerHTML = recent.map(r => `
    <div class="recent-room-item" data-id="${r.id}">
      <div>
        <div class="rri-code">${r.id}</div>
        <div class="rri-name">${r.name}</div>
      </div>
      <div class="rri-arrow">→</div>
    </div>
  `).join('');

  list.querySelectorAll('.recent-room-item').forEach(el => {
    el.addEventListener('click', () => joinRoom(el.dataset.id));
  });
}

// ── VIEW SWITCHER ─────────────────────────────
function showView(name) {
  document.getElementById('view-lobby').classList.toggle('hidden', name !== 'lobby');
  document.getElementById('view-room').classList.toggle('hidden',  name !== 'room');
}

// ── STREAM STATUS POLL ────────────────────────
// Check if URL has ?room= param (coming back from trainer)
function checkStreamStatus() {
  const params = new URLSearchParams(window.location.search);
  const room   = params.get('room');
  if (room) {
    joinRoom(room);
    // Clean URL
    window.history.replaceState({}, '', 'watch.html');
  }
}

// ── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Auth (optional — watch rooms are public)
  const { data: { session } } = await supa.auth.getSession().catch(() => ({ data:{} }));
  if (session?.user) {
    currentUser = session.user;
    const { data } = await supa.from('profiles').select('*').eq('id', currentUser.id).single().catch(()=>({data:null}));
    currentProfile = data || { username: currentUser.email.split('@')[0] };
  }

  loadRecentRooms();
  checkStreamStatus();

  // Buttons
  document.getElementById('create-room-btn').addEventListener('click',  createAndJoinRoom);
  document.getElementById('join-room-btn').addEventListener('click',    tryJoinRoom);
  document.getElementById('leave-room-btn').addEventListener('click',   leaveRoom);
  document.getElementById('copy-code-btn').addEventListener('click',    copyRoomCode);
  document.getElementById('room-code-display').addEventListener('click', copyRoomCode);

  document.getElementById('room-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryJoinRoom();
    // Force uppercase
    setTimeout(() => {
      e.target.value = e.target.value.toUpperCase();
    }, 0);
  });
});
