// ── watch.js v2 — Watch Room ──────────────────

let currentUser    = null;
let currentProfile = null;
let activeRoomId   = null;
let renderRunning  = false;

// uid → { name, kps, score, lastSeen, color }
const members = {};
const COLORS  = ['#00ffc6','#ff3d6b','#a78bfa','#fbbf24','#38bdf8','#fb923c','#4ade80','#f472b6'];
let   colorIdx = 0;

function getColor(uid) {
  if (!members[uid]) members[uid] = { color: COLORS[colorIdx++ % COLORS.length] };
  return members[uid].color;
}

// ── SKELETON ──────────────────────────────────
const CONNS = [
  [0,1],[0,2],[1,3],[2,4],
  [5,6],[5,11],[6,12],[11,12],
  [5,7],[7,9],[6,8],[8,10],
  [11,13],[13,15],[12,14],[14,16]
];

// ── CANVAS RENDERER ───────────────────────────
const canvas = document.getElementById('room-canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  const stage = document.getElementById('room-stage');
  canvas.width  = stage.offsetWidth  || window.innerWidth;
  canvas.height = stage.offsetHeight || window.innerHeight * 0.6;
}

function renderLoop() {
  if (!renderRunning) return;
  requestAnimationFrame(renderLoop);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const now     = Date.now();
  const uids    = Object.keys(members).filter(uid => members[uid].kps);
  const active  = uids.filter(uid => now - (members[uid].lastSeen||0) < 4000);

  // Empty state
  document.getElementById('room-empty').classList.toggle('hidden', active.length > 0);

  if (!active.length) { updateMemberBar(); return; }

  const cols  = Math.min(active.length, 3);
  const rows  = Math.ceil(active.length / cols);
  const cellW = canvas.width  / cols;
  const cellH = canvas.height / rows;

  active.forEach((uid, i) => {
    const m     = members[uid];
    const col   = i % cols;
    const row   = Math.floor(i / cols);
    const offX  = col * cellW;
    const offY  = row * cellH;
    const scaleX= cellW / 640;
    const scaleY= cellH / 480;
    const stale = Math.max(0, 1 - (now - m.lastSeen) / 3000);
    drawSkeleton(m, offX, offY, scaleX, scaleY, cellW, cellH, stale);
  });

  updateMemberBar();
}

