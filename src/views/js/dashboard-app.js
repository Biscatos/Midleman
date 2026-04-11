// ─── State ───────────────────────────────────────────────────────────────────
const THEME_KEY = 'midleman_theme';
let editingProfile = null;
let currentPage = 'overview';
let lastReqLogId = 0;
let setupTotpSecret = '';
let loggedInUser = null;
let _allProfiles = [];

// ─── Theme ───────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
  if (typeof updateAceThemes === 'function') updateAceThemes();
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
  updateThemeIcon(next);
  if (typeof updateAceThemes === 'function') updateAceThemes();
}
function updateThemeIcon(theme) {
  document.getElementById('themeBtn').innerHTML = theme === 'dark' ? '&#9728;' : '&#9790;';
}
initTheme();

// ─── Init ────────────────────────────────────────────────────────────────────
let appIntervals = [];

async function startApp(username) {
  loggedInUser = username;
  document.getElementById('navUser').textContent = loggedInUser;
  document.querySelector('.app').style.display = 'flex';
  
  // Hide auth panels if visible
  document.getElementById('authLogin').classList.remove('active');
  document.getElementById('authSetup').classList.remove('active');

  // Immediately set it to Connecting and resolve health check fast to show Online
  document.getElementById('navDot').className = 'status-dot online';
  document.getElementById('navStatus').textContent = 'Connecting...';
  
  await fetchHealth(); // Do this immediately to set 'Online' UI instantly
  
  // Trigger rest of initializations concurrently without blocking UI main thread
  refreshAll().catch(e => console.error('Dashboard refresh error:', e));

  if (appIntervals.length === 0) {
    appIntervals.push(setInterval(fetchHealth, 5000));
    appIntervals.push(setInterval(fetchRecentRequests, 3000));
    appIntervals.push(setInterval(fetchChartData, 15000));
    appIntervals.push(setInterval(() => {
      if (currentPage === 'requests' && document.getElementById('rlAutoRefresh').checked) fetchRequestLogs();
    }, 5000));
  }
}

window.addEventListener('load', async function init() {
  try {
    const res = await fetch('/auth/status');
    const status = await res.json();

    if (status.needsSetup) {
      document.getElementById('authSetup').classList.add('active');
      document.querySelector('.app').style.display = 'none';
      return;
    }

    if (!status.loggedIn) {
      document.getElementById('authLogin').classList.add('active');
      document.querySelector('.app').style.display = 'none';
      return;
    }

    // Authenticated
    startApp(status.username);
  } catch (e) {
    console.error('Init error:', e);
  }
});

