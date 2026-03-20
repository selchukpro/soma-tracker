// ── ui.js — side panel, leaderboard, save workout, story mode ──

let currentSpTab       = 'profile';
let workoutStartTime   = null;
let workoutTimerInterval = null;

// ── STORY DATA ────────────────────────────────
// Each episode has: id, title, desc, exercise, targetReps, xp
const STORY = {
  chapters: [
    {
      id: 1,
      title: "Chapter I — The Awakening",
      subtitle: "Every legend begins with a single rep.",
      episodes: [
        { id:1, title:"First Steps",       desc:"Your journey begins. Show what you're made of.",           exercise:"squat",  targetReps:10,  xp:50  },
        { id:2, title:"Foundation",        desc:"Build the base. Squats forge the legs of a warrior.",      exercise:"squat",  targetReps:20,  xp:75  },
        { id:3, title:"Rising Up",         desc:"Push the earth away. Your first real push-up challenge.",  exercise:"pushup", targetReps:5,   xp:80  },
        { id:4, title:"Double Down",       desc:"Twice the effort, twice the reward.",                      exercise:"squat",  targetReps:30,  xp:100 },
        { id:5, title:"Arms of Steel",     desc:"The floor is your opponent. Defeat it.",                   exercise:"pushup", targetReps:10,  xp:120 },
        { id:6, title:"The Gauntlet",      desc:"Combined strength. Prove you belong here.",                exercise:"squat",  targetReps:40,  xp:150 },
        { id:7, title:"Iron Will",         desc:"Push-ups until your arms speak fire.",                     exercise:"pushup", targetReps:15,  xp:175 },
        { id:8, title:"The Summit",        desc:"Chapter finale. Give everything you have.",                exercise:"squat",  targetReps:50,  xp:200 },
      ]
    }
  ]
};

// ── PANEL ─────────────────────────────────────
function openPanel() {
  if (!currentUser) { showAuthModal(); return; }
  document.getElementById('side-panel').classList.add('open');
  document.getElementById('logout-btn').style.display = 'block';
  switchSpTab(currentSpTab);
}
function closePanel() {
  document.getElementById('side-panel').classList.remove('open');
}

function switchSpTab(tab) {
  currentSpTab = tab;
  ['profile','leaderboard','story'].forEach(t => {
    document.getElementById('sptab-'+t+'-btn').classList.toggle('active', t === tab);
  });
  if      (tab === 'profile')     renderProfile();
  else if (tab === 'leaderboard') renderLeaderboard('squat');
  else if (tab === 'story')       renderStory();
}

