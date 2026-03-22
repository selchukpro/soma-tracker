// ── room.js — Lobby + Session system ──────────

// ── STATE ─────────────────────────────────────
let me = null;           // { id, username }
let roomId = null;
let isHost = false;
let isReady = false;
let lobbyChannel = null; // Realtime channel for lobby
let sessionChannel = null;

// Session state
let detector = null;
let sessionRunning = false;
let sessionStart = null;
let sessionTimerInterval = null;
let myReps = 0;

// Peers: { uid: { name, kps, reps, color, lastSeen } }
const peers = {};
const COLORS = ['#00ffc6','#ff3d6b','#a78bfa','#fbbf24','#38bdf8','#fb923c','#4ade80','#f472b6'];
let colorIdx = 0;
function peerColor(uid) {
  if (!peers[uid]) peers[uid] = { color: COLORS[colorIdx++ % COLORS.length] };
  return peers[uid].color;
}

// ── ONE-EURO FILTER ───────────────────────────
class OneEuroFilter {
  constructor(f=30,m=1.5,b=0.01,d=1.0){
    this.freq=f;this.minCutoff=m;this.beta=b;this.dCutoff=d;
    this.xFilt=null;this.dxFilt=null;this.lastTime=null;
  }
  alpha(c){return 1/(1+(1/(2*Math.PI*c))/(1/this.freq));}
  filter(x,ts){
    if(this.lastTime!==null)this.freq=1/(ts-this.lastTime)||this.freq;
    this.lastTime=ts;
    const dx=this.xFilt===null?0:(x-this.xFilt)*this.freq;
    const dxH=this.dxFilt===null?dx:this.dxFilt+this.alpha(this.dCutoff)*(dx-this.dxFilt);
    this.dxFilt=dxH;
    const xH=this.xFilt===null?x:this.xFilt+this.alpha(this.minCutoff+this.beta*Math.abs(dxH))*(x-this.xFilt);
    return(this.xFilt=xH);
  }
}
const filtersX = Array.from({length:17}, ()=>new OneEuroFilter());
const filtersY = Array.from({length:17}, ()=>new OneEuroFilter());

// ── SKELETON ──────────────────────────────────
const CONNS = [
  [0,1],[0,2],[1,3],[2,4],[5,6],[5,11],[6,12],[11,12],
  [5,7],[7,9],[6,8],[8,10],[11,13],[13,15],[12,14],[14,16]
];
function angle3(a,b,c){
  const ab={x:a.x-b.x,y:a.y-b.y},cb={x:c.x-b.x,y:c.y-b.y};
  const dot=ab.x*cb.x+ab.y*cb.y,mag=Math.hypot(ab.x,ab.y)*Math.hypot(cb.x,cb.y);
  return mag===0?180:Math.round(Math.acos(Math.min(1,Math.max(-1,dot/mag)))*180/Math.PI);
}

// ── ROOM ID ───────────────────────────────────
function generateRoomId() {
  return Array.from({length:6}, ()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');
}

// ── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Auth check
  const { data:{ session } } = await supa.auth.getSession().catch(()=>({data:{session:null}}));
  if (!session?.user) {
    alert('Please sign in first.'); window.location.href = 'home.html'; return;
  }
  const { data: profile } = await supa.from('profiles').select('username').eq('id', session.user.id).maybeSingle();
  me = { id: session.user.id, username: profile?.username || session.user.email.split('@')[0] };

  document.getElementById('home-user-pill').textContent = '👤 ' + me.username;

  loadRecentRooms();

  // Check URL params
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) { joinRoom(roomParam.toUpperCase()); window.history.replaceState({}, '', 'room.html'); }

  // Buttons
  document.getElementById('create-btn').addEventListener('click', createRoom);
  document.getElementById('join-btn').addEventListener('click', () => {
    const code = document.getElementById('join-input').value.trim().toUpperCase();
    if (code.length < 4) { document.getElementById('join-err').textContent = 'Enter a valid code.'; return; }
    joinRoom(code);
  });
  document.getElementById('join-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('join-btn').click();
    setTimeout(() => e.target.value = e.target.value.toUpperCase(), 0);
  });
  document.getElementById('leave-btn').addEventListener('click', leaveRoom);
  document.getElementById('copy-btn').addEventListener('click', copyCode);
  document.getElementById('ready-btn').addEventListener('click', toggleReady);
  document.getElementById('start-btn').addEventListener('click', startSession);
  document.getElementById('end-session-btn').addEventListener('click', endSession);
});

