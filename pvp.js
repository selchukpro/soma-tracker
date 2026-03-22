// ── pvp.js — 1v1 / 2v2 / 3v3 PvP system ──────

// ── STATE ─────────────────────────────────────
let me       = null;
let pvpMode  = null;   // '1v1' | '2v2' | '3v3'
let roomId   = null;
let isHost   = false;
let myTeam   = null;   // 'a' | 'b'
let isReady  = false;
let exercise = 'squat';
let duration = 60;     // seconds

// Battle state
let battleRunning = false;
let battleStart   = null;
let timeLeft      = 60;
let myReps        = 0;
let myRepPhase    = 'up';
let myRepEma      = null;

// peers: uid → { name, team, reps, color, kps, lastSeen }
const peers = {};
const COLORS_A = ['#00ffc6','#38bdf8','#4ade80'];
const COLORS_B = ['#ff3d6b','#fb923c','#f472b6'];
let aIdx = 0, bIdx = 0;

function assignPeer(uid, team) {
  if (peers[uid]) return;
  const col = team==='a' ? COLORS_A[aIdx++%COLORS_A.length] : COLORS_B[bIdx++%COLORS_B.length];
  peers[uid] = { color:col, reps:0, team, kps:null, lastSeen:Date.now() };
}

// Channels + tracking
let lobbyChannel  = null;
let detector      = null;
let trackInterval = null;
let renderInterval= null;
let timerInterval = null;

// One-Euro Filter
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

// Skeleton
const CONNS=[[0,1],[0,2],[1,3],[2,4],[5,6],[5,11],[6,12],[11,12],[5,7],[7,9],[6,8],[8,10],[11,13],[13,15],[12,14],[14,16]];
function angle3(a,b,c){const ab={x:a.x-b.x,y:a.y-b.y},cb={x:c.x-b.x,y:c.y-b.y};const dot=ab.x*cb.x+ab.y*cb.y,mag=Math.hypot(ab.x,ab.y)*Math.hypot(cb.x,cb.y);return mag===0?180:Math.round(Math.acos(Math.min(1,Math.max(-1,dot/mag)))*180/Math.PI);}

// ── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const {data:{session}} = await supa.auth.getSession().catch(()=>({data:{session:null}}));
  if (!session?.user) { alert('Please sign in.'); window.location.href='home.html'; return; }

  const {data:prof} = await supa.from('profiles').select('username').eq('id',session.user.id).maybeSingle();
  if (!prof) await supa.from('profiles').insert({id:session.user.id,username:session.user.email.split('@')[0],total_xp:0,story_chapter:1,story_episode:1}).catch(()=>{});
  me = { id:session.user.id, username:prof?.username||session.user.email.split('@')[0] };
  document.getElementById('pvp-user').textContent = '👤 '+me.username;

  // Mode cards
  document.getElementById('mc-1v1').addEventListener('click', ()=>enterLobby('1v1'));
  document.getElementById('mc-2v2').addEventListener('click', ()=>enterLobby('2v2'));
  document.getElementById('mc-3v3').addEventListener('click', ()=>enterLobby('3v3'));

  // Exercise btns
  document.querySelectorAll('.ex-btn').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.ex-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); exercise=btn.dataset.ex;
  }));

  // Duration btns
  document.querySelectorAll('.dur-btn').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.dur-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); duration=parseInt(btn.dataset.sec);
  }));

  // Lobby buttons
  document.getElementById('lobby-back').addEventListener('click', leaveLobby);
  document.getElementById('lobby-copy').addEventListener('click', ()=>{
    navigator.clipboard.writeText(roomId).then(()=>{
      const b=document.getElementById('lobby-copy');
      b.textContent='Copied!';setTimeout(()=>b.textContent='Copy',2000);
    }).catch(()=>prompt('Room code:',roomId));
  });
  document.getElementById('join-a').addEventListener('click',()=>joinTeam('a'));
  document.getElementById('join-b').addEventListener('click',()=>joinTeam('b'));
  document.getElementById('ready-btn').addEventListener('click', toggleReady);
  document.getElementById('start-btn').addEventListener('click', hostStart);
  document.getElementById('battle-end-btn').addEventListener('click', endBattle);
  document.getElementById('result-rematch').addEventListener('click',()=>{ resetState(); showView('lobby'); });
  document.getElementById('result-home').addEventListener('click',()=>window.location.href='home.html');
});