// ── PROFILE ───────────────────────────────────
async function renderProfile() {
  const body = document.getElementById('sp-body');
  if (!currentUser || !currentProfile) {
    body.innerHTML = '<div class="sp-empty">Sign in to see your profile.</div>';
    return;
  }
  body.innerHTML = '<div style="display:flex;justify-content:center;padding:20px;"><div class="loader-ring" style="width:28px;height:28px;border-width:2px;"></div></div>';

  const { data: workouts } = await supa.from('workouts')
    .select('*').eq('user_id', currentUser.id)
    .order('recorded_at', { ascending: false }).limit(30);

  const total    = workouts?.reduce((s, w) => s + w.reps, 0) || 0;
  const sessions = workouts?.length || 0;

  // Fetch story progress for XP
  const { data: progress } = await supa.from('story_progress')
    .select('chapter,episode,reps_done').eq('user_id', currentUser.id);
  let totalXp = 0;
  progress?.forEach(p => {
    const ch  = STORY.chapters.find(c => c.id===p.chapter);
    const ep  = ch?.episodes.find(e => e.id===p.episode);
    if (ep) totalXp += ep.xp;
  });

  body.innerHTML = `
    <div class="profile-name">👤 ${currentProfile.username}</div>
    <div class="profile-email">${currentUser.email}</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val">${total}</div><div class="stat-lbl">Total Reps</div></div>
      <div class="stat-card"><div class="stat-val">${sessions}</div><div class="stat-lbl">Sessions</div></div>
      <div class="stat-card"><div class="stat-val">${totalXp}</div><div class="stat-lbl">Story XP</div></div>
      <div class="stat-card"><div class="stat-val">${progress?.length||0}</div><div class="stat-lbl">Episodes Done</div></div>
    </div>
    <div class="ml" style="margin-bottom:8px;">Recent Workouts</div>
    ${workouts && workouts.length
      ? workouts.slice(0,10).map(w => `
          <div class="workout-item">
            <div>
              <div class="wi-ex">${w.exercise}</div>
              <div class="wi-date">${new Date(w.recorded_at).toLocaleDateString('en',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <div class="wi-reps">${w.reps}</div>
          </div>`).join('')
      : '<div class="sp-empty">No workouts yet.<br>Complete a set and tap Save Workout.</div>'
    }
  `;
}

// ── LEADERBOARD ───────────────────────────────
async function renderLeaderboard(exercise) {
  const body = document.getElementById('sp-body');
  const exercises = ['squat','curl','pushup','lunge','shoulder'];

  body.innerHTML = `
    <div class="lb-filter">
      ${exercises.map(e => `<button class="lb-btn${e===exercise?' active':''}" data-ex="${e}">${e}</button>`).join('')}
    </div>
    <div id="lb-list"><div style="display:flex;justify-content:center;padding:20px;"><div class="loader-ring" style="width:28px;height:28px;border-width:2px;"></div></div></div>
  `;
  body.querySelectorAll('.lb-btn').forEach(btn => {
    btn.addEventListener('click', () => renderLeaderboard(btn.dataset.ex));
  });

  const { data, error } = await supa.from('workouts')
    .select('reps, profiles(username)')
    .eq('exercise', exercise)
    .order('reps', { ascending: false })
    .limit(50);

  if (error) { document.getElementById('lb-list').innerHTML = '<div class="sp-empty">Could not load leaderboard.</div>'; return; }

  const best = {};
  data?.forEach(w => {
    const name = w.profiles?.username || 'anonymous';
    if (!best[name] || w.reps > best[name]) best[name] = w.reps;
  });
  const sorted = Object.entries(best).sort((a,b) => b[1]-a[1]).slice(0,10);
  const medals  = ['🥇','🥈','🥉'];
  const rowClass = ['gold','silver','bronze'];

  document.getElementById('lb-list').innerHTML = sorted.length
    ? sorted.map(([name, reps], i) => `
        <div class="lb-row ${rowClass[i]||''}">
          <div class="lb-rank">${medals[i] || i+1}</div>
          <div class="lb-name">${name}${currentProfile && name===currentProfile.username ? ' <span class="lb-you">you</span>' : ''}</div>
          <div class="lb-reps">${reps}</div>
        </div>`).join('')
    : '<div class="sp-empty">No scores yet.<br>Be the first!</div>';
}

// ── STORY MODE ────────────────────────────────
let storyActiveEpisode = null; // { chapter, episode } currently being attempted

async function renderStory() {
  const body = document.getElementById('sp-body');
  body.innerHTML = '<div style="display:flex;justify-content:center;padding:20px;"><div class="loader-ring" style="width:28px;height:28px;border-width:2px;"></div></div>';

  // Load completed episodes from Supabase
  const { data: progress } = await supa.from('story_progress')
    .select('chapter,episode,reps_done').eq('user_id', currentUser.id);
  const done = new Set((progress||[]).map(p => `${p.chapter}-${p.episode}`));

  let html = '';
  for (const chapter of STORY.chapters) {
    const totalEps    = chapter.episodes.length;
    const donEps      = chapter.episodes.filter(e => done.has(`${chapter.id}-${e.id}`)).length;
    const chapterDone = donEps === totalEps;
    const chapterXp   = chapter.episodes.filter(e=>done.has(`${chapter.id}-${e.id}`)).reduce((s,e)=>s+e.xp,0);

    html += `
      <div class="story-chapter">
        <div class="story-ch-header">
          <div>
            <div class="story-ch-title">${chapterDone?'✅ ':'📖 '}${chapter.title}</div>
            <div class="story-ch-sub">${chapter.subtitle}</div>
          </div>
          <div class="story-ch-meta">
            <div class="story-ch-prog">${donEps}/${totalEps}</div>
            <div class="story-ch-xp">${chapterXp} XP</div>
          </div>
        </div>
        <div class="story-ch-bar">
          <div class="story-ch-fill" style="width:${(donEps/totalEps*100).toFixed(0)}%"></div>
        </div>
        <div class="story-episodes">
    `;

    for (let i=0; i<chapter.episodes.length; i++) {
      const ep        = chapter.episodes[i];
      const isDone    = done.has(`${chapter.id}-${ep.id}`);
      const isLocked  = i > 0 && !done.has(`${chapter.id}-${chapter.episodes[i-1].id}`);
      const isActive  = storyActiveEpisode?.chapter===chapter.id && storyActiveEpisode?.episode===ep.id;
      const prog      = progress?.find(p=>p.chapter===chapter.id&&p.episode===ep.id);
      const exIcon    = ep.exercise==='squat'?'🦵':'💪';
      const statusIcon = isDone ? '✅' : isLocked ? '🔒' : isActive ? '⏳' : '▶';

      html += `
        <div class="story-ep ${isDone?'done':isLocked?'locked':isActive?'active':''}">
          <div class="story-ep-left">
            <div class="story-ep-num">${statusIcon}</div>
            <div>
              <div class="story-ep-title">${ep.title}</div>
              <div class="story-ep-desc">${ep.desc}</div>
              <div class="story-ep-meta">${exIcon} ${ep.exercise} · ${ep.targetReps} reps · ${ep.xp} XP${isDone&&prog?' · Best: '+prog.reps_done:''}</div>
            </div>
          </div>
          ${!isDone && !isLocked ? `<button class="story-ep-btn" data-chapter="${chapter.id}" data-episode="${ep.id}">${isActive?'Active':'Start'}</button>` : ''}
        </div>
      `;
    }
    html += `</div></div>`;
  }

  body.innerHTML = html;

  // Attach Start buttons
  body.querySelectorAll('.story-ep-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch = parseInt(btn.dataset.chapter);
      const ep = parseInt(btn.dataset.episode);
      startStoryEpisode(ch, ep);
    });
  });
}