// ─── Auth Functions ──────────────────────────────────────────────────────────
function showAuthError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg; el.style.display = 'block';
}
function hideAuthError(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

async function setupStep2() {
  hideAuthError('setupError');
  const user = document.getElementById('setupUser').value.trim();
  const pass = document.getElementById('setupPass').value;
  const pass2 = document.getElementById('setupPass2').value;
  if (!user || user.length < 2) return showAuthError('setupError', 'Username must be at least 2 characters.');
  if (!pass || pass.length < 6) return showAuthError('setupError', 'Password must be at least 6 characters.');
  if (pass !== pass2) return showAuthError('setupError', 'Passwords do not match.');
  try {
    const res = await fetch('/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user }) });
    const data = await res.json();
    if (!res.ok) return showAuthError('setupError', data.error || 'Failed');
    setupTotpSecret = data.secret;
    const qrContainer = document.getElementById('setupQrContainer');
    qrContainer.innerHTML = '';
    if (data.qrDataUrl) {
      const img = document.createElement('img');
      img.src = data.qrDataUrl;
      img.width = 200;
      img.height = 200;
      img.alt = 'QR Code 2FA';
      qrContainer.appendChild(img);
    } else {
      qrContainer.textContent = 'Failed to generate QR code';
    }
    document.getElementById('setupSecretDisplay').textContent = data.secret;
    document.getElementById('setupStep1').classList.remove('active');
    document.getElementById('setupStep2').classList.add('active');
  } catch (e) { showAuthError('setupError', 'Error: ' + e.message); }
}

function backToStep1() {
  document.getElementById('setupStep2').classList.remove('active');
  document.getElementById('setupStep1').classList.add('active');
}

async function completeSetup() {
  hideAuthError('setupError');
  const user = document.getElementById('setupUser').value.trim();
  const pass = document.getElementById('setupPass').value;
  const code = document.getElementById('setupTotpCode').value.trim();
  if (!code || code.length !== 6) return showAuthError('setupError', 'Enter the 6-digit code from your authenticator app.');
  try {
    const res = await fetch('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass, totpSecret: setupTotpSecret, totpCode: code }) });
    const data = await res.json();
    if (!res.ok) return showAuthError('setupError', data.error || 'Failed');
    startApp(data.username);
  } catch (e) { showAuthError('setupError', 'Error: ' + e.message); }
}

let loginChallengeToken = null;

async function doLoginStep1() {
  hideAuthError('loginError');
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  if (!user || !pass) return showAuthError('loginError', 'Username and password are required.');
  document.getElementById('loginBtn1').disabled = true;
  document.getElementById('loginBtn1').textContent = 'Verifying...';
  try {
    const res = await fetch('/auth/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
    const data = await res.json();
    if (!res.ok) { showAuthError('loginError', data.error || 'Login failed'); document.getElementById('loginBtn1').disabled = false; document.getElementById('loginBtn1').textContent = 'Continue'; return; }
    loginChallengeToken = data.challengeToken;
    document.getElementById('loginStep1').classList.remove('active');
    document.getElementById('loginStep2').classList.add('active');
    document.getElementById('loginTotp').value = '';
    document.getElementById('loginTotp').focus();
  } catch (e) { showAuthError('loginError', 'Error: ' + e.message); }
  document.getElementById('loginBtn1').disabled = false;
  document.getElementById('loginBtn1').textContent = 'Continue';
}

async function doLoginStep2() {
  hideAuthError('loginTotpError');
  const code = document.getElementById('loginTotp').value.trim();
  if (!code || code.length !== 6) return showAuthError('loginTotpError', 'Enter the 6-digit code.');
  if (!loginChallengeToken) return showAuthError('loginTotpError', 'Session expired. Go back and try again.');
  document.getElementById('loginBtn2').disabled = true;
  document.getElementById('loginBtn2').textContent = 'Signing in...';
  try {
    const res = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken: loginChallengeToken, totpCode: code }) });
    const data = await res.json();
    if (!res.ok) { showAuthError('loginTotpError', data.error || 'Invalid code'); document.getElementById('loginBtn2').disabled = false; document.getElementById('loginBtn2').textContent = 'Sign In'; return; }
    startApp(data.username);
  } catch (e) { showAuthError('loginTotpError', 'Error: ' + e.message); document.getElementById('loginBtn2').disabled = false; document.getElementById('loginBtn2').textContent = 'Sign In'; }
}

function loginBackToStep1() {
  loginChallengeToken = null;
  hideAuthError('loginTotpError');
  document.getElementById('loginStep2').classList.remove('active');
  document.getElementById('loginStep1').classList.add('active');
  document.getElementById('loginUser').focus();
}

async function doLogout() {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.reload();
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1));
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll('.nav-link[data-page]').forEach(n => {
    if (n.dataset.page === page) n.classList.add('active');
  });
  if (page === 'requests') { rlPage = 1; fetchRequestLogs(); }
  if (page === 'proxyusers') { fetchProxyUsers(); fetchInvites(); }

}

// ─── API ─────────────────────────────────────────────────────────────────────
function hdrs() { return { 'Content-Type': 'application/json' }; }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...hdrs(), ...(opts.headers || {}) } });
  if (res.status === 401) { window.location.reload(); throw new Error('Session expired'); }
  return res;
}
function toast(msg, type = 'success') {
  const t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast ' + type;
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => t.classList.remove('show'), 3000);
}
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtNum(n) { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(n); }
function fmtMs(ms) { if (!ms) return '0ms'; if (ms < 1) return ms.toFixed(2) + 'ms'; if (ms < 1000) return Math.round(ms) + 'ms'; return (ms / 1000).toFixed(2) + 's'; }
function fmtUptime(s) { if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm ' + s % 60 + 's'; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h + 'h ' + m + 'm'; }
function fmtBytes(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
