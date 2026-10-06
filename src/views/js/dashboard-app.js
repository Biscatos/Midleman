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
  // Dark by default (matches the bootstrap snippet in every page <head>);
  // 'system' only when the user picks it.
  return THEME_MODES.includes(v) ? v : 'dark';
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
  // Charts sample the theme tokens at draw time — repaint on every theme
  // change (toggle or OS switch in 'system' mode).
  if (typeof redrawOverviewCharts === 'function') redrawOverviewCharts();
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
  if (topbarUser) { topbarUser.textContent = loggedInUser; topbarUser.closest('.topbar-user').title = loggedInUser; }
  const topbarAvatar = document.getElementById('topbarAvatar');
  if (topbarAvatar) topbarAvatar.textContent = (loggedInUser || '?').charAt(0).toUpperCase();
  document.querySelector('.app').style.display = 'grid';
  document.body.classList.add('app-shell'); // the content panel is the only scroller
  
  // Re-apply theme icon now that the topbar button is in the DOM
  updateThemeIcon(getThemePref());
  
  // Hide auth panels if visible
  document.getElementById('authLogin').classList.remove('active');
  document.getElementById('authSetup').classList.remove('active');

  // Immediately set it to Connecting and resolve health check fast to show Online
  document.getElementById('navDot').className = 'status-dot online';
  document.getElementById('navStatus').textContent = 'Connecting...';
  
  await fetchHealth(); // Do this immediately to set 'Online' UI instantly
  
  // Restore the page the user was on before the refresh (hash routing).
  // The Destinations sub-page needs its webhook loaded from the API first —
  // otherwise a refresh lands on an empty page — so fetch webhooks before
  // restoring that one specifically.
  const initialPage = pageFromHash(location.hash) || 'overview';
  if (initialPage === 'webhookDestinations') {
    const name = hashSuffixFromHash(location.hash);
    await fetchWebhooks();
    if (name && typeof manageWebhookDestinations === 'function' && _allWebhooks.some(w => w.name === name)) {
      manageWebhookDestinations(name, false);
    } else {
      navigate('webhooks', { pushHistory: false });
    }
  } else {
    navigate(initialPage, { pushHistory: false });
  }

  // Trigger rest of initializations concurrently without blocking UI main thread
  refreshAll().catch(e => console.error('Dashboard refresh error:', e));

  if (appIntervals.length === 0) {
    appIntervals.push(setInterval(fetchHealth, 5000));
    appIntervals.push(setInterval(fetchRecentRequests, 3000));
    appIntervals.push(setInterval(fetchChartData, 15000));
    appIntervals.push(setInterval(() => {
      if (currentPage === 'requests' && document.getElementById('rlAutoRefresh').checked) fetchRequestLogs();
    }, 5000));
    // Backend error feed: drives the sidebar badge everywhere, and refreshes
    // the list in place while the user is actually sitting on that page.
    appIntervals.push(setInterval(() => {
      fetchErrorStats();
      if (currentPage === 'errors') fetchErrorFeed(false);
    }, 10000));
    fetchErrorStats();
  }
}