function startStoryEpisode(chapterId, episodeId) {
  const chapter = STORY.chapters.find(c => c.id===chapterId);
  const episode = chapter?.episodes.find(e => e.id===episodeId);
  if (!episode) return;

  storyActiveEpisode = { chapter: chapterId, episode: episodeId };

  // Close panel, set the rep mode, reset reps, show rep overlay
  closePanel();

  // Set exercise mode
  const modeSelect = document.getElementById('rep-mode');
  modeSelect.value = episode.exercise;
  modeSelect.dispatchEvent(new Event('change')); // triggers resetReps

  // Show rep panel if not visible
  if (!document.getElementById('rep-overlay').classList.contains('visible')) {
    document.getElementById('btn-reps').click();
  }

  // Show story HUD
  showStoryHud(episode);
}

function showStoryHud(episode) {
  // Remove existing HUD if any
  const existing = document.getElementById('story-hud');
  if (existing) existing.remove();

  const hud = document.createElement('div');
  hud.id = 'story-hud';
  hud.innerHTML = `
    <div class="shud-title">${episode.title}</div>
    <div class="shud-goal">${episode.exercise === 'squat' ? '🦵' : '💪'} Goal: <strong id="shud-count">0</strong> / ${episode.targetReps} reps</div>
    <div class="shud-bar"><div class="shud-fill" id="shud-fill" style="width:0%"></div></div>
    <button class="shud-abandon" id="shud-abandon">✕ Abandon</button>
  `;
  document.body.appendChild(hud);

  document.getElementById('shud-abandon').addEventListener('click', abandonStoryEpisode);

  // Poll rep count to update HUD
  window._storyHudInterval = setInterval(() => {
    const current = parseInt(document.getElementById('rep-count').textContent) || 0;
    const pct     = Math.min(100, (current / episode.targetReps) * 100);
    const countEl = document.getElementById('shud-count');
    const fillEl  = document.getElementById('shud-fill');
    if (countEl) countEl.textContent = current;
    if (fillEl)  fillEl.style.width  = pct + '%';

    // Episode complete!
    if (current >= episode.targetReps && storyActiveEpisode) {
      clearInterval(window._storyHudInterval);
      completeStoryEpisode(episode, current);
    }
  }, 300);
}