function drawSkeleton(m, ox, oy, sx, sy, cw, ch, alpha) {
  const kps = m.kps;
  const col = m.color;
  const C   = 0.2;
  const tx  = k => ox + k.x * sx;
  const ty  = k => oy + k.y * sy;

  ctx.save();

  // Connections
  for (const [a, b] of CONNS) {
    const ka = kps[a], kb = kps[b];
    if (!ka || !kb || ka.s < C || kb.s < C) continue;
    ctx.beginPath(); ctx.moveTo(tx(ka), ty(ka)); ctx.lineTo(tx(kb), ty(kb));
    ctx.strokeStyle = col;
    ctx.lineWidth   = Math.max(2, 3 * Math.min(sx, sy));
    ctx.globalAlpha = Math.min(ka.s, kb.s) * alpha;
    ctx.stroke();
  }

  // Joints
  for (let i = 0; i < kps.length; i++) {
    const k = kps[i];
    if (!k || k.s < C) continue;
    const r = Math.max(3, (i === 0 ? 7 : 5) * Math.min(sx, sy));
    ctx.globalAlpha = k.s * alpha * 0.2;
    ctx.beginPath(); ctx.arc(tx(k), ty(k), r + 5, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.globalAlpha = Math.min(1, k.s * 1.3) * alpha;
    ctx.beginPath(); ctx.arc(tx(k), ty(k), r, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.globalAlpha = k.s * 0.6 * alpha;
    ctx.beginPath(); ctx.arc(tx(k), ty(k), r * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
  }

  // Name label
  ctx.globalAlpha = alpha;
  const head   = kps[0];
  const labelX = head && head.s > 0.2 ? tx(head) : ox + cw / 2;
  const labelY = head && head.s > 0.2 ? ty(head) - 16 * Math.min(sx,sy) : oy + 20;
  ctx.font      = `bold ${Math.max(11, 14 * Math.min(sx,sy))}px Syne, sans-serif`;
  ctx.fillStyle = col;
  ctx.textAlign = 'center';
  ctx.fillText(m.name || 'athlete', labelX, labelY);

  // Score badge
  if (m.score >= 40) {
    const bx = ox + cw - 48 * sx;
    const by = oy + 8;
    ctx.fillStyle   = 'rgba(10,10,15,.75)';
    ctx.fillRect(bx, by, 42, 16);
    ctx.font      = `${Math.max(8, 9 * Math.min(sx,sy))}px Space Mono, monospace`;
    ctx.fillStyle = m.score >= 75 ? '#00ffc6' : m.score >= 50 ? '#fbbf24' : '#ff3d6b';
    ctx.textAlign = 'left';
    ctx.fillText(m.score + '%', bx + 3, by + 12);
  }

  // Cell divider
  if (ox > 0) {
    ctx.globalAlpha = 0.06; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy + ch); ctx.stroke();
  }

  ctx.restore();
  ctx.textAlign = 'left';
}

// ── MEMBER BAR ────────────────────────────────
function updateMemberBar() {
  const bar = document.getElementById('member-bar');
  const now = Date.now();
  let online = 0, html = '';
  for (const [uid, m] of Object.entries(members)) {
    const isOn = m.kps && (now - (m.lastSeen||0) < 4000);
    if (isOn) online++;
    html += `<div class="member-chip ${isOn?'active':''}">
      <div class="member-dot"></div>
      <span class="member-name">${(m.name||'athlete').substring(0,10)}</span>
      ${isOn && m.score ? `<span class="member-score">${m.score}%</span>` : ''}
    </div>`;
  }
  bar.innerHTML = html || `<span style="font-family:Space Mono,monospace;font-size:9px;color:var(--muted);">Waiting for members…</span>`;
  document.getElementById('room-member-count').textContent = online + ' online';
}

// ── ROOM LOGIC ────────────────────────────────
function onFrame(payload) {
  const uid = payload.uid || payload.user_id || 'unknown';
  if (!members[uid]) members[uid] = { color: getColor(uid) };
  members[uid] = {
    ...members[uid],
    name:     payload.name || payload.username || 'athlete',
    kps:      payload.kps  || payload.keypoints,
    score:    payload.score || payload.body_score || 0,
    lastSeen: Date.now()
  };
}

async function joinRoom(roomId) {
  roomId = roomId.toUpperCase().trim();
  activeRoomId = roomId;

  // Save to recent
  try {
    const recent = JSON.parse(localStorage.getItem('soma_rooms') || '[]');
    if (!recent.find(r => r.id === roomId)) {
      recent.unshift({ id: roomId, ts: Date.now() });
      localStorage.setItem('soma_rooms', JSON.stringify(recent.slice(0, 5)));
    }
  } catch(e) {}

  // Update UI
  document.getElementById('room-name-display').textContent = 'Room ' + roomId;
  document.getElementById('room-code-display').textContent = 'CODE: ' + roomId;
  document.getElementById('room-share-code').textContent   = roomId;
  document.getElementById('go-train-btn').href = 'index.html?room=' + roomId;

  showView('room');

  // Start renderer
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  renderRunning = true;
  renderLoop();

  // Subscribe to Supabase Realtime channel
  joinStream(roomId, onFrame);
  console.log('[WatchRoom] joined room:', roomId);
}

function leaveRoom() {
  leaveStream();
  renderRunning = false;
  activeRoomId  = null;
  Object.keys(members).forEach(k => delete members[k]);
  showView('lobby');
  loadRecentRooms();
}

async function createAndJoinRoom() {
  const btn = document.getElementById('create-room-btn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const id = generateRoomId();
    console.log('[WatchRoom] created room:', id);
    await joinRoom(id);
  } catch(e) {
    console.error('[WatchRoom] create error:', e);
    alert('Could not create room: ' + e.message);
  } finally {
    btn.textContent = 'Create Room'; btn.disabled = false;
  }
}

async function tryJoinRoom() {
  const code  = document.getElementById('room-code-input').value.trim().toUpperCase();
  const errEl = document.getElementById('join-error');
  errEl.textContent = '';
  if (code.length < 4) { errEl.textContent = 'Enter a valid 6-character code.'; return; }
  await joinRoom(code);
}

function copyRoomCode() {
  if (!activeRoomId) return;
  navigator.clipboard.writeText(activeRoomId).then(() => {
    const btn = document.getElementById('copy-code-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy Code', 2000);
  }).catch(() => {
    prompt('Copy this code:', activeRoomId);
  });
}

function loadRecentRooms() {
  try {
    const recent = JSON.parse(localStorage.getItem('soma_rooms') || '[]');
    const section = document.getElementById('recent-rooms-section');
    const list    = document.getElementById('recent-rooms-list');
    if (!recent.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    list.innerHTML = recent.map(r => `
      <div class="recent-room-item" data-id="${r.id}">
        <div><div class="rri-code">${r.id}</div></div>
        <div class="rri-arrow">→</div>
      </div>`).join('');
    list.querySelectorAll('.recent-room-item').forEach(el =>
      el.addEventListener('click', () => joinRoom(el.dataset.id))
    );
  } catch(e) {}
}

function showView(name) {
  document.getElementById('view-lobby').classList.toggle('hidden', name !== 'lobby');
  document.getElementById('view-room').classList.toggle('hidden',  name !== 'room');
}

// ── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Auth
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (session?.user) {
      currentUser = session.user;
      const { data } = await supa.from('profiles').select('username').eq('id', currentUser.id).maybeSingle();
      currentProfile = data || { username: currentUser.email.split('@')[0] };
    }
  } catch(e) { console.warn('[WatchRoom] auth error:', e); }

  loadRecentRooms();

  // Check ?room= param
  const roomParam = new URLSearchParams(window.location.search).get('room');
  if (roomParam) {
    joinRoom(roomParam);
    window.history.replaceState({}, '', 'watch.html');
  }

  // Buttons
  document.getElementById('create-room-btn').addEventListener('click', createAndJoinRoom);
  document.getElementById('join-room-btn').addEventListener('click', tryJoinRoom);
  document.getElementById('leave-room-btn').addEventListener('click', leaveRoom);
  document.getElementById('copy-code-btn').addEventListener('click', copyRoomCode);
  document.getElementById('room-code-display').addEventListener('click', copyRoomCode);
  document.getElementById('room-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryJoinRoom();
    setTimeout(() => e.target.value = e.target.value.toUpperCase(), 0);
  });
});
