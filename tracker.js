// ── tracker.js — camera, pose detection, rep counting, full body validation ──

const video  = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

let detector     = null;
let running      = false;
let fps          = 0;
let frameCount   = 0;
let lastFpsTime  = 0;
let lastPoseTime = 0;
let repCount     = 0;
let repPhase     = 'up';
let repEma       = null;
let postureAlertTimer = null;

const layers = { skeleton:true, angles:false, posture:false };
let showReps = false;

// ══════════════════════════════════════════════
//  FULL BODY VALIDATION SYSTEM
//  Each exercise defines:
//   required  — joints that MUST be visible to count a rep
//   preferred — joints that improve confidence score if visible
//   minConf   — minimum per-joint confidence threshold
//   minScore  — minimum overall body confidence score (0-100)
// ══════════════════════════════════════════════
const BODY_VALIDATION = {
  squat: {
    required:  [5,6,11,12,13,14,15,16], // both shoulders, hips, knees, ankles
    preferred: [0,7,8],                  // head, elbows (bonus)
    minConf:   0.35,
    minScore:  60,
    hint: 'Stand sideways · full legs must be visible'
  },
  lunge: {
    required:  [5,6,11,12,13,14,15,16],
    preferred: [0,7,8],
    minConf:   0.35,
    minScore:  55,
    hint: 'Stand sideways · full legs must be visible'
  },
  curl: {
    required:  [5,6,7,8,9,10],          // both shoulders, elbows, wrists
    preferred: [0,11,12],
    minConf:   0.35,
    minScore:  50,
    hint: 'Face camera · both arms must be visible'
  },
  pushup: {
    required:  [5,6,7,8,11,12,15,16],   // shoulders, elbows, hips, ankles
    preferred: [9,10,13,14],             // wrists, knees
    minConf:   0.30,
    minScore:  55,
    hint: 'Lie sideways · full body must be in frame'
  },
  shoulder: {
    required:  [5,6,7,8,9,10],
    preferred: [0,11,12],
    minConf:   0.35,
    minScore:  50,
    hint: 'Face camera · both arms must be visible'
  },
};

// Keypoint names for readable feedback
const KP_NAMES = [
  'nose','l.eye','r.eye','l.ear','r.ear',
  'l.shoulder','r.shoulder','l.elbow','r.elbow',
  'l.wrist','r.wrist','l.hip','r.hip',
  'l.knee','r.knee','l.ankle','r.ankle'
];

// Compute body confidence score for current exercise
// Returns { score: 0-100, missing: [], valid: bool }
function getBodyConfidence(kps, mode) {
  const val = BODY_VALIDATION[mode];
  if (!val) return { score:100, missing:[], valid:true };

  const C = val.minConf;
  const missing = [];
  let requiredVisible = 0;
  let preferredVisible = 0;

  for (const idx of val.required) {
    if (kps[idx].score >= C) requiredVisible++;
    else missing.push(KP_NAMES[idx]);
  }
  for (const idx of val.preferred) {
    if (kps[idx].score >= C) preferredVisible++;
  }

  // Score: required joints = 80% weight, preferred = 20%
  const reqScore  = (requiredVisible / val.required.length) * 80;
  const prefScore = val.preferred.length > 0
    ? (preferredVisible / val.preferred.length) * 20
    : 20;
  const score = Math.round(reqScore + prefScore);
  const valid = score >= val.minScore && requiredVisible >= Math.ceil(val.required.length * 0.75);

  return { score, missing: missing.slice(0,3), valid };
}