// ── CREATE ROOM ───────────────────────────────
async function createRoom() {
  const btn = document.getElementById('create-btn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    roomId  = generateRoomId();
    isHost  = true;
    isReady = false;
    await joinLobby();
  } catch(e) {
    console.error(e); alert('Error: ' + e.message);
  } finally { btn.textContent = '+ Create Room'; btn.disabled = false; }
}

// ── JOIN ROOM ─────────────────────────────────
async function joinRoom(code) {
  roomId  = code;
  isHost  = false;
  isReady = false;
  await joinLobby();
}

// ── JOIN LOBBY ────────────────────────────────
async function joinLobby() {
  // Ensure profile exists (needed for foreign key)
  const { data: existingProfile } = await supa.from('profiles')
    .select('id').eq('id', me.id).maybeSingle();
  if (!existingProfile) {
    await supa.from('profiles').insert({
      id: me.id,
      username: me.username,
      total_xp: 0,
      story_chapter: 1,
      story_episode: 1
    }).catch(e => console.warn('Profile auto-create:', e.message));
  }

  // Remove old membership if any
  await supa.from('room_members').delete()
    .eq('room_id', roomId).eq('user_id', me.id);

  // Insert membership
  const { error } = await supa.from('room_members').insert({
    room_id:  roomId,
    user_id:  me.id,
    username: me.username,
    is_ready: false,
    is_host:  isHost
  });
  if (error) { console.error('Join error:', error.message); alert('Could not join room: ' + error.message); return; }

  // Save to recent
  try {
    const recent = JSON.parse(localStorage.getItem('soma_rooms2') || '[]');
    if (!recent.find(r=>r.id===roomId)) recent.unshift({id:roomId, ts:Date.now()});
    localStorage.setItem('soma_rooms2', JSON.stringify(recent.slice(0,5)));
  } catch(e) {}

  // Update UI
  document.getElementById('lobby-code').textContent = roomId;
  showView('lobby');

  // Subscribe to room_members changes via Realtime
  lobbyChannel = supa.channel('lobby:' + roomId);

  lobbyChannel
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'room_members',
      filter: `room_id=eq.${roomId}`
    }, () => { refreshLobby(); })
    .on('broadcast', { event: 'session_start' }, ({ payload }) => {
      onSessionStart(payload);
    })
    .on('broadcast', { event: 'skeleton' }, ({ payload }) => {
      onPeerSkeleton(payload);
    })
    .on('broadcast', { event: 'reps' }, ({ payload }) => {
      onPeerReps(payload);
    })
    .subscribe(status => {
      console.log('[Room] lobby channel:', status);
      if (status === 'SUBSCRIBED') refreshLobby();
    });
}

// ── REFRESH LOBBY UI ──────────────────────────
async function refreshLobby() {
  const { data: members } = await supa.from('room_members')
    .select('*').eq('room_id', roomId).order('joined_at');

  if (!members) return;

  const allReady = members.length > 1 && members.every(m => m.is_ready);
  const myRecord = members.find(m => m.user_id === me.id);
  isReady = myRecord?.is_ready || false;

  // Ready button
  const readyBtn = document.getElementById('ready-btn');
  readyBtn.textContent   = isReady ? '✓ Ready!' : '✓ I\'m Ready';
  readyBtn.style.background = isReady ? 'rgba(0,255,198,.2)' : 'var(--accent)';
  readyBtn.style.color   = isReady ? 'var(--accent)' : '#000';
  readyBtn.style.border  = isReady ? '2px solid var(--accent)' : 'none';

  // Start button — only host sees it when all ready
  const startWrap = document.getElementById('start-wrap');
  startWrap.style.display = (isHost && allReady) ? 'block' : 'none';

  // Sub text
  const notReady = members.filter(m=>!m.is_ready).length;
  document.getElementById('lobby-sub').textContent = allReady
    ? (isHost ? 'All ready! Press Start.' : 'Waiting for host to start…')
    : `${notReady} player${notReady>1?'s':''} not ready`;

  // Member list
  const list = document.getElementById('members-list');
  list.innerHTML = members.map(m => `
    <div class="member-card ${m.is_ready?'ready':''} ${m.is_host?'host':''}">
      <div class="mc-avatar">${m.username.charAt(0).toUpperCase()}</div>
      <div class="mc-name">${m.username}${m.user_id===me.id?' (you)':''}</div>
      ${m.is_host ? '<span class="mc-badge host-badge">Host</span>' : ''}
      <div class="mc-status">${m.is_ready ? '✅' : '⏳'}</div>
    </div>
  `).join('');
}