window.addEventListener('load', async function init() {
  try {
    const res = await fetch('/auth/status');
    const status = await res.json();

    if (status.needsSetup) {
      document.getElementById('authSetup').classList.add('active');
      document.querySelector('.app').style.display = 'none';
      document.body.classList.remove('app-shell');
      return;
    }

    if (!status.loggedIn) {
      document.getElementById('authLogin').classList.add('active');
      document.querySelector('.app').style.display = 'none';
      document.body.classList.remove('app-shell');
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
  mmCopy(el.textContent || '', el);
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
  if (!title) title = 'Confirm';
  const confirmText = o.confirmText || 'Confirm';
  const cancelText  = o.cancelText  || 'Cancel';
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
    confirmBtn.innerHTML = '<span class="btn-spinner"></span> Signing out…';
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
  connectors: 'Chat Connectors',
  proxyusers: 'Users',
  oauthclients: 'OAuth Clients',
  consentpages: 'Consent Pages',
  ldap: 'LDAP',
  email: 'Email (SMTP)',
  sms: 'SMS',
  notifications: 'Notifications',
  npm: 'Nginx Proxy Manager',
  audit: 'Audit Log',
  errors: 'System Alerts',
  logsettings: 'Log Storage',
  docs: 'Docs',
  reports: 'Report Feeds',
  webhookDestinations: 'Webhooks · Destinations'
};

// Pages that can be reached via hash routing. Aliases (siplogs, certs) are
// resolved inside navigate() and stored under their canonical name.
const ROUTABLE_PAGES = new Set([
  'overview','requests','proxyusers','profiles','connectors',
  'oauthclients','consentpages','ldap','email','sms','notifications',
  'npm','audit','webhooks','ldap','reports','errors','logsettings','docs',
]);

function navigate(page, opts = {}) {
  // Guard against silently losing unsaved destination edits: if we're
  // leaving the Webhook Destinations page with pending changes, confirm first.
  if (typeof currentPage !== 'undefined' && currentPage === 'webhookDestinations' && page !== 'webhookDestinations'
      && typeof webhookFormDirty !== 'undefined' && webhookFormDirty) {
    showConfirm({
      title: 'Unsaved changes',
      message: 'You have unsaved changes to this webhook\'s destinations.',
      detail: 'Leaving now will discard them. Click "Save Webhook" first if you want to keep them.',
      confirmText: 'Leave without saving',
      cancelText: 'Stay',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      webhookFormDirty = false;
      navigate(page, opts);
    });
    return;
  }
  const { pushHistory = true, hashSuffix = null } = opts;
  let pendingTcpTab = null;
  if (page === 'siplogs') { page = 'tcpudp'; pendingTcpTab = 'logs'; }
  if (page === 'certs')   { page = 'tcpudp'; pendingTcpTab = 'certs'; }
  let pendingNotifTab = null;
  if (page === 'email') { page = 'notifications'; pendingNotifTab = 'email'; }
  if (page === 'sms')   { page = 'notifications'; pendingNotifTab = 'sms'; }
  currentPage = page;

  // Update browser URL without triggering a reload. Sub-pages that need
  // context to restore correctly on refresh (e.g. which webhook) encode it
  // as a second hash segment: #webhookDestinations/<name>.
  const hash = '#' + page + (hashSuffix ? '/' + encodeURIComponent(hashSuffix) : '');
  if (pushHistory && location.hash !== hash) {
    history.pushState({ page, hashSuffix }, '', hash);
  } else if (!pushHistory && location.hash !== hash) {
    history.replaceState({ page, hashSuffix }, '', hash);
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1));
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll('[data-page]').forEach(n => {
    if (n.dataset.page === page) n.classList.add('active');
    else n.classList.remove('active');
  });
  // Sub-pages drilled into from another section keep that section's sidebar
  // link highlighted, since there's no dedicated nav entry for the sub-page.
  if (page === 'webhookDestinations') {
    const parentLink = document.querySelector('[data-page="webhooks"]');
    if (parentLink) parentLink.classList.add('active');
  }
  if (SIDEBAR_EXT_PAGES.has(page)) setSidebarExt(true, false);
  if (page === 'requests') { rlPage = 1; fetchRequestLogs(); }
  if (page === 'tcpudp') {
    if (pendingTcpTab) switchTcpUdpTab(pendingTcpTab);
    else fetchSipProxies();
  }
  if (page === 'connectors') { fetchConnectors(); fetchFive9Connectors(); }
  if (page === 'proxyusers') { fetchProxyUsers(); fetchInvites(); }
  if (page === 'oauthclients') { fetchOauthClients(); }
  if (page === 'consentpages') { fetchConsentPages(); }
  if (page === 'ldap') { fetchLdapConfigs(); filterLdapAdoptions('pending'); }
  if (page === 'notifications') { fetchNotifGroups(); fetchNotifRules(); fetchSmtpConfig(); fetchSmsConfig(); }
  if (pendingNotifTab) switchNotifTab(pendingNotifTab);
  if (page === 'npm') { if (typeof switchNpmSubpage === 'function') switchNpmSubpage(_npmCurrentSubpage || 'proxy-hosts'); fetchNpmConfig(); }
  if (page === 'audit') { fetchAuditLogs(true); }
  if (page === 'errors') { fetchErrorFeed(true); }
  if (page === 'logsettings') { fetchLogSettings(); }
  if (page === 'docs') { renderDocs(); }
  if (page === 'reports') { loadReportFeeds(); loadGcInstances(); rfStartSse(); rfViewerUpdateSelect(); }
  const titleEl = document.getElementById('topbarPageTitle');
  if (titleEl) titleEl.textContent = PAGE_TITLES[page] || page;
  closeNavMobile();
  closeNavMore();
}

// Restore page from URL hash on back/forward navigation
window.addEventListener('popstate', e => {
  const page = (e.state && e.state.page) || pageFromHash(location.hash);
  if (!page) return;
  if (page === 'webhookDestinations') {
    const name = (e.state && e.state.hashSuffix) || hashSuffixFromHash(location.hash);
    if (name && typeof manageWebhookDestinations === 'function') manageWebhookDestinations(name, false);
    else navigate('webhooks', { pushHistory: false });
    return;
  }
  navigate(page, { pushHistory: false });
});

// Warn on tab close/refresh/URL navigation while destination edits are unsaved.
// Browsers ignore custom text and show their own generic prompt — that's expected.
window.addEventListener('beforeunload', e => {
  if (typeof currentPage !== 'undefined' && currentPage === 'webhookDestinations'
      && typeof webhookFormDirty !== 'undefined' && webhookFormDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function pageFromHash(hash) {
  // Sub-pages may carry a second segment (e.g. #webhookDestinations/name) —
  // only the first segment identifies the page itself.
  const base = (hash || '').replace(/^#/, '').split('/')[0];
  const raw = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  // resolve aliases to canonical
  if (raw === 'siplogs') return 'tcpudp';
  if (raw === 'certs')   return 'tcpudp';
  if (raw === 'webhookdestinations') return 'webhookDestinations';
  return ROUTABLE_PAGES.has(raw) ? raw : null;
}

// Extracts the "/<name>" suffix from a hash like #webhookDestinations/my-webhook.
function hashSuffixFromHash(hash) {
  const parts = (hash || '').replace(/^#/, '').split('/');
  if (parts.length < 2 || !parts[1]) return null;
  try { return decodeURIComponent(parts.slice(1).join('/')); } catch { return parts.slice(1).join('/'); }
}

// Extensions group (Connectors, Report Feeds): collapsed by default, state
// remembered per browser; auto-opens when one of its pages is the target.
const SIDEBAR_EXT_PAGES = new Set(['connectors', 'reports']);
function setSidebarExt(open, persist = true) {
  const el = document.getElementById('sidebarExt');
  const btn = document.getElementById('sidebarExtToggle');
  if (!el) return;
  el.classList.toggle('open', !!open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (persist) { try { localStorage.setItem('mm.sidebarExtOpen', open ? '1' : '0'); } catch {} }
}
function toggleSidebarExt() {
  const el = document.getElementById('sidebarExt');
  setSidebarExt(!(el && el.classList.contains('open')));
}
(function restoreSidebarExt() {
  let open = false;
  try { open = localStorage.getItem('mm.sidebarExtOpen') === '1'; } catch {}
  if (SIDEBAR_EXT_PAGES.has(pageFromHash(location.hash) || '')) open = true;
  setSidebarExt(open, false);
})();

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
// Run an async task with a busy button: disables the button, swaps its label
// for a spinner + busyLabel, and always restores the original markup/state.
// Resolves with fn()'s return value. Caller may pass either a DOM element or
// the event (we'll pick .currentTarget). No-op (still runs fn) if no element.
async function withBusy(btnOrEvent, busyLabel, fn) {
  let btn = btnOrEvent && btnOrEvent.currentTarget ? btnOrEvent.currentTarget : btnOrEvent;
  if (!btn || !(btn instanceof HTMLElement)) return await fn();
  const originalHtml = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> ' + (busyLabel || 'Processing…');
  try {
    return await fn();
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = wasDisabled;
    btn.removeAttribute('aria-busy');
  }
}

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtNum(n) { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(n); }
function fmtMs(ms) { if (!ms) return '0ms'; if (ms < 1) return ms.toFixed(2) + 'ms'; if (ms < 1000) return Math.round(ms) + 'ms'; return (ms / 1000).toFixed(2) + 's'; }
function fmtUptime(s) { if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm ' + s % 60 + 's'; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h + 'h ' + m + 'm'; }
function fmtBytes(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }

// ─── Field hints live under the field, never inside the label ───────────────
// A muted <span> inside a field label wraps the label onto two lines and pushes
// that field's control below its neighbours in the same grid row. Move any such
// hint to the end of the field's own block as a .mm-field-hint (most were moved
// in the markup already; this catches nested layouts and JS-rendered forms).
function mmRelocateLabelHints(root = document) {
  root.querySelectorAll('label.wz-label > span[style*="--text3"], .form-group > label > span[style*="--text3"]').forEach(span => {
    const label = span.parentElement;
    if (!label || label.querySelector('input,select,textarea')) return; // toggle labels keep their text
    const block = label.parentElement;
    if (!block) return;
    const hint = document.createElement('div');
    hint.className = 'mm-field-hint';
    let text = span.textContent.trim().replace(/^[—–-]\s*/, '');
    if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1);
    hint.textContent = text.charAt(0).toUpperCase() + text.slice(1);
    if (span.title) hint.title = span.title;
    span.remove();
    block.appendChild(hint);
  });
}
mmRelocateLabelHints();


// ─── Menus are always A–Z ───────────────────────────────────────────────────
// Within every section of the sidebar (and the Docs index) items are kept in
// alphabetical order, whatever order the markup lists them in.
function mmSortMenus() {
  const sortRuns = (container, isItem, labelOf) => {
    if (!container) return;
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const anchor = run[run.length - 1].nextSibling;
        run.slice().sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'en', { sensitivity: 'base' }))
          .forEach(el => container.insertBefore(el, anchor));
      }
      run = [];
    };
    [...container.children].forEach(el => { if (isItem(el)) run.push(el); else flush(); });
    flush();
  };
  const sidebarLabel = el => (el.querySelector('.sidebar-link-label')?.textContent || '').trim();
  const isLink = el => el.classList.contains('sidebar-link');
  sortRuns(document.getElementById('sidebarNav'), isLink, sidebarLabel);
  sortRuns(document.getElementById('sidebarExtBody'), isLink, sidebarLabel);
  sortRuns(document.querySelector('.docs-nav'), el => el.matches('a[data-docs]'), el => el.textContent.trim());
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mmSortMenus);
else mmSortMenus();


// ─── Clipboard ──────────────────────────────────────────────────────────────
// navigator.clipboard only exists on HTTPS / localhost; dashboards served over
// plain HTTP fall back to a hidden textarea + execCommand('copy').
// Feedback is shown on the clicked control itself ("✓ Copied"), with a toast
// only when there is no control to show it on.
const MM_CHECK_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function _mmCopyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => _mmCopyFallback(text));
  }
  return _mmCopyFallback(text);
}
function _mmCopyFallback(text) {
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    const active = document.activeElement;
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (active && typeof active.focus === 'function') active.focus({ preventScroll: true });
    ok ? resolve() : reject(new Error('copy not allowed'));
  });
}

