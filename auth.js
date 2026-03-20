// ── auth.js — Supabase login, signup, session ──

const SUPA_URL = 'https://jmkyakgzqdkavebtrnpj.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impta3lha2d6cWRrYXZlYnRybnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDI4MzIsImV4cCI6MjA4OTU3ODgzMn0.pNtqN1ejAW6dY2Ov35_ksX5ZQ5syvSdagYr5cjy8iIo';
const supa = supabase.createClient(SUPA_URL, SUPA_KEY);

let currentUser    = null;
let currentProfile = null;
let authMode       = 'login';

// ── INIT ──────────────────────────────────────
async function authInit() {
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (session) {
      currentUser = session.user;
      await loadProfile();
      updateUserBtn();
    } else {
      setTimeout(showAuthModal, 600);
    }
  } catch(e) {
    console.error('Auth init error:', e);
    setTimeout(showAuthModal, 600);
  }

  supa.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      currentUser = session.user;
      await loadProfile();
      updateUserBtn();
      closeAuthModal();
    } else if (event === 'SIGNED_OUT') {
      currentUser    = null;
      currentProfile = null;
      updateUserBtn();
    }
  });
}

// ── MODAL ─────────────────────────────────────
function showAuthModal()  { document.getElementById('auth-modal').classList.add('show'); }
function closeAuthModal() { document.getElementById('auth-modal').classList.remove('show'); }

function switchTab(mode) {
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active',  mode === 'login');
  document.getElementById('tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('auth-submit').textContent = mode === 'login' ? 'Sign In' : 'Create Account';
  document.getElementById('signup-username-field').style.display = mode === 'signup' ? 'flex' : 'none';
  document.getElementById('auth-err').textContent = '';
}

async function doAuth() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const username = document.getElementById('auth-username').value.trim();
  const errEl    = document.getElementById('auth-err');
  const btn      = document.getElementById('auth-submit');

  if (!email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }

  errEl.textContent = '';
  btn.textContent   = '…';
  btn.disabled      = true;

  try {
    if (authMode === 'signup') {
      if (!username) { errEl.textContent = 'Username is required.'; return; }
      const { data, error } = await supa.auth.signUp({ email, password });
      if (error) throw error;
      // Create profile row
      const { error: profErr } = await supa.from('profiles').insert({ id: data.user.id, username });
      if (profErr) throw profErr;
      errEl.style.color    = 'var(--accent)';
      errEl.textContent    = 'Account created! Check your email to confirm.';
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch(e) {
    errEl.style.color = 'var(--accent2)';
    errEl.textContent = e.message || 'Something went wrong.';
  } finally {
    btn.textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
    btn.disabled    = false;
  }
}

async function doLogout() {
  await supa.auth.signOut();
  document.getElementById('logout-btn').style.display = 'none';
  closePanel();
}

async function loadProfile() {
  if (!currentUser) return;
  const { data } = await supa.from('profiles').select('*').eq('id', currentUser.id).single();
  currentProfile = data;
}

function updateUserBtn() {
  const btn = document.getElementById('open-panel-btn');
  if (currentProfile) {
    btn.textContent     = currentProfile.username.substring(0, 10);
    btn.style.color     = 'var(--accent)';
    btn.style.borderColor = 'rgba(0,255,198,.3)';
  } else {
    btn.textContent     = 'Sign In';
    btn.style.color     = 'var(--accent3)';
    btn.style.borderColor = 'rgba(167,139,250,.3)';
  }
}

// ── EVENT LISTENERS ───────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tab-login').addEventListener('click',  () => switchTab('login'));
  document.getElementById('tab-signup').addEventListener('click', () => switchTab('signup'));
  document.getElementById('auth-submit').addEventListener('click', doAuth);
  document.getElementById('auth-skip-btn').addEventListener('click', closeAuthModal);
  document.getElementById('auth-email').addEventListener('keydown',    e => { if(e.key==='Enter') doAuth(); });
  document.getElementById('auth-password').addEventListener('keydown', e => { if(e.key==='Enter') doAuth(); });
  document.getElementById('logout-btn').addEventListener('click', doLogout);

  // Kick off auth check
  authInit();
});