// ── TOGGLE READY ──────────────────────────────
async function toggleReady() {
  isReady = !isReady;
  await supa.from('room_members').update({ is_ready: isReady })
    .eq('room_id', roomId).eq('user_id', me.id);
}

// ── START SESSION (host only) ─────────────────
async function startSession() {
  if (!isHost) return;
  // Broadcast start event to all members
  await lobbyChannel.send({
    type: 'broadcast', event: 'session_start',
    payload: { started_at: Date.now(), exercise: 'squat' }
  });
  onSessionStart({ started_at: Date.now(), exercise: 'squat' });
}

async function onSessionStart(payload) {
  showView('session');
  document.getElementById('session-exercise').textContent =
    (payload.exercise || 'squat').toUpperCase() + ' — REP BATTLE';

  // Start timer
  sessionStart = Date.now();
  sessionTimerInterval = setInterval(() => {
    const s = Math.round((Date.now() - sessionStart) / 1000);
    document.getElementById('session-timer').textContent =
      String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
  }, 1000);

  // Start camera + tracking
  await startTracking(payload.exercise || 'squat');
}

// ── TRACKING ──────────────────────────────────
let trackRunning = false;
let trackLastPose = 0;
let myRepPhase = 'up';
let myRepEma = null;

let _trackInterval = null;

async function startTracking(exercise) {
  const video = document.getElementById('my-video');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false
    });
    video.srcObject = stream;
    await new Promise(r=>video.onloadedmetadata=r);

    document.getElementById('arena-loading-text').textContent = 'Loading model…';
    if (!detector) {
      await tf.ready();
      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {modelType:poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,enableSmoothing:false}
      );
    }
    document.getElementById('arena-loading').classList.add('hidden');

    // Resize canvas NOW (view is visible)
    const arenaCanvas = document.getElementById('arena-canvas');
    const stage = document.getElementById('arena');
    arenaCanvas.width  = stage.offsetWidth  || window.innerWidth;
    arenaCanvas.height = stage.offsetHeight || window.innerHeight * 0.7;
    console.log('[Room] arena canvas:', arenaCanvas.width, 'x', arenaCanvas.height);

    sessionRunning = true;
    trackRunning   = true;

    // Add myself to peers with empty kps so renderLoop includes me
    peers[me.id] = {
      name: me.username,
      color: COLORS[0],
      reps: 0,
      kps: null,
      lastSeen: Date.now()
    };

    // Use setInterval instead of rAF+async to avoid blocking
    if (_trackInterval) clearInterval(_trackInterval);
    _trackInterval = setInterval(() => runPose(exercise), 50); // 20fps

    // Start render loop
    renderLoop();

  } catch(e) {
    document.getElementById('arena-loading-text').textContent = 'Camera error: ' + e.message;
    console.error('[Room] camera/model error:', e);
  }
}

async function runPose(exercise) {
  if (!trackRunning || !detector) return;
  const video = document.getElementById('my-video');
  if (video.readyState < 2) return;

  let poses;
  try { poses = await detector.estimatePoses(video, {flipHorizontal:false}); } catch(e){ return; }
  if (!poses?.length) return;

  const ts = performance.now() / 1000;
  const kps = poses[0].keypoints.map((k,i)=>({
    ...k,
    x: filtersX[i].filter(k.x, ts),
    y: filtersY[i].filter(k.y, ts)
  }));

  // Update my entry — lastSeen keeps it visible in render
  peers[me.id] = { ...peers[me.id], kps, lastSeen: Date.now() };

  // Broadcast compressed skeleton
  const ch = lobbyChannel;
  if (ch) {
    ch.send({
      type:'broadcast', event:'skeleton',
      payload:{
        uid:  me.id,
        name: me.username,
        kps:  kps.map(k=>({x:Math.round(k.x), y:Math.round(k.y), s:+k.score.toFixed(2)}))
      }
    }).catch(()=>{});
  }

  countMyReps(kps, exercise);
}