/** Copy `text`; `el` (optional) is the control that triggered it and shows the feedback. */
function mmCopy(text, el, okMsg) {
  return _mmCopyText(String(text ?? '')).then(() => {
    if (el && el.tagName === 'BUTTON') _mmCopyFeedback(el, true);
    else if (el) { el.classList.add('mm-copied'); setTimeout(() => el.classList.remove('mm-copied'), 900); }
    if (!el || okMsg) toast(okMsg || 'Copied to clipboard');
    return true;
  }, () => {
    if (el && el.tagName === 'BUTTON') _mmCopyFeedback(el, false);
    toast('Could not copy — select the text and press Ctrl+C', 'error');
    return false;
  });
}
function _mmCopyFeedback(btn, ok) {
  if (!btn.dataset.copyLabel) btn.dataset.copyLabel = btn.innerHTML;
  clearTimeout(btn._copyTimer);
  btn.classList.toggle('is-copied', ok);
  btn.classList.toggle('is-copy-failed', !ok);
  btn.innerHTML = ok ? MM_CHECK_SVG + '<span>Copied</span>' : '<span>Failed</span>';
  btn.setAttribute('aria-live', 'polite');
  btn._copyTimer = setTimeout(() => {
    btn.innerHTML = btn.dataset.copyLabel;
    delete btn.dataset.copyLabel;
    btn.classList.remove('is-copied', 'is-copy-failed');
  }, 1600);
}
/** For buttons: copies data-copy, else the <pre> of the surrounding code block. */
function mmCopyFrom(btn) {
  const text = btn.dataset.copy !== undefined
    ? btn.dataset.copy
    : (btn.closest('.rdm-code-block, .docs-codeblock')?.querySelector('pre')?.textContent || '');
  return mmCopy(text, btn);
}


