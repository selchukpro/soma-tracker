// ── ui.js — side panel, leaderboard, save workout ──

let currentSpTab       = 'profile';
let workoutStartTime   = null;
let workoutTimerInterval = null;

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
  document.getElementById('sptab-profile-btn').classList.toggle('active', tab === 'profile');
  document.getElementById('sptab-lb-btn').classList.toggle('active',      tab === 'leaderboard');
  if (tab === 'profile') renderProfile();
  else renderLeaderboard('squat');
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

  body.innerHTML = `
    <div class="profile-name">${currentProfile.username}</div>
    <div class="profile-email">${currentUser.email}</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val">${total}</div><div class="stat-lbl">Total Reps</div></div>
      <div class="stat-card"><div class="stat-val">${sessions}</div><div class="stat-lbl">Sessions</div></div>
    </div>
    <div class="ml" style="margin-bottom:8px;">Recent Workouts</div>
    ${workouts && workouts.length
      ? workouts.slice(0,15).map(w => `
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

  // Attach filter button listeners
  body.querySelectorAll('.lb-btn').forEach(btn => {
    btn.addEventListener('click', () => renderLeaderboard(btn.dataset.ex));
  });

  const { data, error } = await supa.from('workouts')
    .select('reps, profiles(username)')
    .eq('exercise', exercise)
    .order('reps', { ascending: false })
    .limit(50);

  if (error) { document.getElementById('lb-list').innerHTML = '<div class="sp-empty">Could not load leaderboard.</div>'; return; }

  // Best per user
  const best = {};
  data?.forEach(w => {
    const name = w.profiles?.username || 'anonymous';
    if (!best[name] || w.reps > best[name]) best[name] = w.reps;
  });
  const sorted = Object.entries(best).sort((a,b) => b[1]-a[1]).slice(0,10);

  const medals = ['🥇','🥈','🥉'];
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

// ── SAVE WORKOUT ──────────────────────────────
async function saveWorkout() {
  if (!currentUser) { showAuthModal(); return; }
  const reps = parseInt(document.getElementById('rep-count').textContent) || 0;
  if (reps === 0) { showToast('Do some reps first!'); return; }
  const mode     = document.getElementById('rep-mode').value;
  const duration = workoutStartTime ? Math.round((Date.now()-workoutStartTime)/1000) : null;

  const { error } = await supa.from('workouts').insert({
    user_id: currentUser.id,
    exercise: mode,
    reps,
    duration_seconds: duration
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
  document.getElementById('sptab-profile-btn').addEventListener('click', () => switchSpTab('profile'));
  document.getElementById('sptab-lb-btn').addEventListener('click',      () => switchSpTab('leaderboard'));
  document.getElementById('save-workout-btn').addEventListener('click',  saveWorkout);
});