function countMyReps(kps, exercise) {
  const C = 0.30;
  let angle = null;

  if (exercise === 'squat') {
    const lA=(kps[11].score>C&&kps[13].score>C&&kps[15].score>C)?angle3(kps[11],kps[13],kps[15]):null;
    const rA=(kps[12].score>C&&kps[14].score>C&&kps[16].score>C)?angle3(kps[12],kps[14],kps[16]):null;
    const vals = [lA,rA].filter(v=>v!==null);
    if (vals.length) angle = Math.round(vals.reduce((s,v)=>s+v,0)/vals.length);
  } else if (exercise === 'pushup') {
    const ls=kps[5],rs=kps[6],le=kps[7],re=kps[8],lw=kps[9],rw=kps[10];
    const useLeft=ls.score>=rs.score;
    const sh=useLeft?ls:rs,elb=useLeft?le:re,wri=useLeft?lw:rw;
    if(sh.score>C&&elb.score>C&&wri.score>C) angle=angle3(sh,elb,wri);
  }

  if (angle === null) return;
  myRepEma = myRepEma === null ? angle : myRepEma + 0.25*(angle-myRepEma);
  const s = Math.round(myRepEma);

  const cfg = { squat:{down:110,downHys:105,up:155,upHys:160}, pushup:{down:80,downHys:75,up:150,upHys:155} };
  const t = cfg[exercise] || cfg.squat;

  if (myRepPhase==='up' && s<=t.downHys) myRepPhase='down';
  else if (myRepPhase==='down' && s>=t.upHys) {
    myRepPhase='up'; myReps++;
    peers[me.id].reps = myReps;
    // Broadcast rep count
    const ch = sessionChannel || lobbyChannel;
    if (ch) ch.send({
      type:'broadcast', event:'reps',
      payload:{ uid:me.id, reps:myReps }
    }).catch(()=>{});
  }
}

function onPeerSkeleton(payload) {
  const uid = payload.uid;
  if (uid === me.id) return;
  if (!peers[uid]) { peerColor(uid); }
  peers[uid] = { ...peers[uid], name:payload.name||'athlete', kps:payload.kps, lastSeen:Date.now() };
}

function onPeerReps(payload) {
  const uid = payload.uid;
  if (!peers[uid]) peerColor(uid);
  peers[uid] = { ...peers[uid], reps: payload.reps };
}

// ── ARENA RENDER LOOP ─────────────────────────
function renderLoop() {
  if (!sessionRunning) return;
  requestAnimationFrame(renderLoop);

  const canvas = document.getElementById('arena-canvas');
  const stage  = document.getElementById('arena');
  if (canvas.width !== stage.offsetWidth) {
    canvas.width = stage.offsetWidth; canvas.height = stage.offsetHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const now   = Date.now();
  const uids  = Object.keys(peers).filter(uid => peers[uid].kps && (now-peers[uid].lastSeen)<4000);
  if (!uids.length) {
    // Show waiting text while cameras load
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = 'bold 16px Syne, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Loading cameras…', canvas.width/2, canvas.height/2);
    ctx.textAlign = 'left';
    return;
  }

  const cols  = Math.min(uids.length, 3);
  const rows  = Math.ceil(uids.length / cols);
  const cellW = canvas.width  / cols;
  const cellH = canvas.height / rows;

  uids.forEach((uid, i) => {
    const p    = peers[uid];
    const col  = i % cols;
    const row  = Math.floor(i / cols);
    const ox   = col * cellW;
    const oy   = row * cellH;
    const sx   = cellW / 640;
    const sy   = cellH / 480;
    const stale= Math.max(0, 1-(now-p.lastSeen)/3000);
    drawPeerSkeleton(ctx, p, ox, oy, sx, sy, cellW, cellH, stale);
  });

  // Scoreboard
  updateScoreboard(uids);
}