// Draw body confidence overlay on canvas
function drawBodyConfidence(kps, mode, conf) {
  const { score, missing, valid } = conf;

  // Color based on score
  const color = score >= 80 ? '#00ffc6' : score >= 55 ? '#fbbf24' : '#ff3d6b';

  // Score badge — top left corner
  ctx.save();
  ctx.fillStyle = 'rgba(10,10,15,0.75)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(10, 10, 110, 32, 6);
  else ctx.rect(10, 10, 110, 32);
  ctx.fill();

  ctx.font = 'bold 10px Space Mono, monospace';
  ctx.fillStyle = color;
  ctx.fillText('BODY ' + score + '%', 18, 31);

  // Missing joints warning
  if (!valid && missing.length > 0) {
    ctx.fillStyle = 'rgba(10,10,15,0.7)';
    const w = Math.min(280, missing.length * 90 + 20);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(10, 48, w, 22, 4);
    else ctx.rect(10, 48, w, 22);
    ctx.fill();
    ctx.font = '9px Space Mono, monospace';
    ctx.fillStyle = '#ff3d6b';
    ctx.fillText('⚠ need: ' + missing.join(', '), 16, 63);
  }

  // Highlight missing joints on skeleton with red rings
  if (!valid) {
    const val = BODY_VALIDATION[mode];
    for (const idx of val.required) {
      if (kps[idx].score < val.minConf) {
        // Draw pulsing red circle at expected position
        // If joint not detected, show at last known area or skip
        if (kps[idx].x > 0 && kps[idx].y > 0) {
          ctx.beginPath();
          ctx.arc(kps[idx].x, kps[idx].y, 14, 0, Math.PI * 2);
          ctx.strokeStyle = '#ff3d6b';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.globalAlpha = 0.7;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // Hint text if invalid
  if (!valid) {
    const hint = BODY_VALIDATION[mode]?.hint || '';
    ctx.font = 'bold 13px Syne, sans-serif';
    ctx.fillStyle = 'rgba(255,61,107,0.85)';
    ctx.textAlign = 'center';
    ctx.fillText(hint, canvas.width / 2, canvas.height * 0.88);
    ctx.textAlign = 'left';
  }

  ctx.restore();
  return valid;
}

// ── ONE-EURO FILTER ───────────────────────────
class OneEuroFilter {
  constructor(freq=30, minCutoff=1.5, beta=0.01, dCutoff=1.0) {
    this.freq=freq; this.minCutoff=minCutoff; this.beta=beta; this.dCutoff=dCutoff;
    this.xFilt=null; this.dxFilt=null; this.lastTime=null;
  }
  alpha(c) { const te=1/this.freq, tau=1/(2*Math.PI*c); return 1/(1+tau/te); }
  filter(x, ts) {
    if (this.lastTime!==null) this.freq = 1/(ts-this.lastTime) || this.freq;
    this.lastTime = ts;
    const dx  = this.xFilt===null ? 0 : (x-this.xFilt)*this.freq;
    const dxH = this.dxFilt===null ? dx : this.dxFilt + this.alpha(this.dCutoff)*(dx-this.dxFilt);
    this.dxFilt = dxH;
    const xH  = this.xFilt===null ? x : this.xFilt + this.alpha(this.minCutoff+this.beta*Math.abs(dxH))*(x-this.xFilt);
    this.xFilt = xH; return xH;
  }
}
const filtersX = Array.from({length:17}, () => new OneEuroFilter());
const filtersY = Array.from({length:17}, () => new OneEuroFilter());
function smoothPose(kps, ts) {
  return kps.map((k,i) => ({ ...k, x:filtersX[i].filter(k.x,ts), y:filtersY[i].filter(k.y,ts) }));
}
const EMA_A = 0.25;
function emaAngle(a) { repEma = repEma===null ? a : repEma + EMA_A*(a-repEma); return repEma; }

// ── SKELETON ──────────────────────────────────
const CONNECTIONS = [
  [0,1],[0,2],[1,3],[2,4],
  [5,6],[5,11],[6,12],[11,12],
  [5,7],[7,9],[6,8],[8,10],
  [11,13],[13,15],[12,14],[14,16]
];
function kpColor(i)     { return i<=4?'#a78bfa' : i<=10?'#00ffc6' : '#ff3d6b'; }
function connColor(a,b) { return (a<=4&&b<=4)?'#a78bfa' : (a>=11||b>=11)?'#ff3d6b' : '#00ffc6'; }

// ── MATH ──────────────────────────────────────
function angle3(a,b,c) {
  const ab={x:a.x-b.x,y:a.y-b.y}, cb={x:c.x-b.x,y:c.y-b.y};
  const dot=ab.x*cb.x+ab.y*cb.y, mag=Math.hypot(ab.x,ab.y)*Math.hypot(cb.x,cb.y);
  return mag===0 ? 180 : Math.round(Math.acos(Math.min(1,Math.max(-1,dot/mag)))*180/Math.PI);
}
function avgAngles(...v) { const f=v.filter(x=>x!==null); return f.length?Math.round(f.reduce((s,x)=>s+x,0)/f.length):null; }
function bestAngle(a,ca,b,cb,t) { if(ca>t&&cb>t) return Math.round((a+b)/2); if(ca>t) return a; if(cb>t) return b; return null; }

// ── CAMERA ────────────────────────────────────
async function startTracking() {
  document.getElementById('start-screen').classList.add('hidden');
  showLoader('accessing camera…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode:'user', width:{ideal:640}, height:{ideal:480} }, audio:false
    });
    video.srcObject = stream;
    await new Promise(r => video.onloadedmetadata = r);
    video.classList.add('visible');
    populateCamSelect(stream);
    if (!detector) await loadDetector(); else hideLoading();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    document.getElementById('metrics').classList.add('visible');
    startWorkoutTimer();
    running = true;
    requestAnimationFrame(loop);
  } catch(e) {
    setStatus('error','Cam denied');
    showLoader('Camera access denied — allow camera & refresh.');
  }
}

async function loadDetector() {
  setStatus('loading','Loading…');
  showLoader('loading MoveNet model…');
  try {
    await tf.ready();
    showLoader('backend: '+tf.getBackend()+' — fetching weights…');
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING, enableSmoothing:false }
    );
    setStatus('ready', 'Ready · '+tf.getBackend().toUpperCase());
    hideLoading();
  } catch(e) {
    try {
      await tf.setBackend('cpu'); await tf.ready();
      showLoader('Retrying on CPU…');
      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING, enableSmoothing:false }
      );
      setStatus('ready','Ready · CPU'); hideLoading();
    } catch(e2) {
      setStatus('error','Load failed');
      showLoader('Model failed. Need internet on first load. Error: '+(e2.message||e2));
    }
  }
}