// ── ENTER LOBBY ───────────────────────────────
function generateId() {
  return Array.from({length:6},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');
}

async function enterLobby(mode) {
  pvpMode = mode;
  isHost  = true;
  roomId  = generateId();
  myTeam  = 'a'; // host starts in team A

  await joinLobbyRoom();
}

async function joinLobbyRoom() {
  // Ensure profile
  await supa.from('profiles').upsert({id:me.id,username:me.username,total_xp:0,story_chapter:1,story_episode:1},{onConflict:'id'}).catch(()=>{});

  // Clean + insert
  await supa.from('room_members').delete().eq('room_id',roomId).eq('user_id',me.id);
  const {error} = await supa.from('room_members').insert({
    room_id:roomId, user_id:me.id, username:me.username,
    is_ready:false, is_host:isHost, team:myTeam||'a'
  });
  if (error) { alert('Could not join: '+error.message); return; }

  // UI
  document.getElementById('lobby-code').textContent = roomId;
  document.getElementById('lobby-title').textContent =
    pvpMode==='1v1'?'⚔️ 1v1 Duel':pvpMode==='2v2'?'⚔️ 2v2 Battle':'🛡️ 3v3 Battle';
  showView('lobby');

  // Realtime
  lobbyChannel = supa.channel('pvp:'+roomId);
  lobbyChannel
    .on('postgres_changes',{event:'*',schema:'public',table:'room_members',filter:`room_id=eq.${roomId}`},
      ()=>refreshLobby())
    .on('broadcast',{event:'battle_start'},({payload})=>onBattleStart(payload))
    .on('broadcast',{event:'skeleton'},({payload})=>onPeerSkeleton(payload))
    .on('broadcast',{event:'rep'},({payload})=>onPeerRep(payload))
    .subscribe(s=>{ if(s==='SUBSCRIBED') refreshLobby(); });
}

async function refreshLobby() {
  const {data:members} = await supa.from('room_members').select('*').eq('room_id',roomId).order('joined_at');
  if (!members) return;

  const maxPerTeam = pvpMode==='1v1'?1:pvpMode==='2v2'?2:3;
  const teamA = members.filter(m=>m.team==='a'||(!m.team&&m.is_host));
  const teamB = members.filter(m=>m.team==='b');
  const allReady = members.length>=2 && members.every(m=>m.is_ready);
  const myRec = members.find(m=>m.user_id===me.id);
  isReady = myRec?.is_ready||false;

  // Team columns
  document.getElementById('team-a-members').innerHTML = teamA.map(m=>
    `<div class="team-player ${m.user_id===me.id?'me':''}">${m.username}${m.is_ready?' ✅':' ⏳'}</div>`).join('');
  document.getElementById('team-b-members').innerHTML = teamB.map(m=>
    `<div class="team-player ${m.user_id===me.id?'me':''}">${m.username}${m.is_ready?' ✅':' ⏳'}</div>`).join('');

  // Hide join buttons if team full
  document.getElementById('join-a').style.display = teamA.length>=maxPerTeam?'none':'block';
  document.getElementById('join-b').style.display = teamB.length>=maxPerTeam?'none':'block';

  // Ready btn
  const readyBtn = document.getElementById('ready-btn');
  readyBtn.textContent = isReady ? '✓ Ready!' : '✓ Ready';
  readyBtn.style.opacity = isReady ? '.6' : '1';

  // Start btn (host only, all ready, balanced teams)
  const balanced = pvpMode==='1v1' ? (teamA.length===1&&teamB.length===1) :
    pvpMode==='2v2' ? (teamA.length>=1&&teamB.length>=1) : (teamA.length>=1&&teamB.length>=1);
  document.getElementById('start-wrap').style.display = (isHost&&allReady&&balanced)?'block':'none';

  const notReady = members.filter(m=>!m.is_ready).length;
  document.getElementById('lobby-hint').textContent = allReady&&balanced
    ? (isHost?'All set! Press Start.':'Waiting for host…')
    : `${notReady} not ready`;
}

async function joinTeam(team) {
  myTeam = team;
  await supa.from('room_members').update({team}).eq('room_id',roomId).eq('user_id',me.id);
}

async function toggleReady() {
  isReady = !isReady;
  await supa.from('room_members').update({is_ready:isReady}).eq('room_id',roomId).eq('user_id',me.id);
}

async function hostStart() {
  const payload = { exercise, duration, started_at:Date.now() };
  await lobbyChannel.send({type:'broadcast',event:'battle_start',payload});
  onBattleStart(payload);
}

async function leaveLobby() {
  if (lobbyChannel) { lobbyChannel.unsubscribe(); lobbyChannel=null; }
  await supa.from('room_members').delete().eq('room_id',roomId).eq('user_id',me.id);
  resetState();
  showView('mode');
}

// ── BATTLE START ──────────────────────────────
async function onBattleStart(payload) {
  exercise = payload.exercise||'squat';
  duration = payload.duration||60;
  timeLeft = duration;
  battleRunning = true;
  battleStart   = Date.now();
  myReps = 0; myRepPhase='up'; myRepEma=null;

  document.getElementById('battle-ex-label').textContent = exercise.toUpperCase();
  document.getElementById('score-a').textContent = '0';
  document.getElementById('score-b').textContent = '0';

  // Init my peer
  const myColor = myTeam==='a' ? COLORS_A[0] : COLORS_B[0];
  peers[me.id] = { name:me.username, team:myTeam, reps:0, color:myColor, kps:null, lastSeen:Date.now() };

  showView('battle');
  await startCamera();

  // Countdown timer
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(()=>{
    if (!battleRunning) return;
    timeLeft = Math.max(0, duration - Math.round((Date.now()-battleStart)/1000));
    const m = Math.floor(timeLeft/60), s = timeLeft%60;
    document.getElementById('battle-timer').textContent = String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    // Flash red when <10s
    document.getElementById('battle-timer').style.color = timeLeft<10?'var(--accent2)':'var(--warn)';
    if (timeLeft===0) endBattle();
  },500);
}

// ── CAMERA ────────────────────────────────────
async function startCamera() {
  const video  = document.getElementById('battle-video');
  const canvas = document.getElementById('battle-canvas');
  const arena  = document.getElementById('battle-arena');
  canvas.width  = arena.offsetWidth  || window.innerWidth;
  canvas.height = arena.offsetHeight || Math.round(window.innerHeight*.55);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false
    });
    video.srcObject = stream;
    await new Promise(r=>video.onloadedmetadata=r);

    document.getElementById('battle-loading-text').textContent = 'Loading model…';
    if (!detector) {
      await tf.ready();
      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {modelType:poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,enableSmoothing:false}
      );
    }
    document.getElementById('battle-loading').classList.add('hidden');

    if (trackInterval)  clearInterval(trackInterval);
    if (renderInterval) clearInterval(renderInterval);
    trackInterval  = setInterval(()=>runTracking(), 50);
    renderInterval = setInterval(()=>drawBattle(),  33);

  } catch(e) {
    document.getElementById('battle-loading-text').textContent = 'Camera error: '+e.message;
  }
}

