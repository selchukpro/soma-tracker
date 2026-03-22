// ── fight.js — Boss Fight system ──────────────

// ── BOSS DATA ─────────────────────────────────
const BOSSES = [
  { id:1, name:'Stone Golem',  emoji:'🪨', hp:50,  healInterval:5, exercise:'squat'  },
  { id:2, name:'Iron Brute',   emoji:'⚙️', hp:80,  healInterval:5, exercise:'squat'  },
  { id:3, name:'Shadow Drake', emoji:'🐲', hp:120, healInterval:5, exercise:'pushup' },
  { id:4, name:'War Titan',    emoji:'🗿', hp:160, healInterval:5, exercise:'squat'  },
  { id:5, name:'Inferno King', emoji:'🔥', hp:200, healInterval:5, exercise:'pushup' },
  { id:6, name:'Dragon God',   emoji:'🐉', hp:300, healInterval:5, exercise:'squat'  },
];

// ── STATE ─────────────────────────────────────
let me = null;
let fightMode = null;      // 'solo_boss' | 'team_boss' | 'team_vs'
let roomId    = null;
let isHost    = false;
let myTeam    = null;      // 'a' | 'b' for team_vs
let selectedEx = 'squat';
let isReady   = false;
let currentBossIdx = 0;    // which boss in progression

// Fight state
let sessionId    = null;
let bossHp       = 0;
let bossMaxHp    = 0;
let bossBHp      = 0;      // team B boss hp (team_vs)
let bossBMaxHp   = 0;
let healInterval = 5;
let fightRunning = false;
let fightStart   = null;
let myReps       = 0;
let myRepPhase   = 'up';
let myRepEma     = null;
let lastHealTime = 0;
let healCountdown = 5;

// Peers: uid → { name, kps, reps, team, color, lastSeen }
const peers = {};
const COLORS = ['#00ffc6','#ff3d6b','#a78bfa','#fbbf24','#38bdf8','#fb923c','#4ade80','#f472b6'];
let colorIdx = 0;
function peerColor(uid) {
  if (!peers[uid]) peers[uid] = { color: COLORS[colorIdx++ % COLORS.length], reps:0 };
  return peers[uid].color;
}

// Channels
let lobbyChannel = null;

// Tracking
let detector = null;
let trackInterval = null;
let renderInterval = null;

// One-Euro filter
class OEF {
  constructor(f=30,m=1.5,b=0.01,d=1.0){this.freq=f;this.minCutoff=m;this.beta=b;this.dCutoff=d;this.xFilt=null;this.dxFilt=null;this.lastTime=null;}
  alpha(c){return 1/(1+(1/(2*Math.PI*c))/(1/this.freq));}
  filter(x,ts){
    if(this.lastTime!==null)this.freq=1/(ts-this.lastTime)||this.freq;this.lastTime=ts;
    const dx=this.xFilt===null?0:(x-this.xFilt)*this.freq;
    const dH=this.dxFilt===null?dx:this.dxFilt+this.alpha(this.dCutoff)*(dx-this.dxFilt);
    this.dxFilt=dH;
    const xH=this.xFilt===null?x:this.xFilt+this.alpha(this.minCutoff+this.beta*Math.abs(dH))*(x-this.xFilt);
    return(this.xFilt=xH);
  }
}
const fX=Array.from({length:17},()=>new OEF());
const fY=Array.from({length:17},()=>new OEF());

const CONNS=[[0,1],[0,2],[1,3],[2,4],[5,6],[5,11],[6,12],[11,12],[5,7],[7,9],[6,8],[8,10],[11,13],[13,15],[12,14],[14,16]];
function angle3(a,b,c){const ab={x:a.x-b.x,y:a.y-b.y},cb={x:c.x-b.x,y:c.y-b.y};const dot=ab.x*cb.x+ab.y*cb.y,mag=Math.hypot(ab.x,ab.y)*Math.hypot(cb.x,cb.y);return mag===0?180:Math.round(Math.acos(Math.min(1,Math.max(-1,dot/mag)))*180/Math.PI);}

// ── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const {data:{session}} = await supa.auth.getSession().catch(()=>({data:{session:null}}));
  if (!session?.user) { alert('Please sign in.'); window.location.href='home.html'; return; }

  // Ensure profile exists
  const {data:prof} = await supa.from('profiles').select('username').eq('id',session.user.id).maybeSingle();
  if (!prof) {
    await supa.from('profiles').insert({id:session.user.id,username:session.user.email.split('@')[0],total_xp:0,story_chapter:1,story_episode:1}).catch(()=>{});
  }
  me = { id: session.user.id, username: prof?.username || session.user.email.split('@')[0] };
  document.getElementById('mode-user').textContent = '👤 ' + me.username;

  // Mode select
  document.getElementById('mc-solo').addEventListener('click', ()=>startSolo());
  document.getElementById('mc-team-boss').addEventListener('click', ()=>enterLobby('team_boss'));
  document.getElementById('mc-team-vs').addEventListener('click', ()=>enterLobby('team_vs'));

  // Lobby buttons
  document.getElementById('lobby-back').addEventListener('click', leaveLobby);
  document.getElementById('lobby-copy').addEventListener('click', copyCode);
  document.getElementById('lobby-ready-btn').addEventListener('click', toggleReady);
  document.getElementById('lobby-start-btn').addEventListener('click', hostStartFight);
  document.getElementById('join-a-btn').addEventListener('click', ()=>joinTeam('a'));
  document.getElementById('join-b-btn').addEventListener('click', ()=>joinTeam('b'));
  document.getElementById('fight-end-btn').addEventListener('click', endFight);
  document.getElementById('result-again-btn').addEventListener('click', ()=>{ showView('mode'); });
  document.getElementById('result-home-btn').addEventListener('click', ()=>window.location.href='home.html');

  // Exercise buttons
  document.querySelectorAll('.es-btn').forEach(btn => {
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.es-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      selectedEx = btn.dataset.ex;
    });
  });

  // URL param check
  const params = new URLSearchParams(window.location.search);
  const rp = params.get('room'), mp = params.get('mode');
  if (rp && mp) { window.history.replaceState({},'','fight.html'); enterLobbyWithCode(mp, rp); }
});

// ── SOLO BOSS ─────────────────────────────────
function startSolo() {
  fightMode = 'solo_boss';
  isHost    = true;
  currentBossIdx = 0;
  peers[me.id] = { name:me.username, color:COLORS[0], reps:0, team:'a', kps:null, lastSeen:Date.now() };
  beginFight();
}