async function populateCamSelect(stream) {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const cams = devs.filter(d => d.kind==='videoinput');
  if (cams.length < 2) return;
  const sel = document.getElementById('cam-select');
  sel.style.display = 'block';
  cams.forEach((c,i) => {
    const o = document.createElement('option');
    o.value = c.deviceId; o.textContent = c.label || `Cam ${i+1}`;
    const t = stream.getVideoTracks()[0];
    if (t && c.label===t.label) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = async () => {
    const s = await navigator.mediaDevices.getUserMedia({ video:{ deviceId:{exact:sel.value} } });
    video.srcObject = s;
    filtersX.forEach(f=>{ f.xFilt=null; f.dxFilt=null; f.lastTime=null; });
    filtersY.forEach(f=>{ f.xFilt=null; f.dxFilt=null; f.lastTime=null; });
  };
}

function resizeCanvas() {
  canvas.width  = video.videoWidth  || canvas.offsetWidth;
  canvas.height = video.videoHeight || canvas.offsetHeight;
  canvas.style.width='100%'; canvas.style.height='100%';
}

// ── MAIN LOOP ─────────────────────────────────
async function loop(ts) {
  if (!running) return;
  requestAnimationFrame(loop);
  frameCount++;
  if (ts-lastFpsTime >= 1000) {
    fps=frameCount; frameCount=0; lastFpsTime=ts;
    document.getElementById('mv-fps').textContent = fps;
  }
  if (!detector || video.readyState < 2) return;
  if (ts-lastPoseTime < 33) return;
  lastPoseTime = ts;

  let poses;
  try { poses = await detector.estimatePoses(video, {flipHorizontal:false}); } catch(e) { return; }
  if (canvas.width !== video.videoWidth) resizeCanvas();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if (!poses || !poses.length) return;

  const kps = smoothPose(poses[0].keypoints, ts/1000);
  const avgConf = kps.reduce((s,k)=>s+k.score,0)/kps.length;
  document.getElementById('mv-conf').textContent = (avgConf*100).toFixed(0)+'%';

  if (layers.skeleton) drawSkeleton(kps);
  if (layers.angles)   drawAngles(kps);
  if (layers.posture)  analysePosture(kps);

  // Full body validation — runs whenever rep mode is active
  if (showReps) {
    const mode = document.getElementById('rep-mode').value;
    const conf = getBodyConfidence(kps, mode);
    const bodyOk = drawBodyConfidence(kps, mode, conf);
    if (bodyOk) countReps(kps);
    else {
      // Body not valid — reset EMA so no false phase carry-over
      repEma = null;
      document.getElementById('rep-live-angle').textContent = '—';
      document.getElementById('phase-txt').textContent = 'PHASE: —';
      document.getElementById('phase-fill').style.width = '0%';
    }
  }

  updateKneeMetric(kps);
}

// ── DRAW SKELETON ─────────────────────────────
function drawSkeleton(kps) {
  const C = 0.25;
  for (const [a,b] of CONNECTIONS) {
    const ka=kps[a], kb=kps[b];
    if (ka.score<C || kb.score<C) continue;
    ctx.beginPath(); ctx.moveTo(ka.x,ka.y); ctx.lineTo(kb.x,kb.y);
    ctx.strokeStyle=connColor(a,b); ctx.lineWidth=3;
    ctx.globalAlpha=Math.min(ka.score,kb.score); ctx.stroke(); ctx.globalAlpha=1;
  }
  for (let i=0; i<kps.length; i++) {
    const k=kps[i]; if (k.score<C) continue;
    const col=kpColor(i), r=i===0?7:i<=4?5:i<=10?7:8;
    ctx.beginPath(); ctx.arc(k.x,k.y,r+6,0,Math.PI*2);
    ctx.fillStyle=col; ctx.globalAlpha=k.score*.18; ctx.fill(); ctx.globalAlpha=1;
    ctx.beginPath(); ctx.arc(k.x,k.y,r,0,Math.PI*2);
    ctx.fillStyle=col; ctx.globalAlpha=Math.min(1,k.score*1.2); ctx.fill(); ctx.globalAlpha=1;
    ctx.beginPath(); ctx.arc(k.x,k.y,r*.45,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,.7)'; ctx.globalAlpha=k.score*.5; ctx.fill(); ctx.globalAlpha=1;
  }
  for (const ai of [15,16]) {
    const k=kps[ai]; if (k.score<C) continue;
    ctx.beginPath(); ctx.moveTo(k.x,k.y+8); ctx.lineTo(k.x-5,k.y+16); ctx.lineTo(k.x+5,k.y+16); ctx.closePath();
    ctx.fillStyle='#ff3d6b'; ctx.globalAlpha=k.score*.7; ctx.fill(); ctx.globalAlpha=1;
  }
}

// ── DRAW ANGLES ───────────────────────────────
function drawAngles(kps) {
  const C = 0.35;
  const joints = [
    {pts:[5,7,9],col:'#00ffc6'},{pts:[6,8,10],col:'#00ffc6'},
    {pts:[11,13,15],col:'#ff3d6b'},{pts:[12,14,16],col:'#ff3d6b'},
    {pts:[5,11,13],col:'#fbbf24'},{pts:[6,12,14],col:'#fbbf24'},
    {pts:[7,5,11],col:'#a78bfa'},{pts:[8,6,12],col:'#a78bfa'},
  ];
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
      this.beginPath();this.moveTo(x+r,y);this.lineTo(x+w-r,y);this.quadraticCurveTo(x+w,y,x+w,y+r);
      this.lineTo(x+w,y+h-r);this.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
      this.lineTo(x+r,y+h);this.quadraticCurveTo(x,y+h,x,y+h-r);
      this.lineTo(x,y+r);this.quadraticCurveTo(x,y,x+r,y);this.closePath();
    };
  }
  ctx.font = 'bold 10px Space Mono,monospace';
  for (const j of joints) {
    const [ai,bi,ci]=j.pts, a=kps[ai],b=kps[bi],c=kps[ci];
    if (a.score<C||b.score<C||c.score<C) continue;
    const deg=angle3(a,b,c);
    const v1=Math.atan2(a.y-b.y,a.x-b.x), v2=Math.atan2(c.y-b.y,c.x-b.x);
    ctx.beginPath(); ctx.arc(b.x,b.y,18,v1,v2);
    ctx.strokeStyle=j.col; ctx.lineWidth=2; ctx.globalAlpha=.55; ctx.stroke(); ctx.globalAlpha=1;
    ctx.fillStyle='rgba(10,10,15,.75)';
    ctx.beginPath(); ctx.roundRect(b.x+19,b.y-16,38,14,3); ctx.fill();
    ctx.fillStyle=j.col; ctx.fillText(deg+'°', b.x+22, b.y-6);
  }
}