// ─── Sticky page toolbars ───────────────────────────────────────────────────
// On list pages the title and the filter bar stay pinned while the table
// scrolls: the page header and the filter bar that follows it are wrapped in
// one sticky block (CSS: .page-sticky).
function mmStickyToolbars() {
  document.querySelectorAll('.page > .page-header').forEach(h => {
    if (h.parentElement.classList.contains('page-sticky')) return;
    const bar = h.nextElementSibling;
    const hasBar = !!bar && bar.classList.contains('mm-filterbar');
    // Pages opt in without a filter bar with data-sticky on their header (e.g. Docs).
    if (!hasBar && !h.hasAttribute('data-sticky')) return;
    const wrap = document.createElement('div');
    wrap.className = 'page-sticky';
    h.before(wrap);
    wrap.append(h);
    if (hasBar) wrap.append(bar);
  });
  // Table headers stick right under the toolbar: expose its height to CSS.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(entries => {
      for (const en of entries) en.target.parentElement.style.setProperty('--page-sticky-h', Math.round(en.target.getBoundingClientRect().height) + 'px');
    });
    document.querySelectorAll('.page > .page-sticky').forEach(w => ro.observe(w));
  }
  const main = document.querySelector('.main');
  if (!main) return;
  const mark = () => {
    const stuck = main.scrollTop > 8;
    document.querySelectorAll('.page.active .page-sticky').forEach(w => w.classList.toggle('is-stuck', stuck));
  };
  main.addEventListener('scroll', mark, { passive: true });
  mark();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mmStickyToolbars);
