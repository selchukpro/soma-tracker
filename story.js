// ── story.js v4 — monster health bar design ──

const SUPA_URL = 'https://jmkyakgzqdkavebtrnpj.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impta3lha2d6cWRrYXZlYnRybnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDI4MzIsImV4cCI6MjA4OTU3ODgzMn0.pNtqN1ejAW6dY2Ov35_ksX5ZQ5syvSdagYr5cjy8iIo';
const supa = supabase.createClient(SUPA_URL, SUPA_KEY);

// ── STORY DATA ────────────────────────────────
const CHAPTERS = [
  {
    id: 1,
    title: "Chapter I — The Awakening",
    subtitle: "Every legend begins with a single rep.",
    episodes: [
      { id:1, title:"First Steps",   monster:"Stone Golem",   monsterEmoji:"🪨", desc:"Your journey begins.",                        exercise:"squat",  target:10, xp:50  },
      { id:2, title:"Foundation",    monster:"Iron Brute",    monsterEmoji:"⚙️", desc:"Build the base. Squats forge a warrior.",     exercise:"squat",  target:20, xp:75  },
      { id:3, title:"Rising Up",     monster:"Shadow Bat",    monsterEmoji:"🦇", desc:"Push the earth away. Your first push-up.",    exercise:"pushup", target:5,  xp:80  },
      { id:4, title:"Double Down",   monster:"Rock Titan",    monsterEmoji:"🗿", desc:"Twice the effort, twice the reward.",         exercise:"squat",  target:30, xp:100 },
      { id:5, title:"Arms of Steel", monster:"Cave Spider",   monsterEmoji:"🕷️", desc:"The floor is your opponent. Defeat it.",     exercise:"pushup", target:10, xp:120 },
      { id:6, title:"The Gauntlet",  monster:"War Elephant",  monsterEmoji:"🐘", desc:"Combined strength. Prove you belong here.",  exercise:"squat",  target:40, xp:150 },
      { id:7, title:"Iron Will",     monster:"Dark Knight",   monsterEmoji:"⚔️", desc:"Push-ups until your arms speak fire.",       exercise:"pushup", target:15, xp:175 },
      { id:8, title:"The Summit",    monster:"Dragon King",   monsterEmoji:"🐉", desc:"Chapter finale. Give everything you have.",  exercise:"squat",  target:50, xp:200 },
    ]
  }
];

// ── STATE ─────────────────────────────────────
let currentUser  = null;
let completedSet = new Set();
let activeEp     = null;
let repCount     = 0;
let repPhase     = 'up';
let repEma       = null;
let goalMet      = false;
let detector     = null;
let running      = false;
let lastPoseTime = 0;
let monsterShakeTimeout = null;

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
const filtersX=Array.from({length:17},()=>new OneEuroFilter());
const filtersY=Array.from({length:17},()=>new OneEuroFilter());
function smoothPose(kps,ts){return kps.map((k,i)=>({...k,x:filtersX[i].filter(k.x,ts),y:filtersY[i].filter(k.y,ts)}));}
function emaAngle(a){repEma=repEma===null?a:repEma+0.25*(a-repEma);return repEma;}

// ── SKELETON ──────────────────────────────────
const CONNECTIONS=[[0,1],[0,2],[1,3],[2,4],[5,6],[5,11],[6,12],[11,12],[5,7],[7,9],[6,8],[8,10],[11,13],[13,15],[12,14],[14,16]];
function kpColor(i){return i<=4?'#a78bfa':i<=10?'#00ffc6':'#ff3d6b';}
function connColor(a,b){return(a<=4&&b<=4)?'#a78bfa':(a>=11||b>=11)?'#ff3d6b':'#00ffc6';}
function angle3(a,b,c){
  const ab={x:a.x-b.x,y:a.y-b.y},cb={x:c.x-b.x,y:c.y-b.y};
  const dot=ab.x*cb.x+ab.y*cb.y,mag=Math.hypot(ab.x,ab.y)*Math.hypot(cb.x,cb.y);
  return mag===0?180:Math.round(Math.acos(Math.min(1,Math.max(-1,dot/mag)))*180/Math.PI);
}
function avgAngles(...v){const f=v.filter(x=>x!==null);return f.length?Math.round(f.reduce((s,x)=>s+x,0)/f.length):null;}