async function runTracking() {
  if (!battleRunning || !detector) return;
  const video = document.getElementById('battle-video');
  if (video.readyState<2) return;
  let poses;
  try { poses=await detector.estimatePoses(video,{flipHorizontal:false}); } catch(e){ return; }
  if (!poses?.length) return;

  const ts=performance.now()/1000;
  const kps=poses[0].keypoints.map((k,i)=>({...k,x:fX[i].filter(k.x,ts),y:fY[i].filter(k.y,ts)}));
  peers[me.id]={...peers[me.id],kps,lastSeen:Date.now()};

  // Broadcast skeleton
  if (lobbyChannel) lobbyChannel.send({type:'broadcast',event:'skeleton',payload:{
    uid:me.id,name:me.username,team:myTeam,
    kps:kps.map(k=>({x:Math.round(k.x),y:Math.round(k.y),s:+k.score.toFixed(2)}))
  }}).catch(()=>{});

  countReps(kps);
}

function countReps(kps) {
  const C=0.30; let ang=null;
  if(exercise==='squat'){
    const lA=(kps[11].score>C&&kps[13].score>C&&kps[15].score>C)?angle3(kps[11],kps[13],kps[15]):null;
    const rA=(kps[12].score>C&&kps[14].score>C&&kps[16].score>C)?angle3(kps[12],kps[14],kps[16]):null;
    const vals=[lA,rA].filter(v=>v!==null);
    if(vals.length) ang=Math.round(vals.reduce((s,v)=>s+v,0)/vals.length);
  } else {
    const ls=kps[5],rs=kps[6],le=kps[7],re=kps[8],lw=kps[9],rw=kps[10];
    const ul=ls.score>=rs.score;
    const sh=ul?ls:rs,elb=ul?le:re,wri=ul?lw:rw;
    if(sh.score>C&&elb.score>C&&wri.score>C) ang=angle3(sh,elb,wri);
  }
  if(ang===null) return;
  myRepEma=myRepEma===null?ang:myRepEma+0.25*(ang-myRepEma);
  const s=Math.round(myRepEma);
  const cfg={squat:{down:110,downHys:105,up:155,upHys:160},pushup:{down:80,downHys:75,up:150,upHys:155}};
  const t=cfg[exercise]||cfg.squat;
  if(myRepPhase==='up'&&s<=t.downHys) myRepPhase='down';
  else if(myRepPhase==='down'&&s>=t.upHys){
    myRepPhase='up'; myReps++;
    peers[me.id].reps=myReps;
    updateScores();
    if(lobbyChannel) lobbyChannel.send({type:'broadcast',event:'rep',payload:{uid:me.id,reps:myReps,team:myTeam}}).catch(()=>{});
  }
}