else mmStickyToolbars();

// ─── Pagination only when there is more than one page ───────────────────────
// Every list pager is a Prev/Next pair (ids ending in Prev / Next) that the
// page code enables or disables. When both are disabled there is nothing to
// page through, so the whole pager row is hidden. A button busy with a fetch
// (aria-busy) still counts as enabled so the row never flickers.
function mmSyncPager(prev) {
  const next = document.getElementById(prev.id.replace(/Prev$/, 'Next'));
  if (!next) return;
  const off = b => b.disabled && !b.hasAttribute('aria-busy');
  const group = prev.parentElement;
  const row = group.parentElement && group.parentElement.children.length <= 2 ? group.parentElement : group;
  row.style.display = off(prev) && off(next) ? 'none' : '';
}
function mmWatchPagers() {
  const prevs = [...document.querySelectorAll('button[id$="Prev"]')].filter(b => document.getElementById(b.id.replace(/Prev$/, 'Next')));
  const mo = new MutationObserver(muts => {
    const seen = new Set();
    for (const m of muts) {
      const id = m.target.id.replace(/Next$/, 'Prev');
      if (seen.has(id)) continue;
      seen.add(id);
      const p = document.getElementById(id);
      if (p) mmSyncPager(p);
    }
  });
  prevs.forEach(p => {
    mmSyncPager(p);
    mo.observe(p, { attributes: true, attributeFilter: ['disabled', 'aria-busy'] });
    mo.observe(document.getElementById(p.id.replace(/Prev$/, 'Next')), { attributes: true, attributeFilter: ['disabled', 'aria-busy'] });
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mmWatchPagers);
else mmWatchPagers();