function drawPeerSkeleton(ctx, p, ox, oy, sx, sy, cw, ch, alpha) {
  const kps = p.kps;
  const col = p.color || '#00ffc6';
  const C   = 0.2;
  const tx  = k => ox + k.x * sx;
  const ty  = k => oy + k.y * sy;

  ctx.save();
  // Connections
  for (const [a,b] of CONNS) {
    const ka=kps[a],kb=kps[b];
    if(!ka||!kb||ka.s<C||kb.s<C) continue;
    ctx.beginPath(); ctx.moveTo(tx(ka),ty(ka)); ctx.lineTo(tx(kb),ty(kb));
    ctx.strokeStyle=col; ctx.lineWidth=Math.max(2,3*Math.min(sx,sy));
    ctx.globalAlpha=Math.min(ka.s,kb.s)*alpha; ctx.stroke();
  }
  // Joints
  for(let i=0;i<kps.length;i++){
    const k=kps[i]; if(!k||k.s<C) continue;
    const r=Math.max(3,(i===0?7:5)*Math.min(sx,sy));
    ctx.globalAlpha=k.s*alpha*.2;
    ctx.beginPath();ctx.arc(tx(k),ty(k),r+5,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();
    ctx.globalAlpha=Math.min(1,k.s*1.3)*alpha;
    ctx.beginPath();ctx.arc(tx(k),ty(k),r,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();
    ctx.globalAlpha=k.s*.6*alpha;
    ctx.beginPath();ctx.arc(tx(k),ty(k),r*.4,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
  }
  // Name + rep count
  ctx.globalAlpha=alpha;
  const head=kps[0];
  const lx=head&&head.s>.2?tx(head):ox+cw/2;
  const ly=head&&head.s>.2?ty(head)-18*Math.min(sx,sy):oy+24;
  ctx.font=`bold ${Math.max(12,15*Math.min(sx,sy))}px Syne,sans-serif`;
  ctx.fillStyle=col; ctx.textAlign='center';
  ctx.fillText((p.name||'athlete') + '  ' + (p.reps||0) + ' reps', lx, ly);
  // Cell border
  if(ox>0){ctx.globalAlpha=.06;ctx.strokeStyle='#fff';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(ox,oy);ctx.lineTo(ox,oy+ch);ctx.stroke();}
  ctx.restore(); ctx.textAlign='left';
}

function updateScoreboard(uids) {
  const sorted = [...uids].sort((a,b)=>(peers[b].reps||0)-(peers[a].reps||0));
  const sb = document.getElementById('scoreboard');
  sb.innerHTML = sorted.map((uid,i)=>`
    <div class="sb-cell ${i===0?'leader':''}">
      <div class="sb-name">${(peers[uid].name||'athlete').substring(0,8)}</div>
      <div class="sb-reps">${peers[uid].reps||0}</div>
    </div>`).join('');
}

// ── END SESSION ───────────────────────────────
function endSession() {
  sessionRunning = false;
  trackRunning   = false;
  clearInterval(sessionTimerInterval);
  if (_trackInterval) { clearInterval(_trackInterval); _trackInterval = null; }
  // Stop camera
  const video = document.getElementById('my-video');
  if (video.srcObject) { video.srcObject.getTracks().forEach(t=>t.stop()); video.srcObject=null; }
  // Go back to lobby
  myReps=0; myRepPhase='up'; myRepEma=null;
  Object.keys(peers).forEach(k=>{ if(peers[k]) peers[k].kps=null; peers[k].reps=0; });
  showView('lobby');
  refreshLobby();
}

// ── LEAVE ROOM ────────────────────────────────
async function leaveRoom() {
  if (lobbyChannel) { lobbyChannel.unsubscribe(); lobbyChannel=null; }
  await supa.from('room_members').delete().eq('room_id',roomId).eq('user_id',me.id);
  endSession();
  roomId=null; isHost=false; isReady=false;
  showView('home');
  loadRecentRooms();
}

// ── COPY CODE ─────────────────────────────────
function copyCode() {
  navigator.clipboard.writeText(roomId).then(()=>{
    const btn=document.getElementById('copy-btn');
    btn.textContent='Copied!'; setTimeout(()=>btn.textContent='Copy',2000);
  }).catch(()=>prompt('Room code:',roomId));
}

// ── RECENT ROOMS ──────────────────────────────
function loadRecentRooms() {
  try {
    const recent = JSON.parse(localStorage.getItem('soma_rooms2')||'[]');
    const section=document.getElementById('recent-section');
    const list=document.getElementById('recent-list');
    if(!recent.length){section.style.display='none';return;}
    section.style.display='block';
    list.innerHTML=recent.map(r=>`
      <div class="recent-item" data-id="${r.id}">
        <div class="recent-code">${r.id}</div>
        <div style="color:var(--muted);font-size:18px;">→</div>
      </div>`).join('');
    list.querySelectorAll('.recent-item').forEach(el=>
      el.addEventListener('click',()=>joinRoom(el.dataset.id))
    );
  } catch(e){}
}

// ── VIEW SWITCHER ─────────────────────────────
function showView(name){
  ['home','lobby','session'].forEach(v=>{
    document.getElementById('view-'+v).classList.toggle('hidden', v!==name);
  });
}
