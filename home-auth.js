// ── home-auth.js — home screen logic ──

const SUPA_URL = 'https://jmkyakgzqdkavebtrnpj.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impta3lha2d6cWRrYXZlYnRybnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDI4MzIsImV4cCI6MjA4OTU3ODgzMn0.pNtqN1ejAW6dY2Ov35_ksX5ZQ5syvSdagYr5cjy8iIo';
const supa = supabase.createClient(SUPA_URL, SUPA_KEY);

let currentUser    = null;
let currentProfile = null;
let authMode       = 'login';

const STORY_XP = {
  '1-1':50,'1-2':75,'1-3':80,'1-4':100,'1-5':120,'1-6':150,'1-7':175,'1-8':200
};

// ── INIT ──────────────────────────────────────
async function init() {
  const { data: { session } } = await supa.auth.getSession().catch(() => ({ data:{} }));
  if (session?.user) {
    currentUser = session.user;
    await loadProfile();
  } else {
    setTimeout(showAuthModal, 700);
  }
  updateHero();

  supa.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      currentUser = session.user;
      await loadProfile();
      closeAuthModal();
      updateHero();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null; currentProfile = null;
      updateHero();
    }
  });
}

async function loadProfile() {
  if (!currentUser) return;
  const { data } = await supa.from('profiles').select('*').eq('id', currentUser.id).single();
  currentProfile = data || { username: currentUser.email.split('@')[0], id: currentUser.id };
}

async function updateHero() {
  const nameEl = document.getElementById('hero-name');
  const greetEl = document.getElementById('hero-greeting');
  const profBtn = document.getElementById('profile-btn');
  const xpPill  = document.getElementById('xp-pill');

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  greetEl.textContent = greeting;

  if (currentProfile) {
    nameEl.innerHTML = `<span>${currentProfile.username}</span>`;
    profBtn.textContent = '👤 ' + currentProfile.username.substring(0, 10);

    // Load stats in parallel
    const [workoutsRes, profileRes, progressRes] = await Promise.all([
      supa.from('workouts').select('reps').eq('user_id', currentUser.id),
      supa.from('profiles').select('total_xp,story_chapter,story_episode').eq('id', currentUser.id).single(),
      supa.from('story_progress').select('chapter,episode').eq('user_id', currentUser.id)
    ]);

    const totalReps = workoutsRes.data?.reduce((s,w) => s+w.reps, 0) || 0;
    const sessions  = workoutsRes.data?.length || 0;
    // Use profile XP if saved, fallback to calculating from progress
    const profileXp = profileRes.data?.total_xp || 0;
    const calcXp    = (progressRes.data||[]).reduce((s,p) => s + (STORY_XP[`${p.chapter}-${p.episode}`]||0), 0);
    const totalXp   = Math.max(profileXp, calcXp); // take the higher value

    document.getElementById('hs-reps').textContent     = totalReps;
    document.getElementById('hs-sessions').textContent = sessions;
    document.getElementById('hs-xp').textContent       = totalXp;
    xpPill.textContent = totalXp + ' XP';

    // Story badge — use profile position or calculate from progress
    const doneCount   = progressRes.data?.length || 0;
    const nextEpNum   = profileRes.data?.story_episode || (doneCount + 1);
    const nextChNum   = profileRes.data?.story_chapter || 1;
    if (doneCount >= 8) document.getElementById('story-badge').textContent = '✅ Chapter 1 Complete';
    else document.getElementById('story-badge').textContent = `Ch.${nextChNum} · Ep.${nextEpNum} Next`;

  } else {
    nameEl.textContent  = 'Athlete';
    profBtn.textContent = 'Sign In';
    ['hs-reps','hs-sessions','hs-xp'].forEach(id => document.getElementById(id).textContent = '—');
  }
}

// ── AUTH MODAL ────────────────────────────────
function showAuthModal()  { document.getElementById('auth-modal').classList.add('show'); }
function closeAuthModal() { document.getElementById('auth-modal').classList.remove('show'); }

function switchTab(mode) {
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active',  mode==='login');
  document.getElementById('tab-signup').classList.toggle('active', mode==='signup');
  document.getElementById('auth-submit').textContent = mode==='login' ? 'Sign In' : 'Create Account';
  document.getElementById('signup-username-field').style.display = mode==='signup' ? 'flex' : 'none';
  document.getElementById('auth-err').textContent = '';
}