// ── POSTURE ───────────────────────────────────
function analysePosture(kps) {
  const C=0.4; let score=100; const issues=[];
  const ls=kps[5],rs=kps[6],lh=kps[11],rh=kps[12],nose=kps[0];
  if (ls.score>C&&rs.score>C) {
    const t=Math.abs(ls.y-rs.y)/canvas.height*100;
    if (t>4){score-=20;issues.push('shoulder tilt');}else if(t>2)score-=10;
  }
  if (nose.score>C&&ls.score>C&&rs.score>C) {
    const off=Math.abs(nose.x-(ls.x+rs.x)/2)/canvas.width*100;
    if (off>8){score-=15;issues.push('head forward');}
  }
  if (ls.score>C&&rs.score>C&&lh.score>C&&rh.score>C) {
    const smx=(ls.x+rs.x)/2, hmx=(lh.x+rh.x)/2;
    if (Math.abs(smx-hmx)/canvas.width*100>8){score-=15;issues.push('lateral lean');}
    const smy=(ls.y+rs.y)/2, hmy=(lh.y+rh.y)/2;
    ctx.beginPath(); ctx.moveTo(smx,smy); ctx.lineTo(hmx,hmy);
    ctx.strokeStyle=score>=80?'#00ffc6':score>=60?'#fbbf24':'#ff3d6b';
    ctx.lineWidth=2.5; ctx.setLineDash([5,4]); ctx.globalAlpha=.8; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha=1;
  }
  score=Math.max(0,score);
  const el=document.getElementById('mv-posture');
  el.textContent=score; el.className='mv'+(score<70?' warn':'');
  document.getElementById('ms-posture').textContent=score>=85?'good':score>=60?'fair':'poor';
  if (score<65&&issues.length) {
    const al=document.getElementById('posture-alert');
    al.textContent='⚠ '+issues[0].toUpperCase(); al.classList.add('show');
    clearTimeout(postureAlertTimer);
    postureAlertTimer=setTimeout(()=>al.classList.remove('show'),3000);
  }
}