// ── LOBBY ─────────────────────────────────────
function generateRoomId() {
  return Array.from({length:6},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');
}

async function enterLobby(mode) {
  fightMode = mode;
  isHost    = true;
  roomId    = generateRoomId();
  myTeam    = 'a';
  await joinLobbyRoom();
}

async function enterLobbyWithCode(mode, code) {
  fightMode = mode;
  isHost    = false;
  roomId    = code;
  myTeam    = null;
  await joinLobbyRoom();
}

async function joinLobbyRoom() {
  // Insert into room_members
  await supa.from('room_members').delete().eq('room_id',roomId).eq('user_id',me.id);
  await supa.from('room_members').insert({
    room_id:roomId, user_id:me.id, username:me.username, is_ready:false, is_host:isHost
  });

  document.getElementById('lobby-code').textContent = roomId;
  document.getElementById('lobby-mode-title').textContent =
    fightMode==='team_boss' ? '🛡️ Team Boss Fight' : '⚡ Team vs Team';
  document.getElementById('team-assign').style.display = fightMode==='team_vs' ? 'block' : 'none';
  showView('lobby');

  // Supabase realtime channel
  lobbyChannel = supa.channel('fight:' + roomId);
  lobbyChannel
    .on('postgres_changes',{event:'*',schema:'public',table:'room_members',filter:`room_id=eq.${roomId}`},
      ()=>refreshLobby())
    .on('broadcast',{event:'fight_start'},({payload})=>onFightStart(payload))
    .on('broadcast',{event:'skeleton'},({payload})=>onPeerSkeleton(payload))
    .on('broadcast',{event:'rep'},({payload})=>onPeerRep(payload))
    .on('broadcast',{event:'boss_sync'},({payload})=>onBossSync(payload))
    .subscribe(s=>{ if(s==='SUBSCRIBED') refreshLobby(); });
}

async function refreshLobby() {
  const {data:members} = await supa.from('room_members').select('*').eq('room_id',roomId).order('joined_at');
  if (!members) return;

  const allReady = members.length>1 && members.every(m=>m.is_ready);
  const myRec    = members.find(m=>m.user_id===me.id);
  isReady = myRec?.is_ready||false;

  const readyBtn = document.getElementById('lobby-ready-btn');
  readyBtn.textContent = isReady ? '✓ Ready!' : '✓ Ready';
  readyBtn.style.opacity = isReady ? '.6' : '1';

  document.getElementById('lobby-start-wrap').style.display = (isHost&&allReady) ? 'block' : 'none';

  const notReady = members.filter(m=>!m.is_ready).length;
  document.getElementById('lobby-hint').textContent = allReady
    ? (isHost?'All ready! Press Start.':'Waiting for host…')
    : `${notReady} player${notReady>1?'s':''} not ready`;

  // Team vs: show team cols
  if (fightMode==='team_vs') {
    const teamA = members.filter(m=>m.team==='a'||(!m.team&&m.is_host));
    const teamB = members.filter(m=>m.team==='b');
    document.getElementById('team-a-list').innerHTML = teamA.map(m=>`<div class="team-member-chip">${m.username}</div>`).join('');
    document.getElementById('team-b-list').innerHTML = teamB.map(m=>`<div class="team-member-chip">${m.username}</div>`).join('');
  }

  // Member list
  document.getElementById('lobby-members').innerHTML = members.map(m=>`
    <div class="lobby-member ${m.is_ready?'ready':''}">
      <div class="lm-avatar">${m.username.charAt(0).toUpperCase()}</div>
      <div class="lm-name">${m.username}${m.user_id===me.id?' (you)':''}${m.is_host?' 👑':''}</div>
      <div class="lm-status">${m.is_ready?'✅':'⏳'}</div>
    </div>`).join('');
}

async function toggleReady() {
  isReady = !isReady;
  await supa.from('room_members').update({is_ready:isReady}).eq('room_id',roomId).eq('user_id',me.id);
}

async function joinTeam(team) {
  myTeam = team;
  await supa.from('room_members').update({team}).eq('room_id',roomId).eq('user_id',me.id);
}

async function hostStartFight() {
  if (!isHost) return;
  const boss = BOSSES[currentBossIdx];
  const payload = {
    mode: fightMode, exercise: selectedEx,
    boss: boss, boss_idx: currentBossIdx,
    started_at: Date.now()
  };
  await lobbyChannel.send({type:'broadcast',event:'fight_start',payload});
  onFightStart(payload);
}

async function leaveLobby() {
  if (lobbyChannel) { lobbyChannel.unsubscribe(); lobbyChannel=null; }
  await supa.from('room_members').delete().eq('room_id',roomId).eq('user_id',me.id);
  roomId=null; isHost=false; isReady=false;
  showView('mode');
}

// ── FIGHT START ───────────────────────────────
async function onFightStart(payload) {
  const boss   = payload.boss || BOSSES[0];
  selectedEx   = payload.exercise || 'squat';
  fightRunning = true;
  fightStart   = Date.now();
  myReps       = 0; myRepPhase='up'; myRepEma=null;
  lastHealTime = Date.now();
  healCountdown= boss.healInterval;

  // Set up boss HP
  bossHp    = boss.hp;
  bossMaxHp = boss.hp;
  healInterval = boss.healInterval;

  // Team vs — two bosses
  if (fightMode==='team_vs') {
    bossBHp    = boss.hp;
    bossBMaxHp = boss.hp;
    document.getElementById('boss-b-section').style.display = 'block';
  } else {
    document.getElementById('boss-b-section').style.display = 'none';
  }

  // Boss UI
  document.getElementById('boss-emoji').textContent = boss.emoji;
  document.getElementById('boss-name').textContent  = boss.name;
  document.getElementById('boss-level').textContent = fightMode==='solo_boss'
    ? 'Solo Fight' : fightMode==='team_boss'
    ? 'Team Boss · Round '+(currentBossIdx+1) : 'Team vs Team';

  updateBossHpBar();

  // Heal timer bar setup
  document.getElementById('heal-timer-wrap').innerHTML = `
    <div id="heal-timer-bar" style="flex:1;height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;">
      <div id="heal-timer-fill" style="height:100%;background:var(--accent);border-radius:2px;width:100%;transition:width .1s linear;"></div>
    </div>
    <div id="heal-timer-text" style="font-family:Space Mono,monospace;font-size:8px;color:var(--muted);white-space:nowrap;">Heals in ${healInterval}s</div>`;

  showView('fight');
  await startCamera(selectedEx);

  // Host manages boss heal
  if (isHost || fightMode==='solo_boss') {
    setInterval(()=>bossTick(), 100);
  }

  // Fight timer
  setInterval(()=>{
    if(!fightRunning) return;
    const s = Math.round((Date.now()-fightStart)/1000);
    document.getElementById('fight-timer').textContent =
      String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  }, 1000);
}

// ── BOSS TICK (host or solo) ───────────────────
function bossTick() {
  if (!fightRunning) return;
  const now = Date.now();
  const elapsed = (now - lastHealTime) / 1000;
  const remaining = Math.max(0, healInterval - elapsed);

  // Update heal timer bar
  const fill = document.getElementById('heal-timer-fill');
  const txt  = document.getElementById('heal-timer-text');
  if (fill) fill.style.width = ((remaining/healInterval)*100)+'%';
  if (txt)  txt.textContent  = 'Heals in '+remaining.toFixed(1)+'s';

  // Heal trigger
  if (elapsed >= healInterval) {
    lastHealTime = now;
    bossHp = Math.min(bossMaxHp, bossHp + 1);
    updateBossHpBar();

    // Flash green on bar
    const flash = document.getElementById('boss-hp-heal-flash');
    if (flash) {
      flash.classList.add('flash');
      setTimeout(()=>flash.classList.remove('flash'), 200);
    }

    // Broadcast to peers
    if (lobbyChannel) {
      lobbyChannel.send({type:'broadcast',event:'boss_sync',payload:{hp:bossHp,hpB:bossBHp}}).catch(()=>{});
    }
  }
}

function onBossSync(payload) {
  if (!isHost && fightMode!=='solo_boss') {
    bossHp  = payload.hp;
    bossBHp = payload.hpB||bossBHp;
    updateBossHpBar();
  }
}

function updateBossHpBar() {
  const pct = Math.max(0,(bossHp/bossMaxHp)*100);
  const bar = document.getElementById('boss-hp-bar');
  const txt = document.getElementById('boss-hp-text');
  if (bar) bar.style.width = pct+'%';
  if (txt) txt.textContent = `${bossHp} / ${bossMaxHp} HP`;

  // Color changes as HP drops
  if (bar) bar.style.background = pct>60 ? 'linear-gradient(90deg,#ff3d6b,#ff6b35)'
    : pct>30 ? 'linear-gradient(90deg,#fbbf24,#fb923c)'
    : 'linear-gradient(90deg,#00ffc6,#38bdf8)';

  // Team B boss
  if (fightMode==='team_vs') {
    const pctB = Math.max(0,(bossBHp/bossBMaxHp)*100);
    const barB = document.getElementById('boss-b-hp-bar');
    const txtB = document.getElementById('boss-b-hp-text');
    if (barB) barB.style.width = pctB+'%';
    if (txtB) txtB.textContent = `${bossBHp} / ${bossBMaxHp} HP`;
  }

  // Win check
  if (bossHp <= 0) onBossDefeated();
}

function dealDamage(amount) {
  // In team_vs: damage goes to enemy boss
  if (fightMode==='team_vs') {
    const targetHp = myTeam==='a' ? bossBHp : bossHp;
    const newHp = Math.max(0, targetHp - amount);
    if (myTeam==='a') bossBHp = newHp;
    else bossHp = newHp;
  } else {
    bossHp = Math.max(0, bossHp - amount);
  }
  updateBossHpBar();

  // Broadcast damage to peers
  if (lobbyChannel) {
    lobbyChannel.send({type:'broadcast',event:'boss_sync',payload:{hp:bossHp,hpB:bossBHp}}).catch(()=>{});
  }
}

// ── CAMERA + TRACKING ─────────────────────────
async function startCamera(exercise) {
  const video = document.getElementById('fight-video');
  const arena = document.getElementById('fight-arena');
  const canvas= document.getElementById('fight-canvas');
  canvas.width  = arena.offsetWidth  || window.innerWidth;
  canvas.height = arena.offsetHeight || Math.round(window.innerHeight*.55);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false
    });
    video.srcObject = stream;
    await new Promise(r=>video.onloadedmetadata=r);

    document.getElementById('fight-loading-text').textContent = 'Loading model…';
    if (!detector) {
      await tf.ready();
      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {modelType:poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,enableSmoothing:false}
      );
    }
    document.getElementById('fight-loading').classList.add('hidden');

    peers[me.id] = { name:me.username, color:COLORS[0], reps:0, team:myTeam||'a', kps:null, lastSeen:Date.now() };

    if (trackInterval) clearInterval(trackInterval);
    trackInterval = setInterval(()=>runTracking(exercise), 50);
    if (renderInterval) clearInterval(renderInterval);
    renderInterval = setInterval(drawArena, 33);

  } catch(e) {
    document.getElementById('fight-loading-text').textContent = 'Camera error: '+e.message;
  }
}