async function doAuth() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const username = document.getElementById('auth-username').value.trim();
  const errEl    = document.getElementById('auth-err');
  const btn      = document.getElementById('auth-submit');

  if (!email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }
  errEl.textContent = ''; errEl.style.color = 'var(--accent2)';
  btn.textContent = '…'; btn.disabled = true;

  try {
    if (authMode === 'signup') {
      if (!username) { errEl.textContent = 'Username is required.'; return; }
      const { data, error } = await supa.auth.signUp({ email, password });
      if (error) throw error;
      if (data.user) {
        await supa.from('profiles').insert({ id: data.user.id, username }).catch(()=>{});
      }
      errEl.style.color = 'var(--accent)';
      errEl.textContent = '✓ Check your email to confirm!';
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch(e) {
    errEl.style.color = 'var(--accent2)';
    errEl.textContent = e.message || 'Something went wrong.';
  } finally {
    btn.textContent = authMode==='login' ? 'Sign In' : 'Create Account';
    btn.disabled = false;
  }
}

// ── LEADERBOARD MODAL ─────────────────────────
let currentLbEx = 'squat';

function openLeaderboard() {
  document.getElementById('lb-modal').classList.add('show');
  renderLb('squat');
}
function closeLeaderboard() {
  document.getElementById('lb-modal').classList.remove('show');
}

async function renderLb(exercise) {
  currentLbEx = exercise;
  const exercises = ['squat','curl','pushup','lunge','shoulder'];

  // Update filter buttons
  document.getElementById('lb-filter').innerHTML = exercises.map(e =>
    `<button class="lb-btn${e===exercise?' active':''}" data-ex="${e}">${e}</button>`
  ).join('');
  document.querySelectorAll('.lb-btn').forEach(btn =>
    btn.addEventListener('click', () => renderLb(btn.dataset.ex))
  );

  document.getElementById('lb-list').innerHTML = '<div class="loader-ring"></div>';

  const { data, error } = await supa.from('workouts')
    .select('reps, profiles(username)')
    .eq('exercise', exercise)
    .order('reps', { ascending:false })
    .limit(50);

  if (error) { document.getElementById('lb-list').innerHTML = '<div class="sp-empty">Could not load.</div>'; return; }

  const best = {};
  data?.forEach(w => {
    const name = w.profiles?.username || 'anonymous';
    if (!best[name] || w.reps > best[name]) best[name] = w.reps;
  });
  const sorted = Object.entries(best).sort((a,b) => b[1]-a[1]).slice(0,10);
  const medals   = ['🥇','🥈','🥉'];
  const rowClass = ['gold','silver','bronze'];

  document.getElementById('lb-list').innerHTML = sorted.length
    ? sorted.map(([name,reps],i) => `
        <div class="lb-row ${rowClass[i]||''}">
          <div class="lb-rank">${medals[i]||i+1}</div>
          <div class="lb-name">${name}${currentProfile&&name===currentProfile.username?' <span class="lb-you">you</span>':''}</div>
          <div class="lb-reps">${reps}</div>
        </div>`).join('')
    : '<div class="sp-empty">No scores yet for this exercise.</div>';
}

// ── NAVIGATION ────────────────────────────────
function goToTracker() { window.location.href = 'index.html'; }
function goToWatch()   { window.location.href = 'room.html'; }
function goToStory()   {
  if (!currentUser) { showAuthModal(); return; }
  window.location.href = 'story.html';
}

// ── BOOT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Card navigation
  document.getElementById('card-training').addEventListener('click',    goToTracker);
  const watchCard = document.getElementById('card-watch');
  if (watchCard) watchCard.addEventListener('click', goToWatch);
  const fightCard = document.getElementById('card-fights');
  if (fightCard) fightCard.addEventListener('click', ()=>window.location.href='fight.html');
  document.getElementById('card-story').addEventListener('click',       goToStory);
  document.getElementById('card-leaderboard').addEventListener('click', openLeaderboard);

  // Auth
  document.getElementById('profile-btn').addEventListener('click',  () => currentUser ? null : showAuthModal());
  document.getElementById('tab-login').addEventListener('click',    () => switchTab('login'));
  document.getElementById('tab-signup').addEventListener('click',   () => switchTab('signup'));
  document.getElementById('auth-submit').addEventListener('click',  doAuth);
  document.getElementById('auth-skip-btn').addEventListener('click', closeAuthModal);
  document.getElementById('auth-email').addEventListener('keydown',    e => { if(e.key==='Enter') doAuth(); });
  document.getElementById('auth-password').addEventListener('keydown', e => { if(e.key==='Enter') doAuth(); });

  // Leaderboard
  document.getElementById('lb-close').addEventListener('click', closeLeaderboard);
  document.getElementById('lb-modal').addEventListener('click', e => { if(e.target===document.getElementById('lb-modal')) closeLeaderboard(); });

  // Auth modal close on backdrop
  document.getElementById('auth-modal').addEventListener('click', e => { if(e.target===document.getElementById('auth-modal')) closeAuthModal(); });

  init();
});