// ── REP COUNTER ───────────────────────────────
// Note: body validation already passed before this is called
const REP_CFG = {
  squat:    { down:110, downHys:105, up:155, upHys:160 },
  lunge:    { down:105, downHys:100, up:155, upHys:160 },
  curl:     { down:55,  downHys:50,  up:145, upHys:150 },
  pushup:   { down:80,  downHys:75,  up:150, upHys:155 },
  shoulder: { down:55,  downHys:50,  up:155, upHys:160 },
};

function countReps(kps) {
  const mode = document.getElementById('rep-mode').value;
  const C    = 0.30;
  let rawAngle = null;

  if (mode==='squat') {
    const lA=(kps[11].score>C&&kps[13].score>C&&kps[15].score>C)?angle3(kps[11],kps[13],kps[15]):null;
    const rA=(kps[12].score>C&&kps[14].score>C&&kps[16].score>C)?angle3(kps[12],kps[14],kps[16]):null;
    rawAngle=avgAngles(lA,rA);
    document.getElementById('rep-live-label').textContent=lA&&rA?'both knees':lA?'left knee':rA?'right knee':'no legs';
  }
  else if (mode==='lunge') {
    const lA=(kps[11].score>C&&kps[13].score>C&&kps[15].score>C)?angle3(kps[11],kps[13],kps[15]):null;
    const rA=(kps[12].score>C&&kps[14].score>C&&kps[16].score>C)?angle3(kps[12],kps[14],kps[16]):null;
    rawAngle=bestAngle(lA,lA!==null?1:0,rA,rA!==null?1:0,0.5);
    document.getElementById('rep-live-label').textContent='knee best';
  }
  else if (mode==='curl') {
    const lA=(kps[5].score>C&&kps[7].score>C&&kps[9].score>C)?angle3(kps[5],kps[7],kps[9]):null;
    const rA=(kps[6].score>C&&kps[8].score>C&&kps[10].score>C)?angle3(kps[6],kps[8],kps[10]):null;
    rawAngle=bestAngle(lA,kps[7].score,rA,kps[8].score,C);
    document.getElementById('rep-live-label').textContent='elbow best';
  }
  else if (mode==='pushup') {
    const ls=kps[5],rs=kps[6],lh=kps[11],rh=kps[12],la=kps[15],ra=kps[16];
    const le=kps[7],lw=kps[9],re=kps[8],rw=kps[10];
    const useLeft=ls.score>=rs.score;
    const sh=useLeft?ls:rs,hip=useLeft?lh:rh,ank=useLeft?la:ra;
    const elb=useLeft?le:re,wri=useLeft?lw:rw;
    const ankY=ank.score>C?ank.y:(la.score>C?la.y:ra.y);
    const isHoriz=(Math.max(sh.y,hip.y,ankY)-Math.min(sh.y,hip.y,ankY))/canvas.height<0.22;
    const isSide=!(ls.score>0.4&&rs.score>0.4)||Math.abs(ls.x-rs.x)/canvas.width<0.15;
    if (!isHoriz||!isSide) {
      const reason=!isHoriz?'get into plank':'turn sideways';
      document.getElementById('rep-live-label').textContent=reason;
      document.getElementById('rep-live-angle').textContent='—';
      ctx.save();
      ctx.font='bold 14px Syne,sans-serif';ctx.fillStyle='rgba(255,80,80,.85)';
      ctx.textAlign='center';ctx.fillText('PUSH-UP ▸ '+reason.toUpperCase(),canvas.width/2,canvas.height*.45);
      ctx.textAlign='left';ctx.restore();
      return;
    }
    if (sh.score>C&&elb.score>C&&wri.score>C) {
      rawAngle=angle3(sh,elb,wri);
      document.getElementById('rep-live-label').textContent=(useLeft?'L':'R')+' elbow · side✓';
    }
  }
  else if (mode==='shoulder') {
    const lA=(kps[7].score>C&&kps[5].score>C&&kps[11].score>C)?angle3(kps[7],kps[5],kps[11]):null;
    const rA=(kps[8].score>C&&kps[6].score>C&&kps[12].score>C)?angle3(kps[8],kps[6],kps[12]):null;
    rawAngle=bestAngle(lA,kps[5].score,rA,kps[6].score,C);
    document.getElementById('rep-live-label').textContent='shoulder best';
  }

  if (rawAngle===null) { document.getElementById('rep-live-angle').textContent='—'; return; }

  const smoothed=Math.round(emaAngle(rawAngle));
  document.getElementById('rep-live-angle').textContent=smoothed+'°';

  const cfg=REP_CFG[mode];
  const pct=Math.max(0,Math.min(100,(1-(smoothed-cfg.down)/(cfg.up-cfg.down))*100));
  document.getElementById('phase-fill').style.width      =pct+'%';
  document.getElementById('phase-fill').style.background =repPhase==='down'?'#ff3d6b':'#00ffc6';
  document.getElementById('phase-txt').textContent       ='PHASE: '+(repPhase==='down'?'▼ DOWN':'▲ UP');

  if (repPhase==='up'&&smoothed<=cfg.downHys) {
    repPhase='down';
  } else if (repPhase==='down'&&smoothed>=cfg.upHys) {
    repPhase='up'; repCount++;
    document.getElementById('rep-count').textContent=repCount;
    const box=document.getElementById('rep-box-main');
    box.style.borderColor='var(--accent)';box.style.boxShadow='0 0 20px rgba(0,255,198,.4)';
    setTimeout(()=>{box.style.borderColor='';box.style.boxShadow='';},400);
    if (repCount>=1) document.getElementById('save-workout-btn').classList.add('visible');
  }
}