const REP_CFG={
  squat: {down:110,downHys:105,up:155,upHys:160},
  pushup:{down:80, downHys:75, up:150,upHys:155},
};

// ── INIT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const {data:{session}} = await supa.auth.getSession().catch(()=>({data:{session:null}}));
  if (session?.user) {
    currentUser = session.user;
    console.log('Story: logged in as', currentUser.email);
  } else {
    console.log('Story: not logged in');
  }

  await reloadProgress();
  renderChapters();

  // Null-safe event binding
  const _bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
    else console.warn('story.js: missing element #' + id);
  };
  _bind('ep-abandon-btn', abandonEpisode);
  // complete-home-btn removed — cleared view uses cleared-continue-btn
  _bind('cleared-continue-btn', () => { showView('chapters'); renderChapters(); });
});

// ── LOAD PROGRESS ─────────────────────────────
async function reloadProgress() {
  if (!currentUser) return;

  // Load story_progress (profile 406 = row doesn't exist, that's OK)
  // story_progress is the SOURCE OF TRUTH — always recalculate from it
  const progressRes = await supa.from('story_progress')
    .select('chapter,episode,reps_done').eq('user_id', currentUser.id);

  if (progressRes.error) {
    console.error('story_progress load error:', progressRes.error.message);
  }

  completedSet.clear();
  (progressRes.data||[]).forEach(p => completedSet.add(`${p.chapter}-${p.episode}`));

  // Calculate XP directly from story_progress data
  let xp = 0;
  for(const ch of CHAPTERS)
    for(const ep of ch.episodes)
      if(completedSet.has(`${ch.id}-${ep.id}`)) xp += ep.xp;

  document.getElementById('story-xp-pill').textContent = xp + ' XP';
  console.log(`Progress loaded: ${completedSet.size} episodes done, ${xp} XP`);

  // Try to sync profiles.total_xp in background (non-critical)
  if (xp > 0) {
    supa.from('profiles').update({ total_xp: xp })
      .eq('id', currentUser.id)
      .then(({ error }) => {
        if (error) console.warn('Profile XP sync failed (non-critical):', error.message);
        else console.log('Profile XP synced to', xp);
      });
  }
}