async function runTracking(exercise) {
  if (!fightRunning || !detector) return;
  const video = document.getElementById('fight-video');
  if (video.readyState < 2) return;
  let poses;
  try { poses = await detector.estimatePoses(video,{flipHorizontal:false}); } catch(e){ return; }
  if (!poses?.length) return;

  const ts = performance.now()/1000;
  const kps = poses[0].keypoints.map((k,i)=>({
    ...k, x:fX[i].filter(k.x,ts), y:fY[i].filter(k.y,ts)
  }));

  peers[me.id] = { ...peers[me.id], kps, lastSeen:Date.now() };

  // Broadcast
  if (lobbyChannel) {
    lobbyChannel.send({type:'broadcast',event:'skeleton',payload:{
      uid:me.id, name:me.username, team:myTeam,
      kps:kps.map(k=>({x:Math.round(k.x),y:Math.round(k.y),s:+k.score.toFixed(2)}))
    }}).catch(()=>{});
  }

  countReps(kps, exercise);
}

function countReps(kps, exercise) {
  const C=0.30; let angle=null;
  if(exercise==='squat'){
    const lA=(kps[11].score>C&&kps[13].score>C&&kps[15].score>C)?angle3(kps[11],kps[13],kps[15]):null;
    const rA=(kps[12].score>C&&kps[14].score>C&&kps[16].score>C)?angle3(kps[12],kps[14],kps[16]):null;
    const vals=[lA,rA].filter(v=>v!==null);
    if(vals.length) angle=Math.round(vals.reduce((s,v)=>s+v,0)/vals.length);
  } else {
    const ls=kps[5],rs=kps[6],le=kps[7],re=kps[8],lw=kps[9],rw=kps[10];
    const useLeft=ls.score>=rs.score;
    const sh=useLeft?ls:rs,elb=useLeft?le:re,wri=useLeft?lw:rw;
    if(sh.score>C&&elb.score>C&&wri.score>C) angle=angle3(sh,elb,wri);
  }
  if(angle===null) return;
  myRepEma=myRepEma===null?angle:myRepEma+0.25*(angle-myRepEma);
  const s=Math.round(myRepEma);
  const cfg={squat:{down:110,downHys:105,up:155,upHys:160},pushup:{down:80,downHys:75,up:150,upHys:155}};
  const t=cfg[exercise]||cfg.squat;
  if(myRepPhase==='up'&&s<=t.downHys) myRepPhase='down';
  else if(myRepPhase==='down'&&s>=t.upHys){
    myRepPhase='up'; myReps++;
    peers[me.id].reps = myReps;
    dealDamage(1);
    // Broadcast rep
    if(lobbyChannel) lobbyChannel.send({type:'broadcast',event:'rep',payload:{uid:me.id,reps:myReps,team:myTeam}}).catch(()=>{});
  }
}