async function completeStoryEpisode(episode, repsAchieved) {
  const { chapter, episode: epId } = storyActiveEpisode;
  storyActiveEpisode = null;

  // Save to Supabase
  await supa.from('story_progress').upsert({
    user_id:      currentUser.id,
    chapter:      chapter,
    episode:      epId,
    reps_done:    repsAchieved,
    completed_at: new Date().toISOString()
  }, { onConflict: 'user_id,chapter,episode' });

  // Also save as regular workout
  await supa.from('workouts').insert({
    user_id:  currentUser.id,
    exercise: episode.exercise,
    reps:     repsAchieved
  });

  // Remove HUD, show completion screen
  const hud = document.getElementById('story-hud');
  if (hud) hud.remove();

  showEpisodeComplete(episode, repsAchieved);
}

function showEpisodeComplete(episode, reps) {
  const overlay = document.createElement('div');
  overlay.id = 'ep-complete';
  overlay.innerHTML = `
    <div class="ep-complete-box">
      <div class="ep-complete-emoji">🏆</div>
      <div class="ep-complete-title">Episode Complete!</div>
      <div class="ep-complete-ep">${episode.title}</div>
      <div class="ep-complete-stats">
        <div class="ep-stat"><div class="ep-stat-val">${reps}</div><div class="ep-stat-lbl">Reps Done</div></div>
        <div class="ep-stat"><div class="ep-stat-val">+${episode.xp}</div><div class="ep-stat-lbl">XP Earned</div></div>
      </div>
      <button class="ep-complete-btn" id="ep-complete-close">Continue →</button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('ep-complete-close').addEventListener('click', () => {
    overlay.remove();
    openPanel();
    switchSpTab('story');
  });
}

function abandonStoryEpisode() {
  storyActiveEpisode = null;
  clearInterval(window._storyHudInterval);
  const hud = document.getElementById('story-hud');
  if (hud) hud.remove();
}

// ── SAVE WORKOUT ──────────────────────────────
async function saveWorkout() {
  if (!currentUser) { showAuthModal(); return; }
  const reps = parseInt(document.getElementById('rep-count').textContent) || 0;
  if (reps === 0) { showToast('Do some reps first!'); return; }
  const mode     = document.getElementById('rep-mode').value;
  const duration = workoutStartTime ? Math.round((Date.now()-workoutStartTime)/1000) : null;

  const { error } = await supa.from('workouts').insert({
    user_id: currentUser.id, exercise: mode, reps, duration_seconds: duration
  });
  if (error) { showToast('Save failed: ' + error.message); return; }
  showToast(`Saved ${reps} ${mode} reps! 🎉`);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── WORKOUT TIMER ─────────────────────────────
function startWorkoutTimer() {
  workoutStartTime = Date.now();
  const el = document.getElementById('workout-timer');
  el.classList.add('visible');
  workoutTimerInterval = setInterval(() => {
    const s = Math.round((Date.now()-workoutStartTime)/1000);
    el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }, 1000);
}

// ── EVENT LISTENERS ───────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('open-panel-btn').addEventListener('click',    openPanel);
  document.getElementById('close-panel-btn').addEventListener('click',   closePanel);
  document.getElementById('sptab-profile-btn').addEventListener('click',     () => switchSpTab('profile'));
  document.getElementById('sptab-leaderboard-btn').addEventListener('click', () => switchSpTab('leaderboard'));
  document.getElementById('sptab-story-btn').addEventListener('click',       () => switchSpTab('story'));
  document.getElementById('save-workout-btn').addEventListener('click',  saveWorkout);
});