// ── RENDER CHAPTERS ───────────────────────────
function renderChapters() {
  const body = document.getElementById('chapters-body');
  let html = '';
  for (const ch of CHAPTERS) {
    const doneCount = ch.episodes.filter(e=>completedSet.has(`${ch.id}-${e.id}`)).length;
    const totalXp   = ch.episodes.filter(e=>completedSet.has(`${ch.id}-${e.id}`)).reduce((s,e)=>s+e.xp,0);
    const pct       = Math.round(doneCount/ch.episodes.length*100);
    html += `
      <div class="chapter-block">
        <div class="ch-header">
          <div>
            <div class="ch-title">${doneCount===ch.episodes.length?'✅ ':''}${ch.title}</div>
            <div class="ch-sub">${ch.subtitle}</div>
          </div>
          <div class="ch-meta">
            <div class="ch-prog">${doneCount}/${ch.episodes.length}</div>
            <div class="ch-xp">${totalXp} XP</div>
          </div>
        </div>
        <div class="ch-bar"><div class="ch-fill" style="width:${pct}%"></div></div>
        <div class="ep-list">`;
    ch.episodes.forEach((ep,i) => {
      const isDone   = completedSet.has(`${ch.id}-${ep.id}`);
      const isLocked = i>0 && !completedSet.has(`${ch.id}-${ch.episodes[i-1].id}`);
      const isCurrent= !isDone && !isLocked;
      const exIcon   = ep.exercise==='squat'?'🦵':'💪';
      const stateIcon= isDone?'✅':isLocked?'🔒':'⚔️';
      const cardClass= isDone?'done':isLocked?'locked':isCurrent?'current':'';
      html += `
        <div class="ep-card ${cardClass}">
          <div class="ep-icon">${stateIcon}</div>
          <div class="ep-info">
            <div class="ep-name">Ep.${ep.id} — ${ep.title}</div>
            <div class="ep-monster">${ep.monsterEmoji} vs <strong>${ep.monster}</strong></div>
            <div class="ep-tags">
              <span class="ep-tag">${exIcon} ${ep.exercise}</span>
              <span class="ep-tag">${ep.target} reps</span>
              <span class="ep-tag xp">+${ep.xp} XP</span>
              ${isDone?'<span class="ep-tag done-tag">✓ Defeated</span>':''}
            </div>
          </div>
          ${!isLocked&&!isDone?`<button class="ep-start-btn" data-ch="${ch.id}" data-ep="${ep.id}">Fight!</button>`:''}
          ${isDone?`<button class="ep-retry-btn" data-ch="${ch.id}" data-ep="${ep.id}">Retry</button>`:''}
        </div>`;
    });
    html += `</div></div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll('.ep-start-btn, .ep-retry-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!currentUser) { alert('Please sign in to play Story mode.'); return; }
      const ch=CHAPTERS.find(c=>c.id===parseInt(btn.dataset.ch));
      const ep=ch?.episodes.find(e=>e.id===parseInt(btn.dataset.ep));
      if (ep) startEpisode(ch, ep);
    });
  });
}

// ── START EPISODE ─────────────────────────────
async function startEpisode(chapter, episode) {
  activeEp = { chapter, episode };
  repCount = 0; repPhase = 'up'; repEma = null; goalMet = false;
  filtersX.forEach(f=>{f.xFilt=null;f.dxFilt=null;f.lastTime=null;});
  filtersY.forEach(f=>{f.xFilt=null;f.dxFilt=null;f.lastTime=null;});

  // Set up monster HUD
  document.getElementById('ep-monster-emoji').textContent  = episode.monsterEmoji;
  document.getElementById('ep-monster-name').textContent   = episode.monster;
  document.getElementById('ep-monster-hp-fill').style.width = '100%';
  document.getElementById('ep-monster-hp-fill').style.background = '#ff3d6b';
  document.getElementById('ep-monster-hp-text').textContent = episode.target + ' HP';
  document.getElementById('ep-title-hud').textContent      = `Ep.${episode.id} — ${episode.title}`;
  document.getElementById('ep-xp-badge').textContent       = `+${episode.xp} XP`;
  document.getElementById('ep-rep-count').textContent      = '0';
  document.getElementById('ep-loading').classList.remove('hidden');
  document.getElementById('ep-monster-wrap').classList.remove('monster-dead');

  showView('episode');
  await startCamera();
}

// ── CAMERA ────────────────────────────────────
async function startCamera() {
  const video  = document.getElementById('ep-video');
  const canvas = document.getElementById('ep-canvas');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false
    });
    video.srcObject = stream;
    await new Promise(r=>video.onloadedmetadata=r);
    video.play();
    setLoadingText('loading model…');
    if (!detector) await loadDetector(); else hideEpLoading();
    canvas.width=video.videoWidth; canvas.height=video.videoHeight;
    canvas.style.width='100%'; canvas.style.height='100%';
    running = true;
    requestAnimationFrame(trackLoop);
  } catch(e) {
    setLoadingText('Camera denied — allow camera & refresh.');
    console.error(e);
  }
}

function stopCamera() {
  running = false;
  const video = document.getElementById('ep-video');
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t=>t.stop());
    video.srcObject = null;
  }
}

async function loadDetector() {
  try {
    await tf.ready();
    setLoadingText('backend: '+tf.getBackend()+'…');
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {modelType:poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,enableSmoothing:false}
    );
    hideEpLoading();
  } catch(e) {
    try {
      await tf.setBackend('cpu'); await tf.ready();
      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {modelType:poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,enableSmoothing:false}
      );
      hideEpLoading();
    } catch(e2) {
      setLoadingText('Model failed. Need internet on first load.');
    }
  }
}

// ── TRACK LOOP ────────────────────────────────
async function trackLoop(ts) {
  if (!running) return;
  requestAnimationFrame(trackLoop);
  if (!detector) return;
  if (ts - lastPoseTime < 33) return;
  lastPoseTime = ts;
  const video  = document.getElementById('ep-video');
  const canvas = document.getElementById('ep-canvas');
  const ctx    = canvas.getContext('2d');
  if (video.readyState < 2) return;
  let poses;
  try { poses = await detector.estimatePoses(video,{flipHorizontal:false}); } catch(e){ return; }
  if (!poses?.length) return;
  if (canvas.width!==video.videoWidth){canvas.width=video.videoWidth;canvas.height=video.videoHeight;}
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const kps = smoothPose(poses[0].keypoints, ts/1000);
  drawSkeleton(ctx, canvas, kps);
  processReps(kps, canvas);
}

// ── DRAW SKELETON ─────────────────────────────
function drawSkeleton(ctx, canvas, kps) {
  const C=0.25;
  for(const[a,b]of CONNECTIONS){
    const ka=kps[a],kb=kps[b];
    if(ka.score<C||kb.score<C)continue;
    ctx.beginPath();ctx.moveTo(ka.x,ka.y);ctx.lineTo(kb.x,kb.y);
    ctx.strokeStyle=connColor(a,b);ctx.lineWidth=3;
    ctx.globalAlpha=Math.min(ka.score,kb.score);ctx.stroke();ctx.globalAlpha=1;
  }
  for(let i=0;i<kps.length;i++){
    const k=kps[i];if(k.score<C)continue;
    const col=kpColor(i),r=i===0?7:i<=4?5:i<=10?7:8;
    ctx.beginPath();ctx.arc(k.x,k.y,r+6,0,Math.PI*2);
    ctx.fillStyle=col;ctx.globalAlpha=k.score*.18;ctx.fill();ctx.globalAlpha=1;
    ctx.beginPath();ctx.arc(k.x,k.y,r,0,Math.PI*2);
    ctx.fillStyle=col;ctx.globalAlpha=Math.min(1,k.score*1.2);ctx.fill();ctx.globalAlpha=1;
    ctx.beginPath();ctx.arc(k.x,k.y,r*.45,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,.7)';ctx.globalAlpha=k.score*.5;ctx.fill();ctx.globalAlpha=1;
  }
}

// ── REP PROCESSING ────────────────────────────
function processReps(kps, canvas) {
  if (!activeEp || goalMet) return;
  const ex  = activeEp.episode.exercise;
  const cfg = REP_CFG[ex];
  const C   = 0.30;
  let rawAngle = null;

  if (ex==='squat') {
    const lA=(kps[11].score>C&&kps[13].score>C&&kps[15].score>C)?angle3(kps[11],kps[13],kps[15]):null;
    const rA=(kps[12].score>C&&kps[14].score>C&&kps[16].score>C)?angle3(kps[12],kps[14],kps[16]):null;
    rawAngle=avgAngles(lA,rA);
    document.getElementById('ep-live-label').textContent=lA&&rA?'both knees':lA?'L knee':rA?'R knee':'no legs visible';
  }
  else if (ex==='pushup') {
    const ls=kps[5],rs=kps[6],lh=kps[11],rh=kps[12],la=kps[15],ra=kps[16];
    const le=kps[7],lw=kps[9],re=kps[8],rw=kps[10];
    const useLeft=ls.score>=rs.score;
    const sh=useLeft?ls:rs,hip=useLeft?lh:rh,ank=useLeft?la:ra;
    const elb=useLeft?le:re,wri=useLeft?lw:rw;
    const bodyVis=sh.score>C&&hip.score>C&&(la.score>C||ra.score>C);
    let isHoriz=false;
    if(bodyVis){
      const ankY=ank.score>C?ank.y:(la.score>C?la.y:ra.y);
      isHoriz=(Math.max(sh.y,hip.y,ankY)-Math.min(sh.y,hip.y,ankY))/canvas.height<0.22;
    }
    const isSide=!(ls.score>0.4&&rs.score>0.4)||Math.abs(ls.x-rs.x)/canvas.width<0.15;
    if(!bodyVis||!isHoriz||!isSide){
      const reason=!bodyVis?'show full body':!isHoriz?'get into plank':'turn sideways';
      document.getElementById('ep-live-label').textContent=reason;
      document.getElementById('ep-live-angle').textContent='—';
      const ctx=canvas.getContext('2d');
      ctx.save();
      ctx.fillStyle='rgba(255,61,107,.07)';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.font='bold 14px Syne,sans-serif';ctx.fillStyle='rgba(255,80,80,.9)';
      ctx.textAlign='center';ctx.fillText('▸ '+reason.toUpperCase(),canvas.width/2,canvas.height*.5);
      ctx.textAlign='left';ctx.restore();
      return;
    }
    if(sh.score>C&&elb.score>C&&wri.score>C){
      rawAngle=angle3(sh,elb,wri);
      document.getElementById('ep-live-label').textContent=(useLeft?'L':'R')+' elbow · side✓';
    }
  }

  if(rawAngle===null){document.getElementById('ep-live-angle').textContent='—';return;}
  const smoothed=Math.round(emaAngle(rawAngle));
  document.getElementById('ep-live-angle').textContent=smoothed+'°';

  const pct=Math.max(0,Math.min(100,(1-(smoothed-cfg.down)/(cfg.up-cfg.down))*100));
  document.getElementById('ep-phase-fill').style.width      =pct+'%';
  document.getElementById('ep-phase-fill').style.background =repPhase==='down'?'#ff3d6b':'#00ffc6';
  document.getElementById('ep-phase-txt').textContent       =repPhase==='down'?'▼ DOWN':'▲ UP';

  if(repPhase==='up'&&smoothed<=cfg.downHys) repPhase='down';
  else if(repPhase==='down'&&smoothed>=cfg.upHys){
    repPhase='up'; repCount++;
    updateMonsterHP();
  }
}

// ── MONSTER HP ────────────────────────────────
function updateMonsterHP() {
  if (!activeEp) return;
  const target  = activeEp.episode.target;
  const hp      = Math.max(0, target - repCount);
  const hpPct   = (hp / target) * 100;

  // Update rep counter
  document.getElementById('ep-rep-count').textContent = repCount;

  // HP bar color: green → yellow → red
  const hpColor = hpPct > 60 ? '#ff3d6b' : hpPct > 30 ? '#fbbf24' : '#00ffc6';
  const bar = document.getElementById('ep-monster-hp-fill');
  bar.style.width      = hpPct + '%';
  bar.style.background = hpColor;
  document.getElementById('ep-monster-hp-text').textContent = hp + ' HP';

  // Monster shake on hit
  const wrap = document.getElementById('ep-monster-wrap');
  wrap.classList.add('monster-hit');
  clearTimeout(monsterShakeTimeout);
  monsterShakeTimeout = setTimeout(()=>wrap.classList.remove('monster-hit'), 300);

  // Flash rep counter
  const el = document.getElementById('ep-rep-count');
  el.style.color='#fff'; setTimeout(()=>el.style.color='var(--accent)',200);

  // Goal met — monster defeated!
  if (repCount >= target && !goalMet) {
    goalMet = true;
    wrap.classList.add('monster-dead');
    bar.style.width = '0%';
    document.getElementById('ep-monster-hp-text').textContent = 'DEFEATED!';
    // Auto-trigger complete after 1.5s dramatic pause
    setTimeout(()=>completeEpisode(), 1500);
  }
}

// ── COMPLETE EPISODE ──────────────────────────
async function completeEpisode() {
  if (!activeEp) return;

  const chapter      = activeEp.chapter;
  const episode      = activeEp.episode;
  const repsAchieved = repCount;

  stopCamera();
  activeEp = null;

  // Always add to local set immediately
  completedSet.add(`${chapter.id}-${episode.id}`);

  // Calculate XP
  let totalXp = 0;
  for(const ch of CHAPTERS)
    for(const ep of ch.episodes)
      if(completedSet.has(`${ch.id}-${ep.id}`)) totalXp += ep.xp;

  // Update XP pill immediately (don't wait for network)
  document.getElementById('story-xp-pill').textContent = totalXp + ' XP';

  // Show cleared screen immediately (don't block on save)
  document.getElementById('cleared-ep-name').textContent  = `${episode.monsterEmoji} ${episode.monster} Defeated!`;
  document.getElementById('cleared-reps').textContent     = repsAchieved;
  document.getElementById('cleared-xp').textContent       = '+' + episode.xp + ' XP';
  document.getElementById('cleared-ep-title').textContent = `Ep.${episode.id} — ${episode.title}`;
  showView('cleared');

  // Save in background (non-blocking)
  saveEpisodeToServer(chapter, episode, repsAchieved, totalXp);
}

async function saveEpisodeToServer(chapter, episode, repsAchieved, totalXp) {
  try {
    const { data:{ session } } = await supa.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) { console.warn('Not logged in — not saved to server'); return; }

    console.log('Saving episode', chapter.id, episode.id, 'for user', uid);

    // 1. story_progress — try insert first, then update if exists
    const { error: insertErr } = await supa.from('story_progress').insert({
      user_id:      uid,
      chapter:      chapter.id,
      episode:      episode.id,
      reps_done:    repsAchieved,
      completed_at: new Date().toISOString()
    });

    if (insertErr) {
      // Already exists — update it
      const { error: updateErr } = await supa.from('story_progress').update({
        reps_done:    repsAchieved,
        completed_at: new Date().toISOString()
      }).eq('user_id', uid).eq('chapter', chapter.id).eq('episode', episode.id);
      if (updateErr) console.error('story_progress update error:', updateErr.message);
      else console.log('story_progress updated OK');
    } else {
      console.log('story_progress inserted OK');
    }

    // 2. workouts
    const { error: wErr } = await supa.from('workouts').insert({
      user_id:  uid,
      exercise: episode.exercise,
      reps:     repsAchieved
    });
    if (wErr) console.error('workout save error:', wErr.message);
    else      console.log('workout saved OK');

    // 3. profiles — update XP and story position
    let nextCh = chapter.id, nextEp = episode.id + 1;
    if (nextEp > chapter.episodes.length) { nextCh = chapter.id + 1; nextEp = 1; }

    // Try update first
    const { data: pData, error: pErr } = await supa.from('profiles').update({
      total_xp:      totalXp,
      story_chapter: nextCh,
      story_episode: nextEp
    }).eq('id', uid).select();

    if (pErr) {
      console.error('profiles update error:', pErr.message);
    } else if (!pData || pData.length === 0) {
      // Row didn't exist — insert it
      console.log('Profile row missing, inserting...');
      const { error: piErr } = await supa.from('profiles').insert({
        id:            uid,
        username:      currentUser?.email?.split('@')[0] || 'athlete',
        total_xp:      totalXp,
        story_chapter: nextCh,
        story_episode: nextEp
      });
      if (piErr) console.error('profiles insert error:', piErr.message);
      else       console.log('Profile created with XP:', totalXp);
    } else {
      console.log('Profile XP updated to', totalXp, '— next ep:', nextCh, nextEp);
    }

  } catch(e) {
    console.error('saveEpisodeToServer crash:', e.message);
  }
}

// ── ABANDON ───────────────────────────────────
function abandonEpisode() {
  stopCamera();
  activeEp = null; repCount = 0; repPhase = 'up'; repEma = null; goalMet = false;
  showView('chapters');
  renderChapters();
}

// ── VIEW SWITCHER ─────────────────────────────
function showView(name) {
  ['chapters','episode','cleared'].forEach(v => {
    document.getElementById('view-'+v).classList.toggle('hidden', v !== name);
  });
}

function setLoadingText(t) { document.getElementById('ep-loading-text').textContent = t; }
function hideEpLoading()    { document.getElementById('ep-loading').classList.add('hidden'); }

// ── DEBUG: call testSave() from browser console to test saving ──
async function testSave() {
  console.log('=== testSave START ===');
  const { data:{ session } } = await supa.auth.getSession();
  const uid = session?.user?.id;
  console.log('uid:', uid);
  if (!uid) { console.error('NOT LOGGED IN'); return; }

  // Test story_progress insert
  const { error: e1 } = await supa.from('story_progress').insert({
    user_id: uid, chapter: 99, episode: 99, reps_done: 1,
    completed_at: new Date().toISOString()
  });
  console.log('story_progress test insert:', e1 ? 'ERROR: '+e1.message : 'OK');

  // Clean up test row
  await supa.from('story_progress').delete().eq('user_id', uid).eq('chapter', 99);

  // Test profiles update
  const { error: e2 } = await supa.from('profiles').update({ total_xp: 999 }).eq('id', uid);
  console.log('profiles update test:', e2 ? 'ERROR: '+e2.message : 'OK');

  // Reset
  await supa.from('profiles').update({ total_xp: 0 }).eq('id', uid);
  console.log('=== testSave END ===');
}
window.testSave = testSave;