function onPeerSkeleton(p) {
  const uid=p.uid; if(!uid||uid===me.id) return;
  if(!peers[uid]) assignPeer(uid,p.team||'b');
  peers[uid]={...peers[uid],name:p.name||'athlete',team:p.team||'b',kps:p.kps,lastSeen:Date.now()};
}

function onPeerRep(p) {
  const uid=p.uid; if(!uid) return;
  if(!peers[uid]) assignPeer(uid,p.team||'b');
  peers[uid]={...peers[uid],reps:p.reps,team:p.team||'b'};
  updateScores();
}

function updateScores() {
  const allP=Object.values(peers);
  const scoreA=allP.filter(p=>p.team==='a').reduce((s,p)=>s+(p.reps||0),0);
  const scoreB=allP.filter(p=>p.team==='b').reduce((s,p)=>s+(p.reps||0),0);
  document.getElementById('score-a').textContent=scoreA;
  document.getElementById('score-b').textContent=scoreB;
  // Chips
  const chips=document.getElementById('player-chips');
  chips.innerHTML=allP.sort((a,b)=>(b.reps||0)-(a.reps||0)).map(p=>`
    <div class="player-chip team-${p.team||'a'}">
      <div class="chip-name">${(p.name||'?').substring(0,7)}</div>
      <div class="chip-reps">${p.reps||0}</div>
    </div>`).join('');
}