function resetReps() {
  repCount=0; repPhase='up'; repEma=null;
  document.getElementById('rep-count').textContent      ='0';
  document.getElementById('rep-live-angle').textContent ='—';
  document.getElementById('phase-txt').textContent      ='PHASE: —';
  document.getElementById('phase-fill').style.width     ='0%';
  document.getElementById('save-workout-btn').classList.remove('visible');
}

function updateKneeMetric(kps) {
  const C=0.35;
  const lA=(kps[11].score>C&&kps[13].score>C&&kps[15].score>C)?angle3(kps[11],kps[13],kps[15]):null;
  const rA=(kps[12].score>C&&kps[14].score>C&&kps[16].score>C)?angle3(kps[12],kps[14],kps[16]):null;
  const avg=avgAngles(lA,rA);
  if (avg!==null) document.getElementById('mv-angle').textContent=avg+'°';
}

// ── TOGGLE HELPERS ────────────────────────────
function toggleLayer(name) {
  layers[name]=!layers[name];
  document.getElementById('btn-'+name).classList.toggle('on',layers[name]);
  if (name==='posture'&&!layers.posture) {
    document.getElementById('posture-alert').classList.remove('show');
    document.getElementById('mv-posture').textContent='—';
    document.getElementById('ms-posture').textContent='score';
  }
}
function toggleReps() {
  showReps=!showReps; repEma=null;
  document.getElementById('btn-reps').classList.toggle('on',showReps);
  document.getElementById('rep-overlay').classList.toggle('visible',showReps);
  if (!showReps) resetReps();
}

// ── UI UTILS ──────────────────────────────────
function setStatus(cls,txt) { const el=document.getElementById('status-pill');el.className=cls;el.textContent=txt; }
function showLoader(msg)     { document.getElementById('loading-overlay').classList.remove('hidden');document.getElementById('loader-text').textContent=msg; }
function hideLoading()       { document.getElementById('loading-overlay').classList.add('hidden'); }

// ── EVENT LISTENERS ───────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('start-btn').addEventListener('click',    startTracking);
  document.getElementById('reset-reps').addEventListener('click',   resetReps);
  document.getElementById('rep-mode').addEventListener('change',    ()=>resetReps());
  document.getElementById('btn-skeleton').addEventListener('click', ()=>toggleLayer('skeleton'));
  document.getElementById('btn-angles').addEventListener('click',   ()=>toggleLayer('angles'));
  document.getElementById('btn-reps').addEventListener('click',     toggleReps);
  document.getElementById('btn-posture').addEventListener('click',  ()=>toggleLayer('posture'));
  tf.ready().then(()=>hideLoading()).catch(()=>hideLoading());
});