function onPeerSkeleton(payload) {
  const uid=payload.uid;
  if(!uid||uid===me.id) return;
  if(!peers[uid]) peers[uid]={color:COLORS[colorIdx++%COLORS.length],reps:0};
  peers[uid]={...peers[uid],name:payload.name||'athlete',kps:payload.kps,team:payload.team,lastSeen:Date.now()};
}

function onPeerRep(payload) {
  const uid=payload.uid;
  if(!uid) return;
  if(!peers[uid]) peers[uid]={color:COLORS[colorIdx++%COLORS.length],reps:0};
  peers[uid]={...peers[uid],reps:payload.reps,team:payload.team};
  // Non-host also applies damage
  if(!isHost && fightMode!=='solo_boss') dealDamage(1);
}

// ── DRAW ARENA ────────────────────────────────
function drawArena() {
  const canvas=document.getElementById('fight-canvas');
  const arena =document.getElementById('fight-arena');
  const sw=arena.offsetWidth||window.innerWidth;
  const sh=arena.offsetHeight||300;
  if(canvas.width!==sw||canvas.height!==sh){canvas.width=sw;canvas.height=sh;}
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const now=Date.now();
  const uids=Object.keys(peers).filter(uid=>peers[uid].kps&&(now-peers[uid].lastSeen)<5000);
  if(!uids.length){
    ctx.fillStyle='rgba(0,255,198,.12)';ctx.font='bold 14px Syne,sans-serif';
    ctx.textAlign='center';ctx.fillText('Cameras loading…',canvas.width/2,canvas.height/2);
    ctx.textAlign='left';updateFightScoreboard();return;
  }

  // Team vs: split canvas left/right by team
  if(fightMode==='team_vs'){
    const teamA=uids.filter(u=>peers[u].team==='a');
    const teamB=uids.filter(u=>peers[u].team==='b');
    const half=canvas.width/2;
    // Team A label
    ctx.fillStyle='rgba(0,255,198,.15)';ctx.fillRect(0,0,half,canvas.height);
    ctx.fillStyle='var(--team-a)';ctx.font='bold 10px Space Mono,monospace';
    ctx.textAlign='center';ctx.fillText('⚔️ TEAM A',half/2,16);
    // Team B label
    ctx.fillStyle='rgba(255,61,107,.08)';ctx.fillRect(half,0,half,canvas.height);
    ctx.fillStyle='#ff3d6b';ctx.fillText('🛡️ TEAM B',half+half/2,16);
    ctx.textAlign='left';
    drawTeamSkeletons(ctx,teamA,0,0,half,canvas.height);
    drawTeamSkeletons(ctx,teamB,half,0,half,canvas.height);
    // Divider
    ctx.strokeStyle='rgba(255,255,255,.1)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(half,0);ctx.lineTo(half,canvas.height);ctx.stroke();
  } else {
    drawTeamSkeletons(ctx,uids,0,0,canvas.width,canvas.height);
  }
  updateFightScoreboard();
}

