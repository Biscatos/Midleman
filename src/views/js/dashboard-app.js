// ─── State ───────────────────────────────────────────────────────────────────
const THEME_KEY = 'midleman_theme';
const SIDEBAR_KEY = 'midleman_sidebar_collapsed';
let editingProfile = null;
let currentPage = 'overview';
let lastReqLogId = 0;
let setupTotpSecret = '';
let loggedInUser = null;
let _allProfiles = [];

// ─── Theme ───────────────────────────────────────────────────────────────────
// Three modes: 'dark' | 'light' | 'system'.
// `data-theme` on <html> is always concrete (dark/light); the preference is what's stored.
const THEME_MODES = ['dark', 'light', 'system'];
const _prefersDark = (typeof window !== 'undefined' && window.matchMedia)
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function getThemePref() {
  const v = localStorage.getItem(THEME_KEY);
  // Default to 'system' so the OS preference wins on first visit, matching the
  // bootstrap snippet injected in every page <head>.
  return THEME_MODES.includes(v) ? v : 'system';
}
function resolveTheme(pref) {
  if (pref === 'system') return _prefersDark && _prefersDark.matches ? 'dark' : 'light';
  return pref === 'light' ? 'light' : 'dark';
}
function applyTheme() {
  const pref = getThemePref();
  const effective = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', effective);
  updateThemeIcon(pref);
  if (typeof updateAceThemes === 'function') updateAceThemes();
}
function initTheme() {
  applyTheme();
  // Follow the OS only while in 'system' mode.
  if (_prefersDark) {
    const onChange = () => { if (getThemePref() === 'system') applyTheme(); };
    if (_prefersDark.addEventListener) _prefersDark.addEventListener('change', onChange);
    else if (_prefersDark.addListener) _prefersDark.addListener(onChange); // Safari <14
  }
}
function toggleTheme() {
  // Cycle dark → light → system → dark
  const pref = getThemePref();
  const idx = THEME_MODES.indexOf(pref);
  const next = THEME_MODES[(idx + 1) % THEME_MODES.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
}
const THEME_ICONS = {
  dark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  system: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>`
};
const THEME_LABEL = { dark: 'Dark', light: 'Light', system: 'System' };

function updateThemeIcon(pref) {
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  // Show the *current* mode's icon and label; tooltip explains what clicking does.
  const icon = THEME_ICONS[pref] || THEME_ICONS.dark;
  const label = THEME_LABEL[pref] || 'Dark';
  const idx = THEME_MODES.indexOf(pref);
  const next = THEME_MODES[(idx + 1) % THEME_MODES.length];
  btn.setAttribute('title', 'Theme: ' + label + ' (click for ' + THEME_LABEL[next] + ')');
  btn.innerHTML = icon + `<span id="themeBtnLabel">${label}</span>`;
}
initTheme();

// ─── Sidebar collapse ─────────────────────────────────────────────────────────
function syncSidebarTooltips(collapsed) {
  document.querySelectorAll('.sidebar-link[data-tooltip]').forEach((link) => {
    if (collapsed) {
      link.setAttribute('title', link.dataset.tooltip || '');
      return;
    }

    link.removeAttribute('title');
  });
}

function initSidebar() {
  const collapsed = localStorage.getItem(SIDEBAR_KEY) === 'true';
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  syncSidebarTooltips(collapsed);
}
function toggleSidebar() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  syncSidebarTooltips(collapsed);
}
initSidebar();

// ─── Init ────────────────────────────────────────────────────────────────────
let appIntervals = [];

async function startApp(username) {
  loggedInUser = username;
  document.getElementById('navUser').textContent = loggedInUser;
  const avatar = document.getElementById('navUserAvatar');
  if (avatar) avatar.textContent = (loggedInUser || '?').charAt(0).toUpperCase();
  const topbarUser = document.getElementById('topbarUser');
  if (topbarUser) topbarUser.textContent = loggedInUser;
  const topbarAvatar = document.getElementById('topbarAvatar');
  if (topbarAvatar) topbarAvatar.textContent = (loggedInUser || '?').charAt(0).toUpperCase();
  document.querySelector('.app').style.display = 'grid';
  
  // Re-apply theme icon now that the topbar button is in the DOM
  updateThemeIcon(getThemePref());
  
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
    if (data.status === 'totp_setup') {
      // First-time login: show the QR + secret + confirmation field
      document.getElementById('loginSetupQr').src = data.qrDataUrl || '';
      document.getElementById('loginSetupSecret').textContent = data.totpSecret || '';
      document.getElementById('loginStep2Setup').classList.add('active');
      document.getElementById('loginSetupCode').value = '';
      document.getElementById('loginSetupCode').focus();
    } else {
      document.getElementById('loginStep2').classList.add('active');
      document.getElementById('loginTotp').value = '';
      document.getElementById('loginTotp').focus();
    }
  } catch (e) { showAuthError('loginError', 'Error: ' + e.message); }
  document.getElementById('loginBtn1').disabled = false;
  document.getElementById('loginBtn1').textContent = 'Continue';
}

async function doLoginStep2Setup() {
  hideAuthError('loginSetupError');
  const code = document.getElementById('loginSetupCode').value.trim();
  if (!code || code.length !== 6) return showAuthError('loginSetupError', 'Enter the 6-digit code from your authenticator.');
  if (!loginChallengeToken) return showAuthError('loginSetupError', 'Session expired. Go back and try again.');
  const btn = document.getElementById('loginBtnSetup');
  btn.disabled = true; btn.textContent = 'Verifying...';
  try {
    const res = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken: loginChallengeToken, totpCode: code }) });
    const data = await res.json();
    if (!res.ok) { showAuthError('loginSetupError', data.error || 'Invalid code'); btn.disabled = false; btn.textContent = 'Confirm & Sign In'; return; }
    startApp(data.username);
  } catch (e) { showAuthError('loginSetupError', 'Error: ' + e.message); btn.disabled = false; btn.textContent = 'Confirm & Sign In'; }
}

function copyLoginSetupSecret() {
  const el = document.getElementById('loginSetupSecret');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent || '').catch(() => {});
  const orig = el.style.background;
  el.style.background = 'rgba(34,197,94,0.15)';
  setTimeout(() => { el.style.background = orig; }, 400);
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
  hideAuthError('loginSetupError');
  document.getElementById('loginStep2').classList.remove('active');
  document.getElementById('loginStep2Setup').classList.remove('active');
  document.getElementById('loginStep1').classList.add('active');
  document.getElementById('loginUser').focus();
}

async function doForgotPassword() {
  const userField = document.getElementById('loginUser');
  const email = (userField?.value || '').trim();
  if (!email || email.indexOf('@') === -1) {
    showAuthError('loginError', 'Enter the email address associated with your account, then click "Forgot password?".');
    return;
  }
  hideAuthError('loginError');
  try {
    const res = await fetch('/auth/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    showAuthError('loginError', data.message || 'If an account exists for this address, a password reset email has been sent.');
    const el = document.getElementById('loginError');
    if (el) { el.style.background = 'var(--ok-bg, rgba(0,184,92,0.08))'; el.style.borderColor = 'var(--ok-bdr, rgba(0,184,92,0.2))'; el.style.color = 'var(--ok-text, #00b85c)'; }
  } catch {
    showAuthError('loginError', 'Network error. Try again.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const link = document.getElementById('loginForgotLink');
  if (link) link.addEventListener('click', e => { e.preventDefault(); doForgotPassword(); });
});

function openLogoutModal() {
  const m = document.getElementById('logoutModal');
  if (!m) return;
  m.classList.add('active');
  document.addEventListener('keydown', logoutKeyHandler);
  setTimeout(() => { const b = document.getElementById('logoutCancelBtn'); if (b) b.focus(); }, 30);
}

function closeLogoutModal() {
  const m = document.getElementById('logoutModal');
  if (!m) return;
  const confirmBtn = document.getElementById('logoutConfirmBtn');
  if (confirmBtn && confirmBtn.dataset.loading === '1') return;
  m.classList.remove('active');
  document.removeEventListener('keydown', logoutKeyHandler);
}

function logoutKeyHandler(e) {
  if (e.key === 'Escape') closeLogoutModal();
}

let _confirmModalResolve = null;

function showConfirm(opts) {
  const o = (typeof opts === 'string') ? { message: opts } : (opts || {});
  let title = o.title;
  let message = o.message || '';
  let detail = o.detail || '';
  if (!detail && message.indexOf('\n\n') !== -1) {
    const parts = message.split('\n\n');
    message = parts.shift();
    detail = parts.join('\n\n');
  }
  if (!title) title = 'Confirmação';
  const confirmText = o.confirmText || 'Confirmar';
  const cancelText  = o.cancelText  || 'Cancelar';
  const danger = (o.danger !== false);

  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMessage').textContent = message;
  const det = document.getElementById('confirmModalDetail');
  if (detail) { det.textContent = detail; det.style.display = ''; }
  else { det.textContent = ''; det.style.display = 'none'; }
  const okBtn = document.getElementById('confirmModalConfirmBtn');
  okBtn.textContent = confirmText;
  okBtn.classList.toggle('btn-danger', danger);
  okBtn.classList.toggle('btn-primary', !danger);
  document.getElementById('confirmModalCancelBtn').textContent = cancelText;

  if (_confirmModalResolve) { try { _confirmModalResolve(false); } catch {} }

  const m = document.getElementById('confirmModal');
  m.classList.add('active');
  document.addEventListener('keydown', confirmModalKey);
  setTimeout(() => document.getElementById('confirmModalCancelBtn').focus(), 30);

  return new Promise(res => { _confirmModalResolve = res; });
}

function confirmModalKey(e) {
  if (e.key === 'Escape') confirmModalCancel();
  else if (e.key === 'Enter') confirmModalAccept();
}

function confirmModalCancel() {
  const m = document.getElementById('confirmModal');
  if (m) m.classList.remove('active');
  document.removeEventListener('keydown', confirmModalKey);
  const r = _confirmModalResolve; _confirmModalResolve = null;
  if (r) r(false);
}

function confirmModalAccept() {
  const m = document.getElementById('confirmModal');
  if (m) m.classList.remove('active');
  document.removeEventListener('keydown', confirmModalKey);
  const r = _confirmModalResolve; _confirmModalResolve = null;
  if (r) r(true);
}

async function doLogout() {
  const confirmBtn = document.getElementById('logoutConfirmBtn');
  const cancelBtn  = document.getElementById('logoutCancelBtn');
  const closeBtn   = document.getElementById('logoutCloseBtn');
  if (confirmBtn) {
    confirmBtn.dataset.loading = '1';
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span class="btn-spinner"></span> A terminar sessão…';
  }
  if (cancelBtn) cancelBtn.disabled = true;
  if (closeBtn)  closeBtn.disabled  = true;
  try { await fetch('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  window.location.href = '/';
}

// ─── Navigation ──────────────────────────────────────────────────────────────
const PAGE_TITLES = {
  overview: 'Dashboard',
  requests: 'Request Log',
  tcpudp: 'TCP/UDP',
  profiles: 'HTTP Proxies',
  webhooks: 'Webhooks',
  proxyusers: 'Users',
  oauthclients: 'OAuth Clients',
  consentpages: 'Consent Pages',
  ldap: 'LDAP',
  email: 'Email (SMTP)',
  npm: 'Nginx Proxy Manager',
  audit: 'Audit Log'
};

function navigate(page) {
  let pendingTcpTab = null;
  if (page === 'siplogs') { page = 'tcpudp'; pendingTcpTab = 'logs'; }
  if (page === 'certs')   { page = 'tcpudp'; pendingTcpTab = 'certs'; }
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1));
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll('[data-page]').forEach(n => {
    if (n.dataset.page === page) n.classList.add('active');
    else n.classList.remove('active');
  });
  if (page === 'requests') { rlPage = 1; fetchRequestLogs(); }
  if (page === 'tcpudp') {
    if (pendingTcpTab) switchTcpUdpTab(pendingTcpTab);
    else fetchSipProxies();
  }
  if (page === 'proxyusers') { fetchProxyUsers(); fetchInvites(); }
  if (page === 'oauthclients') { fetchOauthClients(); }
  if (page === 'consentpages') { fetchConsentPages(); }
  if (page === 'ldap') { fetchLdapConfigs(); filterLdapAdoptions('pending'); }
  if (page === 'email') { fetchSmtpConfig(); }
  if (page === 'npm') { if (typeof switchNpmSubpage === 'function') switchNpmSubpage(_npmCurrentSubpage || 'proxy-hosts'); fetchNpmConfig(); }
  if (page === 'audit') { fetchAuditLogs(true); }
  const titleEl = document.getElementById('topbarPageTitle');
  if (titleEl) titleEl.textContent = PAGE_TITLES[page] || page;
  closeNavMobile();
  closeNavMore();
}

function toggleNavMobile() {
  document.body.classList.toggle('nav-open');
}
function closeNavMobile() {
  document.body.classList.remove('nav-open');
}

// Kept as no-ops for backwards compat with older onclick handlers
function toggleNavMore() {}
function closeNavMore() {}

// ─── Responsive tables ──────────────────────────────────────────────────────
// On mobile, tables render as stacked cards. Each <td> needs a data-label
// matching its column header. We auto-inject those by observing tbody changes.
function applyResponsiveLabels(table) {
  if (!table) return;
  const headers = Array.from(table.querySelectorAll('thead th')).map(th => (th.textContent || '').trim());
  if (!headers.length) return;
  table.querySelectorAll('tbody tr').forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length === 1 && tds[0].hasAttribute('colspan')) return; // empty/loading row
    tds.forEach((td, i) => {
      if (headers[i] && !td.hasAttribute('data-label')) {
        td.setAttribute('data-label', headers[i]);
      }
    });
  });
}

function initResponsiveTables() {
  document.querySelectorAll('.card-body table').forEach(table => {
    table.classList.add('responsive-table');
    applyResponsiveLabels(table);
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    new MutationObserver(() => applyResponsiveLabels(table)).observe(tbody, { childList: true, subtree: true });
  });
}
document.addEventListener('DOMContentLoaded', initResponsiveTables);
// also run after window load in case tables are injected later
window.addEventListener('load', initResponsiveTables);

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