// ── DRAW BATTLE ───────────────────────────────
function drawBattle() {
  const canvas=document.getElementById('battle-canvas');
  const arena =document.getElementById('battle-arena');
  const sw=arena.offsetWidth||window.innerWidth;
  const sh=arena.offsetHeight||300;
  if(canvas.width!==sw||canvas.height!==sh){canvas.width=sw;canvas.height=sh;}
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const now=Date.now();
  const teamA=Object.entries(peers).filter(([,p])=>p.team==='a'&&p.kps&&(now-p.lastSeen)<5000);
  const teamB=Object.entries(peers).filter(([,p])=>p.team==='b'&&p.kps&&(now-p.lastSeen)<5000);
  const half=canvas.width/2;

  // Team A background
  ctx.fillStyle='rgba(0,255,198,.04)';ctx.fillRect(0,0,half,canvas.height);
  // Team B background
  ctx.fillStyle='rgba(255,61,107,.04)';ctx.fillRect(half,0,half,canvas.height);

  // Labels
  ctx.font='bold 10px Space Mono,monospace';ctx.textAlign='center';
  ctx.fillStyle='rgba(0,255,198,.5)';ctx.fillText('⚔️ TEAM A',half/2,14);
  ctx.fillStyle='rgba(255,61,107,.5)';ctx.fillText('🛡️ TEAM B',half+half/2,14);

  // Divider
  ctx.strokeStyle='rgba(255,255,255,.08)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(half,0);ctx.lineTo(half,canvas.height);ctx.stroke();
  ctx.textAlign='left';

  drawTeam(ctx,teamA,0,0,half,canvas.height);
  drawTeam(ctx,teamB,half,0,half,canvas.height);
}

function drawTeam(ctx,entries,ox,oy,w,h) {
  if(!entries.length) return;
  const cols=Math.min(entries.length,3);
  const rows=Math.ceil(entries.length/cols);
  const cw=w/cols,ch=h/rows;
  const now=Date.now();
  entries.forEach(([uid,p],i)=>{
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

// ── END BATTLE ────────────────────────────────
function endBattle() {
  if (!battleRunning) return;
  battleRunning=false;
  clearInterval(trackInterval);
  clearInterval(renderInterval);
  clearInterval(timerInterval);

  // Stop camera
  const video=document.getElementById('battle-video');
  if(video.srcObject){video.srcObject.getTracks().forEach(t=>t.stop());video.srcObject=null;}

  // Calculate results
  const allP=Object.values(peers);
  const scoreA=allP.filter(p=>p.team==='a').reduce((s,p)=>s+(p.reps||0),0);
  const scoreB=allP.filter(p=>p.team==='b').reduce((s,p)=>s+(p.reps||0),0);
  const winnerTeam = scoreA>scoreB?'a':scoreB>scoreA?'b':null;

  document.getElementById('result-emoji').textContent = winnerTeam===myTeam?'🏆':winnerTeam===null?'🤝':'💀';
  document.getElementById('result-winner').textContent = winnerTeam===null?'Draw!'
    :winnerTeam==='a'?'⚔️ Team A Wins!':'🛡️ Team B Wins!';
  document.getElementById('result-winner').style.color = winnerTeam===null?'var(--muted)'
    :winnerTeam===myTeam?'var(--accent)':'var(--accent2)';
  document.getElementById('result-score-display').innerHTML =
    `<span style="color:var(--a)">${scoreA}</span> <span style="color:var(--muted)">—</span> <span style="color:var(--b)">${scoreB}</span>`;

  document.getElementById('result-player-stats').innerHTML=
    allP.sort((a,b)=>(b.reps||0)-(a.reps||0)).map(p=>`
      <div class="rps">
        <div class="rps-val" style="color:${p.team==='a'?'var(--a)':'var(--b)'}">${p.reps||0}</div>
        <div class="rps-name">${(p.name||'?').substring(0,8)}</div>
      </div>`).join('');

  // Save workout
  supa.auth.getSession().then(({data:{session}})=>{
    if(session?.user&&myReps>0){
      supa.from('workouts').insert({user_id:session.user.id,exercise,reps:myReps}).catch(()=>{});
    }
  });

  showView('result');
}

function resetState() {
  battleRunning=false; myReps=0; myRepPhase='up'; myRepEma=null;
  Object.keys(peers).forEach(k=>delete peers[k]);
  aIdx=0;bIdx=0;
}

// ── VIEW ──────────────────────────────────────
function showView(name){
  ['mode','lobby','battle','result'].forEach(v=>{
    document.getElementById('view-'+v).classList.toggle('hidden',v!==name);
  });
}