function drawTeamSkeletons(ctx,uids,ox,oy,w,h) {
  if(!uids.length) return;
  const cols=Math.min(uids.length,3);
  const rows=Math.ceil(uids.length/cols);
  const cw=w/cols,ch=h/rows;
  const now=Date.now();
  uids.forEach((uid,i)=>{
    const p=peers[uid];
    const col=i%cols,row=Math.floor(i/cols);
    const x=ox+col*cw,y=oy+row*ch;
    const sx=cw/640,sy=ch/480;
    const stale=Math.max(.15,1-(now-p.lastSeen)/4000);
    drawSkeleton(ctx,p,x,y,sx,sy,cw,ch,stale);
  });
}

function drawSkeleton(ctx,p,ox,oy,sx,sy,cw,ch,alpha) {
  const kps=p.kps,col=p.color||'#00ffc6',C=0.2;
  const tx=k=>ox+k.x*sx,ty=k=>oy+k.y*sy;
  ctx.save();
  for(const[a,b]of CONNS){const ka=kps[a],kb=kps[b];if(!ka||!kb||ka.s<C||kb.s<C)continue;
    ctx.beginPath();ctx.moveTo(tx(ka),ty(ka));ctx.lineTo(tx(kb),ty(kb));
    ctx.strokeStyle=col;ctx.lineWidth=Math.max(2,3*Math.min(sx,sy));
    ctx.globalAlpha=Math.min(ka.s,kb.s)*alpha;ctx.stroke();}
  for(let i=0;i<kps.length;i++){const k=kps[i];if(!k||k.s<C)continue;
    const r=Math.max(3,(i===0?7:5)*Math.min(sx,sy));
    ctx.globalAlpha=k.s*alpha*.2;ctx.beginPath();ctx.arc(tx(k),ty(k),r+5,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();
    ctx.globalAlpha=Math.min(1,k.s*1.3)*alpha;ctx.beginPath();ctx.arc(tx(k),ty(k),r,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();
    ctx.globalAlpha=k.s*.6*alpha;ctx.beginPath();ctx.arc(tx(k),ty(k),r*.4,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();}
  ctx.globalAlpha=alpha;
  const head=kps[0];
  const lx=head&&head.s>.2?tx(head):ox+cw/2;
  const ly=head&&head.s>.2?ty(head)-16*Math.min(sx,sy):oy+20;
  ctx.font=`bold ${Math.max(11,13*Math.min(sx,sy))}px Syne,sans-serif`;
  ctx.fillStyle=col;ctx.textAlign='center';
  ctx.fillText(`${p.name||'?'}  ${p.reps||0}`,lx,ly);
  ctx.restore();ctx.textAlign='left';
}

function updateFightScoreboard() {
  const uids=Object.keys(peers);
  const sorted=[...uids].sort((a,b)=>(peers[b].reps||0)-(peers[a].reps||0));
  const sb=document.getElementById('fight-scoreboard');
  sb.innerHTML=sorted.map((uid,i)=>`
    <div class="fs-cell ${i===0?'leader':''}">
      <div class="fs-name">${(peers[uid].name||'?').substring(0,7)}</div>
      <div class="fs-reps">${peers[uid].reps||0}</div>
    </div>`).join('');
}

// ── BOSS DEFEATED ─────────────────────────────
function onBossDefeated() {
  if (!fightRunning) return;
  fightRunning = false;
  clearInterval(trackInterval);
  clearInterval(renderInterval);
  stopCamera();

  if (fightMode==='solo_boss' || fightMode==='team_boss') {
    // Progress to next boss
    currentBossIdx = Math.min(currentBossIdx+1, BOSSES.length-1);
    showResult(true, 'Boss defeated! Next round awaits…');
  } else {
    showResult(true, 'Your team won!');
  }
}

// ── FIGHT END (manual) ────────────────────────
function endFight() {
  fightRunning=false;
  clearInterval(trackInterval);
  clearInterval(renderInterval);
  stopCamera();
  showResult(false,'Fight ended early.');
}

function stopCamera() {
  const video=document.getElementById('fight-video');
  if(video.srcObject){video.srcObject.getTracks().forEach(t=>t.stop());video.srcObject=null;}
}

// ── RESULT ────────────────────────────────────
function showResult(won, subtitle) {
  const totalReps = Object.values(peers).reduce((s,p)=>s+(p.reps||0),0);
  const myR = peers[me.id]?.reps||0;

  document.getElementById('result-emoji').textContent = won ? '🏆' : '💀';
  document.getElementById('result-title').textContent = won ? 'Victory!' : 'Defeated';
  document.getElementById('result-sub').textContent   = subtitle;
  document.getElementById('result-stats').innerHTML   = `
    <div class="rs-stat"><div class="rs-val">${myR}</div><div class="rs-lbl">Your Reps</div></div>
    <div class="rs-stat"><div class="rs-val">${totalReps}</div><div class="rs-lbl">Team Total</div></div>
    <div class="rs-stat"><div class="rs-val">Rd ${currentBossIdx}</div><div class="rs-lbl">Round</div></div>`;

  showView('result');

  // Save workout
  supa.auth.getSession().then(({data:{session}})=>{
    if(session?.user && myR>0) {
      supa.from('workouts').insert({user_id:session.user.id,exercise:selectedEx,reps:myR}).catch(()=>{});
    }
  });
}

// ── VIEW SWITCHER ─────────────────────────────
function showView(name) {
  ['mode','lobby','fight','result'].forEach(v=>{
    document.getElementById('view-'+v).classList.toggle('hidden',v!==name);
  });
}

function copyCode() {
  navigator.clipboard.writeText(roomId).then(()=>{
    const b=document.getElementById('lobby-copy');
    b.textContent='Copied!';setTimeout(()=>b.textContent='Copy',2000);
  }).catch(()=>prompt('Room code:',roomId));
}
