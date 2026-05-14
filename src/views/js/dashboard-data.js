// ─── Key Generator ───────────────────────────────────────────────────────────
function generateKey(targetInputId, length = 48) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  const key = Array.from(arr, b => chars[b % chars.length]).join('');
  document.getElementById(targetInputId).value = key;
}

// ─── IP Tag Input ────────────────────────────────────────────────────────────
const IpTagInput = (() => {
  const instances = new Map();

  function _build(id) {
    const wrap = document.getElementById(id);
    if (!wrap) return null;

    const state = { tags: [], wrap, input: null, renderChip: null, syncPlaceholder: null };

    state.syncPlaceholder = () => {
      state.input.placeholder = state.tags.length === 0 ? 'e.g. 192.168.1.0, 10.0.0.0/8, 172.16.*' : '';
    };

    state.renderChip = (ip) => {
      const chip = document.createElement('span');
      chip.className = 'ip-chip';
      chip.appendChild(document.createTextNode(ip));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = 'Remove';
      btn.textContent = '\u00d7';
      btn.addEventListener('click', () => {
        const i = state.tags.indexOf(ip);
        if (i >= 0) state.tags.splice(i, 1);
        chip.remove();
        state.syncPlaceholder();
      });
      chip.appendChild(btn);
      return chip;
    };

    const addTags = (raw) => {
      for (const ip of raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)) {
        if (!state.tags.includes(ip)) {
          state.tags.push(ip);
          wrap.insertBefore(state.renderChip(ip), state.input);
        }
      }
      state.syncPlaceholder();
    };

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ip-tag-input';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    state.input = input;

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = input.value.replace(/,+$/, '').trim();
        if (val) { addTags(val); input.value = ''; }
      } else if (e.key === 'Backspace' && input.value === '' && state.tags.length > 0) {
        state.tags.pop();
        wrap.querySelectorAll('.ip-chip').forEach((c, i, a) => { if (i === a.length - 1) c.remove(); });
        state.syncPlaceholder();
      }
    });
    input.addEventListener('blur', () => {
      const val = input.value.replace(/[,\s]+$/, '').trim();
      if (val) { addTags(val); input.value = ''; }
    });
    input.addEventListener('input', () => {
      if (input.value.includes(',')) {
        const comma = input.value.lastIndexOf(',');
        const before = input.value.substring(0, comma).trim();
        if (before) { addTags(before); input.value = input.value.substring(comma + 1).trimStart(); }
      }
    });

    wrap.addEventListener('click', e => { if (e.target === wrap) input.focus(); });
    wrap.appendChild(input);
    state.syncPlaceholder();
    return state;
  }

  function init(id) {
    if (!instances.has(id)) {
      const s = _build(id);
      if (s) instances.set(id, s);
    }
  }

  function getValue(id) { return [...(instances.get(id)?.tags || [])]; }

  function setValue(id, ips) {
    const s = instances.get(id);
    if (!s) return;
    s.wrap.querySelectorAll('.ip-chip').forEach(c => c.remove());
    s.tags.length = 0;
    for (const ip of (ips || [])) {
      if (ip && !s.tags.includes(ip)) {
        s.tags.push(ip);
        s.wrap.insertBefore(s.renderChip(ip), s.input);
      }
    }
    s.syncPlaceholder();
  }

  return { init, getValue, setValue };
})();

IpTagInput.init('pAllowedIps');
IpTagInput.init('wAllowedIps');

// ─── Action Dropdown Menu ────────────────────────────────────────────────────
let _activeMenu = null;

document.addEventListener('click', () => {
  if (_activeMenu) { _activeMenu.remove(); _activeMenu = null; }
});

function showActionMenu(btn, items) {
  if (_activeMenu) { _activeMenu.remove(); _activeMenu = null; }

  const rect = btn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.style.cssText = 'position:fixed;z-index:9999;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.25);min-width:170px;padding:4px 0;';
  menu.style.top  = (rect.bottom + 6) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';

  for (const item of items) {
    if (!item) continue;
    if (item === '---') {
      const sep = document.createElement('div');
      sep.style.cssText = 'border-top:1px solid var(--border);margin:3px 0;';
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement('button');
    el.textContent = item.label;
    el.style.cssText = `appearance:none;-webkit-appearance:none;display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 14px;background:transparent;border:none;cursor:pointer;font-size:13px;color:${item.danger ? 'var(--red)' : 'var(--text)'};white-space:nowrap;`;
    el.onmouseenter = () => { el.style.background = 'var(--surface2)'; el.style.color = item.danger ? 'var(--red)' : 'var(--text)'; };
    el.onmouseleave = () => { el.style.background = 'transparent'; el.style.color = item.danger ? 'var(--red)' : 'var(--text)'; };
    el.onclick = (e) => { e.stopPropagation(); _activeMenu?.remove(); _activeMenu = null; item.fn(); };
    menu.appendChild(el);
  }

  // Flip upward if it would overflow the viewport
  document.body.appendChild(menu);
  if (rect.bottom + menu.offsetHeight + 6 > window.innerHeight) {
    menu.style.top = (rect.top - menu.offsetHeight - 6) + 'px';
  }
  _activeMenu = menu;
}

function showContextMenu(e, btn) {
  e.stopPropagation();
  const type = btn.dataset.type;
  const name = btn.dataset.name;

  if (type === 'webhook') {
    const w = _allWebhooks.find(x => x.name === name);
    if (!w) return;
    const dlqCount = _dlqByWebhook[name] || 0;
    showActionMenu(btn, [
      dlqCount > 0 ? { label: `Failed deliveries (${dlqCount})`, fn: () => openDlqModal(name), danger: true } : null,
      { label: 'View Logs', fn: () => viewWebhookLogs(name) },
      { label: 'Restart', fn: () => restartWebhookAction(name) },
      { label: 'Edit', fn: () => editWebhook(name) },
      '---',
      { label: 'Delete', fn: () => deleteWebhook(name), danger: true },
    ]);
  } else if (type === 'profile') {
    const p = _allProfiles.find(x => x.name === name);
    if (!p) return;
    const authMode = p.authMode || (p.hasAccessKey ? 'accessKey' : 'none');
    showActionMenu(btn, [
      p.port ? { label: `Open :${p.port}`, fn: () => window.open(`${location.protocol}//${location.hostname}:${p.port}/`, '_blank') } : null,
      { label: 'Copy URL', fn: () => copyProxyUrl(p.name, p.port || 0) },
      authMode === 'accessKey' && p.hasAccessKey ? { label: 'Copy Key', fn: () => copyProfileCredential(p.name) } : null,
      authMode === 'login' ? { label: 'Manage Users', fn: () => openProxyUsersModal(p.name) } : null,
      { label: 'Restart', fn: () => restartProfileAction(p.name) },
      { label: 'Edit', fn: () => editProfile(p.name) },
      '---',
      { label: 'Delete', fn: () => deleteProfile(p.name), danger: true },
    ]);
  }
}

// ─── Data Fetch ──────────────────────────────────────────────────────────────
async function refreshAll() {
  await Promise.all([fetchHealth(), fetchConfig(), fetchProfiles(), fetchWebhooks(), fetchSipProxies(), fetchProxyUsers(), fetchInvites(), fetchRequestLogStats(), fetchRecentRequests(), fetchChartData(), fetchOauthClients(), fetchConsentPages(), fetchLdapConfigs(), fetchLdapAdoptions()]);
}

async function fetchHealth() {
  try {
    const res = await fetch('/health'); const d = await res.json();
    document.getElementById('navDot').className = 'status-dot online';
    document.getElementById('navStatus').textContent = 'Online';
    document.getElementById('navUptime').textContent = fmtUptime(d.uptime);
    const td = document.getElementById('topbarDot'); if (td) td.className = 'status-dot online';
    const ts = document.getElementById('topbarStatus'); if (ts) ts.textContent = 'Online';
    document.getElementById('ovStatus').textContent = 'Online';
    document.getElementById('ovStatus').style.color = 'var(--green)';
    document.getElementById('ovUptime').textContent = 'Uptime: ' + fmtUptime(d.uptime);
    document.getElementById('ovActive').textContent = d.activeRequests;
    document.getElementById('ovProfiles').textContent = d.proxyProfiles || 0;
    document.getElementById('ovWebhooks').textContent = d.webhooks || 0;
  } catch {
    document.getElementById('navDot').className = 'status-dot offline';
    document.getElementById('navStatus').textContent = 'Offline';
    document.getElementById('navUptime').textContent = '';
    const td = document.getElementById('topbarDot'); if (td) td.className = 'status-dot offline';
    const ts = document.getElementById('topbarStatus'); if (ts) ts.textContent = 'Offline';
    document.getElementById('ovStatus').textContent = 'Offline';
    document.getElementById('ovStatus').style.color = 'var(--red)';
  }
}

async function fetchRequestLogStats() {
  try {
    const res = await api('/admin/requests/stats'); if (!res.ok) return;
    const s = await res.json();
    document.getElementById('navReqBadge').textContent = fmtNum(s.total);
    const el = document.getElementById('ovQuickMetrics');
    if (s.total === 0) {
      el.innerHTML = '<div style="color:var(--text3);font-size:14px;text-align:center;padding:20px">No requests recorded yet.</div>';
    } else {
      el.innerHTML = `
    <div class="metrics-row">
      <div class="metric-box"><div class="metric-val">${fmtNum(s.total)}</div><div class="metric-lbl">Total Requests</div></div>
      <div class="metric-box"><div class="metric-val">${s.dbSizeMB || 0} MB</div><div class="metric-lbl">Log Size</div></div>
      <div class="metric-box"><div class="metric-val">${s.oldest ? new Date(s.oldest + 'Z').toLocaleDateString() : '-'}</div><div class="metric-lbl">Since</div></div>
      <div class="metric-box"><div class="metric-val">${s.newest ? new Date(s.newest + 'Z').toLocaleTimeString() : '-'}</div><div class="metric-lbl">Last Request</div></div>
    </div>`;
    }
  } catch { }
}

async function fetchRecentRequests() {
  try {
    const res = await api('/admin/requests?limit=10');
    if (!res.ok) return;
    const data = await res.json();
    const reqs = data.requests || [];
    fetchRequestLogStats();
    const tbody = document.getElementById('ovRecentBody');
    const count = document.getElementById('ovFeedCount');
    count.textContent = data.total + ' total';
    if (reqs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:30px;text-align:center;color:var(--text3)">No requests yet.</td></tr>';
      return;
    }
    const newestId = reqs[0]?.id || 0;
    const isNew = newestId > lastReqLogId;
    lastReqLogId = newestId;
    tbody.innerHTML = reqs.map((r, i) => {
      const ts = new Date(r.timestamp + 'Z');
      const sc = r.resStatus;
      const statusCls = !sc ? 'color:var(--text3)' : sc < 300 ? 'color:var(--green)' : sc < 400 ? 'color:var(--blue)' : sc < 500 ? 'color:var(--orange)' : 'color:var(--red)';
      const typeBadge = r.type === 'proxy'
        ? '<span style="background:var(--accent-bg);color:var(--accent2);padding:2px 8px;border-radius:4px;font-size:11px">proxy' + (r.profileName ? ' / ' + esc(r.profileName) : '') + '</span>'
        : r.type === 'webhook'
        ? '<span style="background:var(--orange-bg);color:var(--orange);padding:2px 8px;border-radius:4px;font-size:11px">webhook' + (r.targetName ? ' / ' + esc(r.targetName) : '') + '</span>'
        : '<span style="background:var(--blue-bg);color:var(--blue);padding:2px 8px;border-radius:4px;font-size:11px">other' + (r.targetName ? ' / ' + esc(r.targetName) : '') + '</span>';
      const methodCls = r.method === 'GET' ? 'color:var(--green)' : r.method === 'POST' ? 'color:var(--blue)' : r.method === 'DELETE' ? 'color:var(--red)' : 'color:var(--orange)';
      const flash = isNew && i === 0 ? 'animation:flash 1s ease' : '';
      return `<tr style="border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.15s;${flash}" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''" onclick="navigate('requests');setTimeout(()=>openReqDetail(${r.id}),300)">
    <td style="padding:6px 12px;white-space:nowrap;color:var(--text2);font-size:12px">${ts.toLocaleTimeString()}</td>
    <td style="padding:6px 8px">${typeBadge}</td>
    <td style="padding:6px 8px;font-weight:600;${methodCls}">${esc(r.method)}</td>
    <td style="padding:6px 8px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.path)}">${esc(r.path)}</td>
    <td style="padding:6px 8px;font-weight:600;${statusCls}">${sc || '-'}</td>
    <td style="padding:6px 8px;color:var(--text2)">${r.durationMs ? fmtMs(r.durationMs) : '-'}</td>
  </tr>`;
    }).join('');
  } catch { }
}

async function fetchConfig() {
  try {
    const res = await api('/admin/config'); if (!res.ok) return; const d = await res.json();
  } catch { }
}

// ─── Profiles ────────────────────────────────────────────────────────────────
async function fetchProfiles() {
  try {
    const res = await api('/admin/profiles'); if (!res.ok) return;
    const d = await res.json(); _allProfiles = d.profiles || [];
    filterProfiles();
    if (_allInvites.length) renderInvites(_allInvites);
    document.getElementById('navProfileBadge').textContent = _allProfiles.length;
    document.getElementById('ovProfileNames').textContent = _allProfiles.map(p => p.name).join(', ') || 'none';
  } catch { }
}

function filterProfiles() {
  const search = (document.getElementById('profileSearch')?.value || '').toLowerCase();
  const authF = document.getElementById('profileAuthFilter')?.value || '';
  const accessF = document.getElementById('profileAccessFilter')?.value || '';
  const filtered = _allProfiles.filter(p => {
    if (search && !p.name.toLowerCase().includes(search) && !p.targetUrl.toLowerCase().includes(search)) return false;
    if (authF === 'enabled' && !p.authHeader) return false;
    if (authF === 'passthrough' && p.authHeader) return false;
    if (accessF === 'protected' && !p.hasAccessKey) return false;
    if (accessF === 'public' && p.hasAccessKey) return false;
    return true;
  });
  renderProfiles(filtered);
}

function renderProfiles(profiles) {
  const c = document.getElementById('profileListBody');
  if (profiles.length === 0) { c.innerHTML = '<tr><td colspan="8" style="padding:40px;text-align:center;color:var(--text3)">No proxies yet. Click "+ New Proxy".</td></tr>'; return; }
  c.innerHTML = profiles.map(p => {
    const statusBadge = p.running
      ? '<span style="background:var(--green-bg);color:var(--green);padding:2px 8px;border-radius:4px;font-size:11px">Running</span>'
      : '<span style="background:var(--red-bg);color:var(--red);padding:2px 8px;border-radius:4px;font-size:11px">Stopped</span>';
    const hasAuth = p.authHeader;
    const authVal = hasAuth
      ? esc(p.authHeader) + (p.authPrefix ? ` <span style="color:var(--text3)">(${esc(p.authPrefix)})</span>` : '')
      : '<span style="color:var(--text3)">Passthrough</span>';
    const authMode = p.authMode || (p.hasAccessKey ? 'accessKey' : 'none');
    const accessBadge = authMode === 'login'
      ? '<span style="background:var(--blue-bg,rgba(59,130,246,0.1));color:var(--blue,#60a5fa);padding:2px 8px;border-radius:4px;font-size:11px">Login</span>'
      : authMode === 'accessKey'
      ? '<span style="background:var(--orange-bg);color:var(--orange);padding:2px 8px;border-radius:4px;font-size:11px">Key</span>'
      : '<span style="color:var(--text3)">Public</span>';
    const ipBadge = (p.allowedIps && p.allowedIps.length)
      ? `<span style="background:var(--surface2);color:var(--text2);padding:2px 8px;border-radius:4px;font-size:11px;margin-left:4px" title="${esc(p.allowedIps.join(', '))}">IP restricted</span>`
      : '';
    const blockedVal = p.blockedExtensions?.length
      ? `<span style="color:var(--red)">${esc(p.blockedExtensions.join(', '))}</span>`
      : '<span style="color:var(--text3)">None</span>';
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
  <td style="padding:8px 12px;font-weight:600">${esc(p.name)}</td>
  <td style="padding:8px">${statusBadge}</td>
  <td style="padding:8px;font-family:'SF Mono',Monaco,monospace;color:var(--accent2)">${p.port || '<span style="color:var(--text3)">N/A</span>'}</td>
  <td style="padding:8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'SF Mono',Monaco,monospace;color:var(--text2)" title="${esc(p.targetUrl)}">${esc(p.targetUrl)}</td>
  <td style="padding:8px">${authVal}</td>
  <td style="padding:8px">${accessBadge}${ipBadge}</td>
  <td style="padding:8px">${blockedVal}</td>
  <td style="padding:8px 12px;text-align:right">
    <button data-type="profile" data-name="${esc(p.name)}" onclick="showContextMenu(event,this)" style="background:none;border:1px solid var(--border);border-radius:6px;padding:2px 10px;cursor:pointer;color:var(--text2);font-size:18px;line-height:1.2;letter-spacing:1px" title="Actions">&#8942;</button>
  </td>
</tr>`;
  }).join('');
}

// ─── Profile CRUD ────────────────────────────────────────────────────────────
async function openProfileModal(profile = null) {
  // Pages may not be loaded yet on first open — make sure the dropdown has options.
  if (!_consentPages.length) await fetchConsentPages();
  editingProfile = profile;
  document.getElementById('modalTitle').textContent = profile ? 'Edit Proxy' : 'New Proxy';
  document.getElementById('pName').value = profile ? profile.name : ''; document.getElementById('pName').disabled = !!profile;
  document.getElementById('pTargetUrl').value = profile ? profile.targetUrl : '';
  document.getElementById('pApiKey').value = profile ? (profile.apiKey || '') : '';
  document.getElementById('pAuthHeader').value = profile ? (profile.authHeader || '') : '';
  document.getElementById('pAuthPrefix').value = profile ? (profile.authPrefix || '') : '';
  document.getElementById('pAccessKey').value = profile ? (profile.accessKey || '') : '';
  document.getElementById('pAuthMode').value = profile ? (profile.authMode || 'none') : 'none';
  document.getElementById('pRequire2fa').checked = profile ? !!profile.require2fa : false;
  document.getElementById('pIsWebApp').checked = profile ? !!profile.isWebApp : false;
  document.getElementById('pDisableLogs').checked = profile ? !!profile.disableLogs : false;
  document.getElementById('pForwardPath').checked = profile ? profile.forwardPath !== false : true;
  document.getElementById('pAllowSelfSignedTls').checked = profile ? !!profile.allowSelfSignedTls : false;
  document.getElementById('pLoginTitle').value = profile ? (profile.loginTitle || '') : '';
  document.getElementById('pLoginLogo').value = profile ? (profile.loginLogo || '') : '';
  document.getElementById('pLoginLogoFile').value = '';
  document.getElementById('pConsentEnabled').checked = profile ? !!profile.consentEnabled : false;
  _populateConsentPageDropdown('pConsentPageId', profile ? profile.consentPageId : null);
  toggleConsentFields();
  updateLogoPreview();
  document.getElementById('pBlocked').value = profile?.blockedExtensions ? profile.blockedExtensions.join(', ') : '';
  IpTagInput.setValue('pAllowedIps', profile?.allowedIps || []);
  toggleProfileAuthMode();
  document.getElementById('profileModal').classList.add('active');
}
function toggleProfileAuthMode() {
  const mode = document.getElementById('pAuthMode').value;
  document.getElementById('pAccessKeyGroup').style.display = mode === 'accessKey' ? '' : 'none';
  document.getElementById('pRequire2faGroup').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('pIsWebAppGroup').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('pLoginTitleGroup').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('pLoginLogoGroup').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('pConsentGroup').style.display = mode === 'login' ? '' : 'none';
}
function toggleConsentFields() {
  const on = document.getElementById('pConsentEnabled').checked;
  document.getElementById('pConsentFields').style.display = on ? '' : 'none';
}
function closeProfileModal() { document.getElementById('profileModal').classList.remove('active'); editingProfile = null; }

function handleLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.match(/^image\/(png|jpeg|gif|webp)$/)) return toast('Only PNG, JPEG, GIF or WebP allowed', 'error');
  if (file.size > 100 * 1024) return toast('Logo must be under 100 KB', 'error');
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('pLoginLogo').value = e.target.result;
    updateLogoPreview();
  };
  reader.readAsDataURL(file);
}
function updateLogoPreview() {
  const val = document.getElementById('pLoginLogo').value.trim();
  const preview = document.getElementById('pLoginLogoPreview');
  const img = document.getElementById('pLoginLogoImg');
  if (val) { img.src = val; preview.style.display = 'flex'; preview.style.alignItems = 'center'; }
  else { preview.style.display = 'none'; img.src = ''; }
}
function clearLogo() {
  document.getElementById('pLoginLogo').value = '';
  document.getElementById('pLoginLogoFile').value = '';
  updateLogoPreview();
}
async function saveProfile() {
  const body = { name: document.getElementById('pName').value.trim(), targetUrl: document.getElementById('pTargetUrl').value.trim() };
  const v = (id) => document.getElementById(id).value.trim();
  if (v('pApiKey')) body.apiKey = v('pApiKey');
  if (v('pAuthHeader')) body.authHeader = v('pAuthHeader');
  if (v('pAuthPrefix')) body.authPrefix = v('pAuthPrefix');
  const authMode = v('pAuthMode');
  body.authMode = authMode;
  if (authMode === 'accessKey' && v('pAccessKey')) body.accessKey = v('pAccessKey');
  if (authMode === 'login') {
    body.require2fa = document.getElementById('pRequire2fa').checked;
    body.isWebApp = document.getElementById('pIsWebApp').checked;
  }
  body.disableLogs = document.getElementById('pDisableLogs').checked;
  body.forwardPath = document.getElementById('pForwardPath').checked;
  body.allowSelfSignedTls = document.getElementById('pAllowSelfSignedTls').checked;
  const loginTitle = document.getElementById('pLoginTitle').value.trim();
  const loginLogo = document.getElementById('pLoginLogo').value.trim();
  if (loginTitle) body.loginTitle = loginTitle;
  if (loginLogo) body.loginLogo = loginLogo;
  if (authMode === 'login') {
    const consentEnabled = document.getElementById('pConsentEnabled').checked;
    const consentPageRaw = document.getElementById('pConsentPageId').value;
    const consentPageId = consentPageRaw ? Number(consentPageRaw) : null;
    if (consentEnabled && !consentPageId) {
      toast('Choose a consent page or disable consent.', 'error');
      return;
    }
    body.consentEnabled = consentEnabled;
    body.consentPageId = consentPageId;
  }
  const blocked = v('pBlocked'); if (blocked) body.blockedExtensions = blocked.split(',').map(s => s.trim()).filter(Boolean);
  const allowedIps = IpTagInput.getValue('pAllowedIps'); if (allowedIps.length) body.allowedIps = allowedIps;
  try {
    const res = await api('/admin/profiles', { method: 'POST', body: JSON.stringify(body) }); const d = await res.json();
    if (res.ok) { toast('Proxy ' + (d.status || 'saved')); closeProfileModal(); await fetchProfiles(); }
    else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function editProfile(name) {
  try { const res = await api('/admin/profiles/' + encodeURIComponent(name)); if (!res.ok) return toast('Not found', 'error'); openProfileModal((await res.json()).profile); } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function deleteProfile(name) {
  if (!confirm('Delete proxy "' + name + '"?')) return;
  try { const res = await api('/admin/profiles/' + encodeURIComponent(name), { method: 'DELETE' }); if (res.ok) { toast('Proxy deleted'); await fetchProfiles(); } } catch (e) { toast('Error: ' + e.message, 'error'); }
}
function copyProxyUrl(name, port) {
  if (!port || port <= 0) { toast('No port assigned for "' + name + '"', 'error'); return; }
  const url = location.protocol + '//' + location.hostname + ':' + port + '/';
  navigator.clipboard.writeText(url).then(() => toast('Copied: ' + url)).catch(() => prompt('Copy:', url));
}
async function copyProfileCredential(name) {
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(name));
    if (!res.ok) return toast('Not found', 'error');
    const { profile } = await res.json();
    const key = profile.accessKey;
    if (!key) return toast('No access key set', 'error');
    navigator.clipboard.writeText(key).then(() => toast('Access key copied')).catch(() => prompt('Copy:', key));
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function reloadProfiles() {
  try {
    const res = await api('/admin/reload', { method: 'POST' }); const d = await res.json();
    if (res.ok) { toast('Proxies reloaded: ' + (d.profiles || []).join(', ')); await fetchProfiles(); } else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function restartProfileAction(name) {
  try { const res = await api('/admin/profiles/' + encodeURIComponent(name) + '/restart', { method: 'POST' }); if ((await res.json()).status) { toast('Proxy "' + name + '" restarted'); await fetchProfiles(); } } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── Global Proxy Users ─────────────────────────────────────────────────────
let _allOauthClients = [];
let _allInvites = [];
let _allProxyUsers = [];

let _userRoleFilter = '';

async function fetchProxyUsers() {
  try {
    const res = await api('/admin/proxy-users');
    if (!res.ok) return;
    const d = await res.json();
    _allProxyUsers = d.users || [];
    if (typeof d.currentUserId === 'number') _currentUserId = d.currentUserId;
    document.getElementById('navProxyUserBadge').textContent = _allProxyUsers.length;
    renderProxyUsers(_filteredProxyUsers());
  } catch {}
}

function _filteredProxyUsers() {
  switch (_userRoleFilter) {
    case 'admin': return _allProxyUsers.filter(u => u.isAdmin);
    case 'user':  return _allProxyUsers.filter(u => !u.isAdmin);
    case 'ldap':  return _allProxyUsers.filter(u => u.authSource === 'ldap');
    case 'local': return _allProxyUsers.filter(u => u.authSource !== 'ldap');
    default:      return _allProxyUsers;
  }
}

function filterProxyUsersByRole() {
  _userRoleFilter = document.getElementById('userRoleFilter').value;
  renderProxyUsers(_filteredProxyUsers());
}

function _roleBadge(u) {
  const parts = [];
  if (u.isAdmin) {
    parts.push('<span style="display:inline-block;background:rgba(59,130,246,.15);color:#2563eb;border:1px solid rgba(59,130,246,.3);border-radius:10px;padding:1px 8px;font-size:10.5px;font-weight:600;letter-spacing:.04em">ADMIN</span>');
  } else {
    parts.push('<span style="display:inline-block;background:rgba(148,163,184,.15);color:var(--text3);border:1px solid var(--border);border-radius:10px;padding:1px 8px;font-size:10.5px;font-weight:600;letter-spacing:.04em">USER</span>');
  }
  if (u.authSource === 'ldap') {
    parts.push('<span style="display:inline-block;background:rgba(168,85,247,.12);color:#a855f7;border:1px solid rgba(168,85,247,.25);border-radius:10px;padding:1px 8px;font-size:10.5px;font-weight:600;letter-spacing:.04em" title="Account synced from LDAP">LDAP</span>');
  }
  return parts.join(' ');
}

function renderProxyUsers(users) {
  const c = document.getElementById('proxyUserListBody');
  if (!c) return;
  const countEl = document.getElementById('userRoleFilterCount');
  if (countEl) countEl.textContent = users.length + ' of ' + _allProxyUsers.length;
  if (users.length === 0) {
    c.innerHTML = '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text3)">No users match the current filter.</td></tr>';
    return;
  }
  c.innerHTML = users.map(u => {
    const twoFa = u.totpEnabled
      ? '<span style="color:var(--green)">Active</span>'
      : (u.force2faSetup
        ? '<span style="color:var(--orange)" title="User must configure 2FA on next login">Pending setup</span>'
        : '<span style="color:var(--text3)">Off</span>');
    const profiles = (u.profiles || []).map(p => `<span style="background:var(--surface2);padding:1px 6px;border-radius:3px;font-size:11px;font-family:monospace">${esc(p)}</span>`).join(' ');
    const nameCell = u.fullName
      ? `<div style="font-weight:600;color:var(--text)">${esc(u.fullName)}</div><div style="font-size:11px;color:var(--text3);font-family:monospace">${esc(u.username)}</div>`
      : `<div style="font-weight:600;color:var(--text)">${esc(u.username)}</div>`;
    const emailCell = u.email
      ? `<div style="font-size:12px;color:var(--text2)">${esc(u.email)}</div>`
      : `<span style="color:var(--text3)">—</span>`;
    const actionsCell = `<button onclick="openEditProxyUserModal(${u.id})" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--text2);font-size:11px;margin-right:4px" title="Edit">Edit</button>
         <button onclick="openUserProfilesModal(${u.id},'${esc(u.username)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--text2);font-size:11px;margin-right:4px" title="Manage proxies">Proxies</button>
         ${u.totpEnabled
           ? `<button onclick="disable2fa(${u.id},'${esc(u.username)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--orange);font-size:11px;margin-right:4px" title="Disable 2FA (user will be notified by email)">Disable 2FA</button>`
           : (u.force2faSetup
             ? ''
             : `<button onclick="force2fa(${u.id},'${esc(u.username)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--orange);font-size:11px;margin-right:4px" title="Require user to set up 2FA on next login">Force 2FA</button>`)}
         <button onclick="deleteProxyUserAction(${u.id},'${esc(u.username)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--red);font-size:11px" title="Delete">Delete</button>`;
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
      <td style="padding:8px 12px">${nameCell}</td>
      <td style="padding:8px">${emailCell}</td>
      <td style="padding:8px">${_roleBadge(u)}</td>
      <td style="padding:8px">${twoFa}</td>
      <td style="padding:8px">${profiles || '<span style="color:var(--text3)">—</span>'}</td>
      <td style="padding:8px;color:var(--text3);font-size:12px">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-GB') : '-'}</td>
      <td style="padding:8px 12px;text-align:right;white-space:nowrap">${actionsCell}</td>
    </tr>`;
  }).join('');
}

function closeNewProxyUserModal() {
  document.getElementById('newProxyUserModal').classList.remove('active');
  _editUserId = null;
}

// ─── Edit Proxy User Modal ────────────────────────────────────────────────────
let _editUserId = null;

async function openEditProxyUserModal(id) {
  _editUserId = id;
  const user = _allProxyUsers.find(u => u.id === id);
  if (!user) return;
  document.getElementById('npuFullName').value = user.fullName || '';
  document.getElementById('npuEmail').value = user.email || '';
  document.getElementById('npuUsername').value = user.username;
  document.getElementById('npuPassword').value = '';
  document.getElementById('npuPassword').placeholder = 'Leave blank to keep current password';
  document.getElementById('npuIsAdmin').checked = !!user.isAdmin;
  // Hide the admin toggle when editing yourself — backend refuses self-demote.
  const isSelf = user.id === _currentUserId;
  document.getElementById('npuIsAdminGroup').style.display = isSelf ? 'none' : '';
  document.getElementById('npuError').style.display = 'none';
  // Profile assignment is managed elsewhere — hide the section.
  document.getElementById('npuProfileChecks').closest('.form-group').style.display = 'none';
  document.getElementById('npuUsername').readOnly = true;
  document.getElementById('npuUsername').style.opacity = '0.5';
  document.getElementById('newProxyUserModal').classList.add('active');
}

async function saveEditProxyUser() {
  const errEl = document.getElementById('npuError');
  errEl.style.display = 'none';
  const fullName = document.getElementById('npuFullName').value.trim();
  const email = document.getElementById('npuEmail').value.trim();
  const password = document.getElementById('npuPassword').value;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Invalid email.'; errEl.style.display = 'block'; return; }
  const body = { fullName, email };
  if (password) {
    if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
    body.password = password;
  }
  // Send isAdmin only when the toggle is visible (i.e. not self-edit) AND the
  // value actually changed — avoids no-op audit entries and accidental demotes.
  const adminGroupVisible = document.getElementById('npuIsAdminGroup').style.display !== 'none';
  if (adminGroupVisible) {
    const desired = document.getElementById('npuIsAdmin').checked;
    const current = !!_allProxyUsers.find(u => u.id === _editUserId)?.isAdmin;
    if (desired !== current) {
      if (!desired && !confirm('Remove admin role from this user? They will lose dashboard access.')) return;
      body.isAdmin = desired;
    }
  }
  try {
    const res = await api('/admin/proxy-users/' + _editUserId, { method: 'PUT', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Error'; errEl.style.display = 'block'; return; }
    toast('User updated');
    closeNewProxyUserModal();
    fetchProxyUsers();
  } catch (e) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = 'block'; }
}

async function deleteProxyUserAction(id, username) {
  if (!confirm('Delete user "' + username + '"? This will revoke all profile access.')) return;
  try {
    const res = await api('/admin/proxy-users/' + id, { method: 'DELETE' });
    if (res.ok) { toast('User deleted'); fetchProxyUsers(); } else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function resetProxyUserPw(id) {
  const newPass = prompt('Enter new password (min 6 characters):');
  if (!newPass) return;
  if (newPass.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
  try {
    const res = await api('/admin/proxy-users/' + id, { method: 'PUT', body: JSON.stringify({ password: newPass }) });
    if (res.ok) { toast('Password updated'); } else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function disable2fa(id, username) {
  if (!confirm('Disable 2FA for "' + username + '"?\n\nTheir account will be protected only by password. The user will be notified by email.')) return;
  try {
    const res = await api('/admin/proxy-users/' + id, { method: 'PUT', body: JSON.stringify({ reset2fa: true }) });
    if (res.ok) { toast('2FA disabled — user notified by email'); fetchProxyUsers(); } else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function force2fa(id, username) {
  if (!confirm('Require "' + username + '" to set up 2FA on next login?\n\nIf they already have 2FA, it will be reset and they will be asked to configure it again. The user will be notified by email.')) return;
  try {
    const res = await api('/admin/proxy-users/' + id, { method: 'PUT', body: JSON.stringify({ force2fa: true }) });
    if (res.ok) { toast('User will be required to set up 2FA on next login'); fetchProxyUsers(); } else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// Backwards-compatible alias (in case any inline handler still references it).
async function reset2fa(id, username) { return disable2fa(id, username); }

// ─── Profile ↔ User Association ─────────────────────────────────────────────
let _profileUsersProfile = null;

function openProxyUsersModal(profileName) {
  _profileUsersProfile = profileName;
  document.getElementById('profileUsersTitle').textContent = 'Users — ' + profileName;
  document.getElementById('profileUsersModal').classList.add('active');
  refreshProfileUsers();
}
function closeProfileUsersModal() {
  document.getElementById('profileUsersModal').classList.remove('active');
  _profileUsersProfile = null;
}

async function refreshProfileUsers() {
  if (!_profileUsersProfile) return;
  const body = document.getElementById('pfuListBody');
  body.innerHTML = '<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--text3)">Loading...</td></tr>';
  try {
    const [assignedRes, allRes] = await Promise.all([
      api('/admin/profiles/' + encodeURIComponent(_profileUsersProfile) + '/users'),
      api('/admin/proxy-users'),
    ]);
    if (!assignedRes.ok) {
      const err = await assignedRes.json().catch(() => ({}));
      body.innerHTML = `<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--red)">${esc(err.error || 'Failed to load')}</td></tr>`;
      return;
    }
    const [assignedData, allData] = await Promise.all([
      assignedRes.json(),
      allRes.ok ? allRes.json() : Promise.resolve({ users: _allProxyUsers }),
    ]);
    const assigned = assignedData.users || [];
    const allUsers = allData.users || _allProxyUsers;
    const assignedIds = new Set(assigned.map(u => u.id));

    // Populate the "add" dropdown with unassigned users
    const sel = document.getElementById('pfuAddSelect');
    sel.innerHTML = '<option value="">Select user to add...</option>';
    allUsers.filter(u => !assignedIds.has(u.id)).forEach(u => {
      sel.innerHTML += `<option value="${u.id}">${esc(u.username)}</option>`;
    });

    if (assigned.length === 0) {
      body.innerHTML = '<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--text3)">No users assigned. Use the dropdown above.</td></tr>';
      return;
    }
    body.innerHTML = assigned.map(u => `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px;font-weight:600">${esc(u.username)}</td>
      <td style="padding:8px">${u.totpEnabled ? '<span style="color:var(--green)">Enabled</span>' : '<span style="color:var(--text3)">Off</span>'}</td>
      <td style="padding:8px 12px;text-align:right">
        <button onclick="removeUserFromProfile(${u.id},'${esc(u.username)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--red);font-size:11px" title="Remove access">Remove</button>
      </td>
    </tr>`).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--red)">Error: ' + esc(e.message) + '</td></tr>';
  }
}

async function assignUserToCurrentProfile() {
  if (!_profileUsersProfile) return;
  const sel = document.getElementById('pfuAddSelect');
  const assignBtn = sel.nextElementSibling;
  const userId = parseInt(sel.value, 10);
  if (!userId) { toast('Select a user first', 'error'); return; }
  sel.disabled = true;
  assignBtn.disabled = true;
  assignBtn.textContent = 'Assigning...';
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(_profileUsersProfile) + '/users', {
      method: 'POST', body: JSON.stringify({ userId }),
    });
    if (res.ok) {
      toast('User assigned');
      await refreshProfileUsers();
      fetchProxyUsers();
    } else {
      const d = await res.json();
      toast(d.error || 'Failed', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    sel.disabled = false;
    assignBtn.disabled = false;
    assignBtn.textContent = 'Assign';
  }
}

async function removeUserFromProfile(userId, username) {
  if (!_profileUsersProfile) return;
  if (!confirm('Remove "' + username + '" from this profile?')) return;
  const btn = document.querySelector(`#pfuListBody button[onclick*="removeUserFromProfile(${userId},"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Removing...'; }
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(_profileUsersProfile) + '/users/' + userId, { method: 'DELETE' });
    if (res.ok) { toast('User removed'); await refreshProfileUsers(); fetchProxyUsers(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Remove'; } }
  } catch (e) { toast('Error: ' + e.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Remove'; } }
}

// ─── User ↔ Profile Association (from user side) ─────────────────────────────
let _userProfilesUserId = null;
let _userProfilesUsername = null;

function openUserProfilesModal(userId, username) {
  _userProfilesUserId = userId;
  _userProfilesUsername = username;
  document.getElementById('userProfilesTitle').textContent = 'Proxies — ' + username;
  document.getElementById('userProfilesModal').classList.add('active');
  refreshUserProfiles();
}
function closeUserProfilesModal() {
  document.getElementById('userProfilesModal').classList.remove('active');
  _userProfilesUserId = null;
  _userProfilesUsername = null;
}

async function refreshUserProfiles() {
  if (!_userProfilesUserId) return;
  const body = document.getElementById('upListBody');
  try {
    const [allProfilesRes, allUsersRes] = await Promise.all([
      api('/admin/profiles'),
      api('/admin/proxy-users'),
    ]);
    const allProfiles = allProfilesRes.ok ? (await allProfilesRes.json()).profiles || [] : _allProfiles;
    const allUsers = allUsersRes.ok ? (await allUsersRes.json()).users || [] : _allProxyUsers;
    const user = allUsers.find(u => u.id === _userProfilesUserId);
    const assignedNames = new Set((user?.profiles || []).map(p => p.toLowerCase()));
    const loginProfiles = allProfiles.filter(p => (p.authMode || 'none') === 'login');

    // Dropdown: unassigned login profiles
    const sel = document.getElementById('upAddSelect');
    sel.innerHTML = '<option value="">Select proxy to assign...</option>';
    loginProfiles.filter(p => !assignedNames.has(p.name.toLowerCase())).forEach(p => {
      sel.innerHTML += `<option value="${esc(p.name)}">${esc(p.name)}</option>`;
    });

    const assigned = loginProfiles.filter(p => assignedNames.has(p.name.toLowerCase()));
    if (assigned.length === 0) {
      body.innerHTML = '<tr><td colspan="2" style="padding:20px;text-align:center;color:var(--text3)">No proxies assigned.</td></tr>';
      return;
    }
    body.innerHTML = assigned.map(p => `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px;font-weight:600;font-family:monospace">${esc(p.name)}</td>
      <td style="padding:8px 12px;text-align:right">
        <button onclick="removeProfileFromCurrentUser('${esc(p.name)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--red);font-size:11px">Remove</button>
      </td>
    </tr>`).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="2" style="padding:20px;text-align:center;color:var(--red)">Error: ' + esc(e.message) + '</td></tr>';
  }
}

async function assignProfileToCurrentUser() {
  if (!_userProfilesUserId) return;
  const profileName = document.getElementById('upAddSelect').value;
  if (!profileName) { toast('Select a proxy first', 'error'); return; }
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(profileName) + '/users', {
      method: 'POST', body: JSON.stringify({ userId: _userProfilesUserId }),
    });
    if (res.ok) { toast('Proxy assigned'); refreshUserProfiles(); fetchProxyUsers(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function removeProfileFromCurrentUser(profileName) {
  if (!_userProfilesUserId) return;
  if (!confirm('Remove access to "' + profileName + '"?')) return;
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(profileName) + '/users/' + _userProfilesUserId, { method: 'DELETE' });
    if (res.ok) { toast('Access removed'); refreshUserProfiles(); fetchProxyUsers(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}


// ─── Invite Tokens ──────────────────────────────────────────────────────────

let _lastInviteToken = '';
let _lastInviteIsAdmin = false;
let _lastInviteEmail = '';

function invToggleAll(kind) {
  const rowSel = kind === 'proxy' ? '.inv-proxy-row' : '.inv-oauth-row';
  const visible = Array.from(document.querySelectorAll(rowSel)).filter(el => el.style.display !== 'none');
  const cbs = visible.map(el => el.querySelector('input[type=checkbox]')).filter(Boolean);
  const anyUnchecked = cbs.some(b => !b.checked);
  cbs.forEach(b => { b.checked = anyUnchecked; b.closest('.inv-row')?.classList.toggle('is-selected', b.checked); });
  invUpdateCount(kind);
}

function invFilter(kind) {
  const q = document.getElementById(kind === 'proxy' ? 'invProxySearch' : 'invOauthSearch').value.trim().toLowerCase();
  const rows = document.querySelectorAll(kind === 'proxy' ? '.inv-proxy-row' : '.inv-oauth-row');
  let shown = 0;
  rows.forEach(r => {
    const hay = (r.getAttribute('data-search') || '').toLowerCase();
    const show = !q || hay.includes(q);
    r.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  // Show "no results" hint when filter hides everything
  const listId = kind === 'proxy' ? 'invProxyList' : 'invOauthList';
  const list = document.getElementById(listId);
  let empty = list.querySelector('.inv-picker-empty.is-filter');
  if (rows.length && shown === 0) {
    if (!empty) {
      empty = document.createElement('span');
      empty.className = 'inv-picker-empty is-filter';
      empty.textContent = 'No matches';
      list.appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}

function invUpdateCount(kind) {
  const cbSel = kind === 'proxy' ? '.inv-proxy-cb' : '.inv-oauth-cb';
  const all = document.querySelectorAll(cbSel);
  const checked = document.querySelectorAll(cbSel + ':checked').length;
  const lbl = document.getElementById(kind === 'proxy' ? 'invProxyCount' : 'invOauthCount');
  if (lbl) {
    lbl.textContent = String(checked);
    lbl.classList.toggle('has-selection', checked > 0);
  }
  // Reflect selected state on the row
  document.querySelectorAll(cbSel).forEach(cb => {
    cb.closest('.inv-row')?.classList.toggle('is-selected', cb.checked);
  });
  // Aggregate summary
  const p = document.querySelectorAll('.inv-proxy-cb:checked').length;
  const o = document.querySelectorAll('.inv-oauth-cb:checked').length;
  const sum = document.getElementById('invSelectedSummary');
  if (sum) {
    if (p === 0 && o === 0) {
      sum.textContent = 'Nothing selected';
      sum.style.color = 'var(--text3)';
    } else {
      const parts = [];
      if (p) parts.push(`${p} prox${p === 1 ? 'y' : 'ies'}`);
      if (o) parts.push(`${o} OAuth client${o === 1 ? '' : 's'}`);
      sum.textContent = parts.join(' · ');
      sum.style.color = 'var(--accent)';
    }
  }
}

async function resendInviteEmail() {
  if (!_lastInviteToken) return;
  const btn = document.getElementById('resendInviteBtn');
  const statusEl = document.getElementById('inviteEmailStatus');
  const origHtml = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Sending...';
  try {
    const endpoint = _lastInviteIsAdmin
      ? '/admin/admins/invites/' + encodeURIComponent(_lastInviteToken) + '/resend'
      : '/admin/invites/' + encodeURIComponent(_lastInviteToken) + '/resend';
    const res = await api(endpoint, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      statusEl.textContent = '✔ Email sent to ' + _lastInviteEmail;
      statusEl.style.color = 'var(--ok-text)';
    } else {
      statusEl.textContent = '⚠ ' + (data.error || 'Failed to send email');
      statusEl.style.color = 'var(--err-text)';
    }
  } catch (e) {
    statusEl.textContent = '⚠ ' + e.message;
    statusEl.style.color = 'var(--err-text)';
  } finally {
    btn.disabled = false; btn.innerHTML = origHtml;
  }
}

async function openCreateInviteModal() {
  document.getElementById('inviteGenError').style.display = 'none';
  document.getElementById('inviteGenResult').style.display = 'none';
  document.getElementById('inviteGenForm').style.display = '';
  document.getElementById('inviteGenFooter').innerHTML = '<button class="btn" onclick="closeCreateInviteModal()">Close</button><button class="btn btn-primary" onclick="generateInvite()" id="inviteGenBtn">Generate Link</button>';
  document.getElementById('invEmailInput').value = '';
  document.getElementById('invNameInput').value = '';
  document.getElementById('invNoteInput').value = '';
  document.getElementById('invExpirySelect').value = '48';
  document.getElementById('invAsAdmin').checked = false;
  document.getElementById('invResourcesGroup').style.display = '';
  const ps = document.getElementById('invProxySearch'); if (ps) ps.value = '';
  const os = document.getElementById('invOauthSearch'); if (os) os.value = '';
  const resendBtn = document.getElementById('resendInviteBtn');
  if (resendBtn) resendBtn.style.display = 'none';
  document.getElementById('createInviteModal').classList.add('active');

  const proxyList = document.getElementById('invProxyList');
  const oauthList = document.getElementById('invOauthList');
  proxyList.innerHTML = '<span style="color:var(--text3)">Loading...</span>';
  oauthList.innerHTML = '<span style="color:var(--text3)">Loading...</span>';

  try {
    const [profRes, oauthRes] = await Promise.all([
      api('/admin/profiles'),
      api('/admin/oauth-clients'),
    ]);
    const profiles = profRes.ok ? ((await profRes.json()).profiles || []) : _allProfiles;
    const loginProfiles = profiles.filter(p => (p.authMode || 'none') === 'login');
    if (loginProfiles.length === 0) {
      proxyList.innerHTML = '<span class="inv-picker-empty">No proxy with "login" mode available.</span>';
    } else {
      proxyList.innerHTML = loginProfiles.map(p => {
        const title = p.loginTitle || p.name;
        const search = (title + ' ' + p.name).toLowerCase();
        return `<label class="inv-row inv-proxy-row" data-search="${esc(search)}">
          <input type="checkbox" class="inv-proxy-cb" value="${esc(p.name)}" onchange="invUpdateCount('proxy')">
          <div class="inv-row-main">
            <span class="inv-row-label">${esc(title)}</span>
            <span class="inv-row-sub">${esc(p.name)}</span>
          </div>
        </label>`;
      }).join('');
    }
    const clients = oauthRes.ok ? ((await oauthRes.json()).clients || []) : [];
    if (clients.length === 0) {
      oauthList.innerHTML = '<span class="inv-picker-empty">No OAuth clients configured.</span>';
    } else {
      oauthList.innerHTML = clients.map(c => {
        const label = c.name || c.clientId;
        const search = (label + ' ' + c.clientId).toLowerCase();
        const tag = c.allowListEnabled
          ? '<span class="inv-row-tag is-restricted" title="Allow-list enabled">Restricted</span>'
          : '<span class="inv-row-tag" title="Any authenticated user">Open</span>';
        return `<label class="inv-row inv-oauth-row" data-search="${esc(search)}">
          <input type="checkbox" class="inv-oauth-cb" value="${esc(c.clientId)}" onchange="invUpdateCount('oauth')">
          <div class="inv-row-main">
            <span class="inv-row-label">${esc(label)}</span>
            <span class="inv-row-sub">${esc(c.clientId)}</span>
          </div>
          ${tag}
        </label>`;
      }).join('');
    }
    invUpdateCount('proxy'); invUpdateCount('oauth');
  } catch {
    proxyList.innerHTML = '<span style="color:var(--err-text)">Failed to load proxies.</span>';
    oauthList.innerHTML = '<span style="color:var(--err-text)">Failed to load OAuth clients.</span>';
  }
}

function closeCreateInviteModal() {
  document.getElementById('createInviteModal').classList.remove('active');
}

function toggleInviteType() {
  const asAdmin = document.getElementById('invAsAdmin').checked;
  document.getElementById('invResourcesGroup').style.display = asAdmin ? 'none' : '';
}

async function generateInvite() {
  const errEl = document.getElementById('inviteGenError');
  errEl.style.display = 'none';
  const asAdmin = document.getElementById('invAsAdmin').checked;
  const profileNames = Array.from(document.querySelectorAll('.inv-proxy-cb:checked')).map(el => el.value);
  const oauthClientIds = Array.from(document.querySelectorAll('.inv-oauth-cb:checked')).map(el => el.value);
  if (!asAdmin && profileNames.length === 0 && oauthClientIds.length === 0) {
    errEl.textContent = 'Select at least one proxy or OAuth client (or check "Invite as administrator").';
    errEl.style.display = 'block'; return;
  }
  const email = document.getElementById('invEmailInput').value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Enter a valid email for the invitee.'; errEl.style.display = 'block'; return; }
  const invitedName = document.getElementById('invNameInput').value.trim();
  if (!invitedName) { errEl.textContent = 'Enter the invitee\'s name.'; errEl.style.display = 'block'; return; }
  const note = document.getElementById('invNoteInput').value.trim();
  const expiresInHours = parseInt(document.getElementById('invExpirySelect').value, 10);
  const btn = document.getElementById('inviteGenBtn');
  btn.disabled = true; btn.textContent = 'Generating...';
  try {
    const endpoint = asAdmin ? '/admin/admins/invite' : '/admin/invites';
    const payload = asAdmin
      ? { email, fullName: invitedName, note, expiresInHours }
      : { profileNames, oauthClientIds, email, invitedName, note, expiresInHours };
    const res = await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Failed to generate invite.'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Generate Link'; return; }
    const inviteToken = data.invite?.token || '';
    const link = data.inviteUrl || (window.location.origin + (asAdmin ? '/admin-invite/' : '/invite/') + inviteToken);
    document.getElementById('inviteLinkInput').value = link;
    document.getElementById('inviteGenResult').style.display = 'block';
    document.getElementById('inviteGenForm').style.display = 'none';
    // Stash token + flavor so the "Send by email" button can resend later.
    _lastInviteToken = inviteToken;
    _lastInviteIsAdmin = !!asAdmin;
    _lastInviteEmail = email;
    const statusEl = document.getElementById('inviteEmailStatus');
    const resendBtn = document.getElementById('resendInviteBtn');
    if (statusEl) {
      if (data.emailSent) {
        statusEl.textContent = '✔ Email sent to ' + email;
        statusEl.style.color = 'var(--ok-text)';
        if (resendBtn) { resendBtn.style.display = ''; resendBtn.firstChild.nextSibling.textContent = ' Resend email'; }
      } else if (data.emailError) {
        statusEl.textContent = '⚠ Email not sent: ' + data.emailError;
        statusEl.style.color = 'var(--err-text)';
        if (resendBtn) resendBtn.style.display = '';
      } else {
        statusEl.textContent = 'ℹ SMTP not configured — copy the link below.';
        statusEl.style.color = 'var(--text2)';
        if (resendBtn) resendBtn.style.display = 'none';
      }
    }
    document.getElementById('inviteGenFooter').innerHTML = '<button class="btn" onclick="closeCreateInviteModal()">Close</button><button class="btn btn-primary" onclick="openCreateInviteModal()">Generate Another</button>';
    fetchInvites();
  } catch (e) {
    errEl.textContent = 'Error: ' + e.message; errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Generate Link';
  }
}

function copyInviteLink() {
  const inp = document.getElementById('inviteLinkInput');
  navigator.clipboard.writeText(inp.value).then(() => {
    const btn = document.getElementById('copyInviteBtn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!'; btn.style.background = 'var(--green)';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 2000);
  });
}

async function fetchInvites() {
  try {
    const res = await api('/admin/invites');
    if (!res.ok) return;
    const d = await res.json();
    _allInvites = d.invites || [];
    renderInvites(_allInvites);
  } catch {}
}

function _inviteProfileLabel(name) {
  const profile = _allProfiles.find(p => p.name === name);
  return (profile && (profile.loginTitle || profile.name)) || name;
}

function _inviteOauthLabel(clientId) {
  const client = _allOauthClients.find(c => c.clientId === clientId);
  return (client && client.name) || clientId;
}

function renderInvites(invites) {
  const tbody = document.getElementById('inviteListBody');
  if (!tbody) return;
  const card = document.getElementById('invitesCard');
  const now = new Date();
  const active = invites.filter(i => !i.usedAt && new Date(i.expiresAt) > now);
  if (active.length === 0) {
    if (card) card.style.display = 'none';
    tbody.innerHTML = '';
    return;
  }
  if (card) card.style.display = '';
  invites = active;
  tbody.innerHTML = invites.map(inv => {
    const expires = new Date(inv.expiresAt);
    const expiresAbs = expires.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const expiresRel = _relativeFuture(expires, now);
    const created = inv.createdAt ? new Date(inv.createdAt) : null;
    const createdRel = created ? _relativePast(created, now) : '—';
    const createdAbs = created ? created.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '';

    const profileNames = inv.profileNames && inv.profileNames.length ? inv.profileNames : (inv.profileName ? [inv.profileName] : []);
    const oauthIds = inv.oauthClientIds || [];
    const proxyChips = profileNames.map(p =>
      `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--surface2);border:1px solid var(--border);padding:1px 7px;border-radius:10px;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)">
         <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
         ${esc(_inviteProfileLabel(p))}
       </span>`).join('');
    const oauthChips = oauthIds.map(c =>
      `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--accent-bg);border:1px solid rgba(0,120,212,0.3);color:var(--accent);padding:1px 7px;border-radius:10px;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
         <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
         ${esc(_inviteOauthLabel(c))}
       </span>`).join('');
    const resources = (profileNames.length + oauthIds.length) > 0
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${proxyChips}${oauthChips}</div>`
      : '<span style="color:var(--text3)">—</span>';

    const nameEmail = inv.invitedName
      ? `<div style="font-weight:600;font-size:13px;color:var(--text)">${esc(inv.invitedName)}</div><div style="font-size:11px;color:var(--text3)">${esc(inv.email || '—')}</div>`
      : `<div style="font-size:13px;color:var(--text2)">${esc(inv.email) || '<span style="color:var(--text3)">—</span>'}</div>`;

    const copyBtn = `<button onclick="copyTokenLink('${esc(inv.token)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--text2);font-size:11px;margin-right:4px" title="Copy invite link">Copy</button>`;
    const resendBtn = inv.email
      ? `<button onclick="resendInviteFromList('${esc(inv.token)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--accent);font-size:11px;margin-right:4px" title="Resend invite by email">Email</button>`
      : '';
    const revokeBtn = `<button onclick="revokeInvite('${esc(inv.token)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--red);font-size:11px" title="Revoke">Revoke</button>`;

    return `<tr style="border-bottom:1px solid var(--border);transition:background .15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
      <td style="padding:8px 12px">${nameEmail}</td>
      <td style="padding:8px">${resources}</td>
      <td style="padding:8px;font-size:12px" title="${esc(expiresAbs)}"><span style="color:var(--text)">${esc(expiresRel)}</span></td>
      <td style="padding:8px;font-size:12px;color:var(--text3)" title="${esc(createdAbs)}">${esc(createdRel)}</td>
      <td style="padding:8px 12px;text-align:right;white-space:nowrap">${copyBtn}${resendBtn}${revokeBtn}</td>
    </tr>`;
  }).join('');
}

function _relativeFuture(date, now) {
  const ms = date.getTime() - now.getTime();
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'in 1 day' : `in ${d} days`;
}
function _relativePast(date, now) {
  const ms = now.getTime() - date.getTime();
  if (ms < 60000) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

async function resendInviteFromList(token) {
  try {
    const res = await api('/admin/invites/' + encodeURIComponent(token) + '/resend', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) toast('Invite email sent');
    else toast(data.error || 'Failed to send email', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function copyTokenLink(token) {
  const link = window.location.origin + '/invite/' + token;
  navigator.clipboard.writeText(link).then(() => toast('Link copiado!'));
}

async function revokeInvite(token) {
  if (!confirm('Revoke this invite? The link will stop working.')) return;
  try {
    const res = await api('/admin/invites/' + token, { method: 'DELETE' });
    if (res.ok) { toast('Invite revoked'); fetchInvites(); }
    else { const d = await res.json(); toast(d.error || 'Error', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── Targets (deprecated — removed) ─────────────────────────────────────────
let _allTargets = [];
function fetchTargets() { _allTargets = []; }
function filterTargets() {}
function renderTargets() {}
function openTargetModal() {}
function closeTargetModal() {}
function saveTarget() {}
function editTarget() {}
function deleteTarget() {}
function restartTargetAction() {}
function copyTargetCredential() {}


// ─── Webhooks CRUD ───────────────────────────────────────────────────────────
let _allWebhooks = [];
let _dlqByWebhook = {}; // { [webhookName]: count }
let editingWebhook = null;

async function fetchWebhooks() {
  try {
    const [wRes, dlqRes] = await Promise.all([api('/admin/webhooks'), api('/admin/webhooks/dlq')]);
    if (!wRes.ok) return;
    const d = await wRes.json();
    _allWebhooks = d.webhooks || [];

    if (dlqRes.ok) {
      const dlqData = await dlqRes.json();
      _dlqByWebhook = {};
      for (const e of (dlqData.queue || [])) {
        _dlqByWebhook[e.webhookName] = (_dlqByWebhook[e.webhookName] || 0) + 1;
      }
    }

    filterWebhooks();
    document.getElementById('navWebhookBadge').textContent = _allWebhooks.length;
  } catch { }
}

function filterWebhooks() {
  const search = (document.getElementById('webhookSearch')?.value || '').toLowerCase();
  const filtered = _allWebhooks.filter(w => {
    if (search && !w.name.toLowerCase().includes(search)) return false;
    return true;
  });
  renderWebhooks(filtered);
}

function renderWebhooks(webhooks) {
  const c = document.getElementById('webhookListBody');
  if (webhooks.length === 0) { c.innerHTML = '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text3)">No webhooks yet. Click "+ New Webhook".</td></tr>'; return; }
  c.innerHTML = webhooks.map(w => {
    const statusBadge = w.running
      ? '<span style="background:var(--green-bg);color:var(--green);padding:2px 8px;border-radius:4px;font-size:11px">Running</span>'
      : '<span style="background:var(--red-bg);color:var(--red);padding:2px 8px;border-radius:4px;font-size:11px">Stopped</span>';
    const authBadge = w.hasAuth
      ? '<span style="color:var(--green)">Enabled</span>'
      : '<span style="color:var(--text3)">Public</span>';
    const wIpBadge = (w.allowedIps && w.allowedIps.length)
      ? `<span style="background:var(--surface2);color:var(--text2);padding:2px 6px;border-radius:4px;font-size:11px;margin-left:4px" title="${esc(w.allowedIps.join(', '))}">IP restricted</span>`
      : '';
    const numTargets = w.targets.length;
    const dlqCount = _dlqByWebhook[w.name] || 0;
    const dlqDot = dlqCount > 0
      ? `<span style="position:absolute;top:2px;right:2px;width:7px;height:7px;background:var(--red);border-radius:50%;display:block" title="${dlqCount} failed deliveries"></span>`
      : '';
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
  <td style="padding:8px 12px;font-weight:600">${esc(w.name)}</td>
  <td style="padding:8px">${statusBadge}</td>
  <td style="padding:8px;font-family:'SF Mono',Monaco,monospace;color:var(--accent2)">${w.port}</td>
  <td style="padding:8px;color:var(--text2)">${numTargets} destinations</td>
  <td style="padding:8px">${authBadge}${wIpBadge}</td>
  <td style="padding:8px;color:var(--accent2)">${w.active > 0 ? w.active : '<span style="color:var(--text3)">0</span>'}</td>
  <td style="padding:8px 12px;text-align:right">
    <span style="position:relative;display:inline-block">
      <button data-type="webhook" data-name="${esc(w.name)}" onclick="showContextMenu(event,this)" style="background:none;border:1px solid var(--border);border-radius:6px;padding:2px 10px;cursor:pointer;color:var(--text2);font-size:18px;line-height:1.2;letter-spacing:1px" title="Actions">&#8942;</button>
      ${dlqDot}
    </span>
  </td>
</tr>`;
  }).join('');
}

// ─── DLQ Modal ───────────────────────────────────────────────────────────────
let _dlqModalWebhook = null;
let _dlqEntries = [];

async function openDlqModal(webhookName) {
  _dlqModalWebhook = webhookName;
  const modal = document.getElementById('dlqModal');
  document.getElementById('dlqModalTitle').textContent = `Failed Deliveries — ${webhookName}`;
  modal.style.display = 'block';
  await refreshDlqModal();
}

function closeDlqModal() {
  document.getElementById('dlqModal').style.display = 'none';
  _dlqModalWebhook = null;
  _dlqEntries = [];
}

async function refreshDlqModal() {
  try {
    const url = '/admin/webhooks/dlq' + (_dlqModalWebhook ? '?webhook=' + encodeURIComponent(_dlqModalWebhook) : '');
    const res = await api(url);
    const d = await res.json();
    _dlqEntries = d.queue || [];
    renderDlqEntries();
  } catch (e) { toast('Error loading DLQ: ' + e.message, 'error'); }
}

function renderDlqEntries() {
  const c = document.getElementById('dlqList');
  if (_dlqEntries.length === 0) {
    c.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3)">No failed deliveries.</div>';
    document.getElementById('dlqRetryAllBtn').style.display = 'none';
    return;
  }
  document.getElementById('dlqRetryAllBtn').style.display = '';
  c.innerHTML = _dlqEntries.map(e => `
    <div id="dlq-${esc(e.id)}" style="border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:8px;background:var(--surface2)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-family:'SF Mono',Monaco,monospace;font-size:12px;color:var(--accent2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.targetUrl)}">${esc(e.method)} ${esc(e.targetUrl)}</span>
        <span style="font-size:11px;color:var(--text3);white-space:nowrap">${new Date(e.failedAt).toLocaleString()}</span>
      </div>
      <div style="margin-top:4px;font-size:11px;color:var(--red)">${esc(e.lastError)}</div>
      <div style="margin-top:2px;font-size:11px;color:var(--text3)">${e.totalAttempts} attempt(s) &middot; req: ${esc(e.requestId.slice(0,8))}...</div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn btn-sm" onclick="dlqRetryOne('${esc(e.id)}')" ${e.retrying ? 'disabled' : ''}>${e.retrying ? 'Retrying…' : 'Retry'}</button>
        <button class="btn btn-sm btn-danger" onclick="dlqDismissOne('${esc(e.id)}')">Dismiss</button>
      </div>
    </div>`).join('');
}

async function dlqRetryAll() {
  document.getElementById('dlqRetryAllBtn').disabled = true;
  try {
    const body = _dlqModalWebhook ? { webhook: _dlqModalWebhook } : {};
    const res = await api('/admin/webhooks/dlq/retry-all', { method: 'POST', body: JSON.stringify(body) });
    const d = await res.json();
    toast(`Retried ${d.retried}: ${d.succeeded} succeeded, ${d.failed} failed`);
    await refreshDlqModal();
    await fetchWebhooks();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  document.getElementById('dlqRetryAllBtn').disabled = false;
}

async function dlqRetryOne(id) {
  const entry = _dlqEntries.find(e => e.id === id);
  if (entry) entry.retrying = true;
  renderDlqEntries();
  try {
    const res = await api(`/admin/webhooks/dlq/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    const d = await res.json();
    if (res.ok) toast('Delivery succeeded');
    else toast('Retry failed: ' + (d.error || d.lastError || res.status), 'error');
    await refreshDlqModal();
    await fetchWebhooks();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function dlqDismissOne(id) {
  try {
    const res = await api(`/admin/webhooks/dlq/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) { await refreshDlqModal(); await fetchWebhooks(); }
    else toast('Dismiss failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function viewWebhookLogs(name) {
  document.getElementById('rlType').value = 'webhook';
  document.getElementById('rlSearch').value = name;
  rlPage = 1;
  navigate('requests');
  fetchRequestLogs();
}

let webhookTargetState = [];
let showTestPayload = false;

function toggleTestPayload() {
    showTestPayload = !showTestPayload;
    const container = document.getElementById('wTestPayloadContainer');
    if (container) {
        container.style.display = showTestPayload ? 'block' : 'none';
    }
    updateAllPreviews();
}

function renderTemplateJS(template, data) {
    if (!data || !template) return template || '';
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, path) => {
        let val = data;
        for (const k of path.split('.')) {
            if (val === undefined || val === null) break;
            val = val[k];
        }
        if (val === undefined || val === null) return '';
        return typeof val === 'object' ? JSON.stringify(val) : String(val);
    });
}

let aceEditors = {};

function getAceTheme() {
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    return theme === 'dark' ? 'ace/theme/twilight' : 'ace/theme/chrome';
}

function updateAceThemes() {
    if (typeof ace === 'undefined') return;
    const theme = getAceTheme();
    Object.values(aceEditors).forEach(e => e.setTheme(theme));
    if (fullEditor) fullEditor.setTheme(theme);
}

function initAceEditors() {
    if (typeof ace === 'undefined') return;
    Object.values(aceEditors).forEach(e => { try { e.destroy(); } catch {} });
    aceEditors = {};
    
    webhookTargetState.forEach((t, i) => {
        if (t.type !== 'custom') return;
        const el = document.getElementById(`aceBody_${i}`);
        if (!el) return;
        
        const editor = ace.edit(el, {
            mode: 'ace/mode/json',
            theme: getAceTheme(),
            value: t.bodyTemplate || '',
            fontSize: 12,
            fontFamily: "'Consolas','Monaco','Courier New',monospace",
            showPrintMargin: false,
            maxLines: 20,
            minLines: 3,
            wrap: true,
            tabSize: 2,
            useWorker: false,
            highlightActiveLine: true,
            showGutter: true,
            placeholder: '{"event": "{{event.type}}", "id": "{{data.id}}"}'
        });
        
        editor.on('change', () => {
            webhookTargetState[i].bodyTemplate = editor.getValue();
            updateAllPreviews();
        });
        
        aceEditors[i] = editor;
    });
}

let fullEditor = null;
let currentFullEditorIndex = -1;

function openBodyEditor(index) {
    currentFullEditorIndex = index;
    const content = webhookTargetState[index].bodyTemplate || '';
    
    document.getElementById('bodyEditorModal').style.display = 'block';
    
    if (!fullEditor) {
        fullEditor = ace.edit('aceBodyFull', {
            mode: 'ace/mode/json',
            theme: getAceTheme(),
            fontSize: 14,
            fontFamily: "'Consolas','Monaco','Courier New',monospace",
            showPrintMargin: false,
            wrap: true,
            tabSize: 2,
            useWorker: false,
            highlightActiveLine: true,
            showGutter: true
        });
    }
    
    fullEditor.setValue(content, -1);
    fullEditor.focus();
}

function closeBodyEditor() {
    document.getElementById('bodyEditorModal').style.display = 'none';
    currentFullEditorIndex = -1;
}

function saveBodyEditor() {
    if (currentFullEditorIndex === -1) return;
    const content = fullEditor.getValue();
    webhookTargetState[currentFullEditorIndex].bodyTemplate = content;
    
    // Sync back to small editor
    if (aceEditors[currentFullEditorIndex]) {
        aceEditors[currentFullEditorIndex].setValue(content, -1);
    }
    
    updateAllPreviews();
    closeBodyEditor();
}

function updateAllPreviews() {
  const jsonStr = document.getElementById('wTestPayload').value.trim();
  let payloadObj = null;
  const tpEl = document.getElementById('wTestPayload');
  
  if (showTestPayload && jsonStr) {
    try { payloadObj = JSON.parse(jsonStr); tpEl.style.borderColor = 'var(--accent)'; }
    catch { tpEl.style.borderColor = 'var(--red)'; }
  } else {
    tpEl.style.borderColor = 'var(--border)';
  }

  webhookTargetState.forEach((t, i) => {
    const pUrl = document.getElementById(`previewUrl_${i}`);
    if (pUrl) {
        if (showTestPayload && payloadObj) {
            pUrl.textContent = 'Evaluates to: ' + renderTemplateJS(t.url, payloadObj);
            pUrl.style.display = 'block';
        } else {
            pUrl.style.display = 'none';
        }
    }
    
    if (t.type === 'custom') {
      (t.customHeaders || []).forEach((h, hIndex) => {
          const ph = document.getElementById(`previewHeader_${i}_${hIndex}`);
          if (ph) {
              if (showTestPayload && payloadObj && h.value) {
                  ph.textContent = '= ' + renderTemplateJS(h.value, payloadObj);
                  ph.style.display = 'inline-block';
              } else {
                  ph.style.display = 'none';
              }
          }
      });
      
      const pBody = document.getElementById(`previewBody_${i}`);
      if (pBody) {
          if (showTestPayload && payloadObj) {
              let outBody = renderTemplateJS(t.bodyTemplate, payloadObj);
              if (!outBody.trim()) {
                  pBody.textContent = 'Evaluates to: (Original Payload Placeholder)';
              } else {
                  try { outBody = JSON.stringify(JSON.parse(outBody), null, 2); } catch {}
                  pBody.textContent = 'Evaluates to:\n' + outBody;
              }
              pBody.style.display = 'block';
          } else {
              pBody.style.display = 'none';
          }
      }
    }
  });
}

async function fetchRecentWebhookPayload() {
    try {
        let url = '/admin/requests?type=webhook&limit=1';
        if (editingWebhook && editingWebhook.name) {
            url += '&target=' + encodeURIComponent(editingWebhook.name);
        }
        const res = await api(url);
        if (!res.ok) return toast('Could not fetch recent payload', 'error');
        const d = await res.json();
        if (d.requests && d.requests.length > 0 && d.requests[0].reqBody) {
            let bd = d.requests[0].reqBody;
            try { bd = JSON.stringify(JSON.parse(bd), null, 2); } catch {}
            document.getElementById('wTestPayload').value = bd;
            if (!showTestPayload) toggleTestPayload();
            else updateAllPreviews();
            toast('Loaded payload from recent request');
        } else {
            toast('No recent webhook payload found', 'warning');
        }
    } catch { toast('Error fetching payload', 'error'); }
}

function toggleRetrySection() {
  const enabled = document.getElementById('wRetryEnabled').checked;
  document.getElementById('wRetrySection').style.display = enabled ? 'flex' : 'none';
  // hide/show per-destination retry overrides
  document.querySelectorAll('.destination-retry-override').forEach(el => {
    el.style.display = enabled ? 'none' : '';
  });
}

function addWebhookTarget(target = "") {
  if (typeof target === 'string') {
    webhookTargetState.push({ type: 'basic', url: target, method: 'POST', bodyTemplate: '', customBody: false, customHeaders: [], forwardHeaders: false, retry: null, retryOpen: false });
  } else {
    const headersArr = [];
    if (target.customHeaders) {
        for (const [k, v] of Object.entries(target.customHeaders)) {
            headersArr.push({ key: k, value: v });
        }
    }
    webhookTargetState.push({
      type: 'custom',
      url: target.url || '',
      method: target.method || 'POST',
      bodyTemplate: target.bodyTemplate || '',
      customBody: !!target.bodyTemplate,
      customHeaders: headersArr,
      forwardHeaders: target.forwardHeaders === true,
      retry: target.retry || null,
      retryOpen: !!target.retry,
    });
  }
  renderWebhookTargets();
}

function toggleTargetRetry(index) {
  const t = webhookTargetState[index];
  t.retryOpen = !t.retryOpen;
  if (t.retryOpen && !t.retry) {
    t.retry = { maxRetries: 3, retryDelayMs: 1000, backoff: 'exponential', retryUntilSuccess: false };
  }
  renderWebhookTargets();
}

function updateTargetRetry(index, field, value) {
  if (!webhookTargetState[index].retry) return;
  webhookTargetState[index].retry[field] = value;
}

function removeWebhookTarget(index) {
  webhookTargetState.splice(index, 1);
  renderWebhookTargets();
}

function toggleWebhookTargetType(index) {
  const t = webhookTargetState[index];
  t.type = t.type === 'basic' ? 'custom' : 'basic';
  renderWebhookTargets();
}

function updateWebhookTargetField(index, field, value) {
  webhookTargetState[index][field] = value;
  updateAllPreviews();
}

function addWebhookTargetHeader(index) {
  webhookTargetState[index].customHeaders.push({ key: '', value: '' });
  renderWebhookTargets();
}

function removeWebhookTargetHeader(index, hIndex) {
  webhookTargetState[index].customHeaders.splice(hIndex, 1);
  renderWebhookTargets();
}

function updateWebhookTargetHeader(index, hIndex, field, val) {
  webhookTargetState[index].customHeaders[hIndex][field] = val;
  updateAllPreviews();
}

function renderWebhookTargets() {
  const container = document.getElementById('wDestinationsContainer');
  if (webhookTargetState.length === 0) {
    container.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:12px">No actions added. Click "+ Add Action" above.</div>';
    return;
  }
  
  container.innerHTML = webhookTargetState.map((t, i) => {
    const headersHtml = (t.customHeaders || []).map((h, hIndex) => `
      <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px">
          <div style="display:flex;gap:4px">
            <input type="text" placeholder="Key" value="${esc(h.key)}" oninput="updateWebhookTargetHeader(${i}, ${hIndex}, 'key', this.value)" style="flex:1;padding:4px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:11px;outline:none">
            <input type="text" placeholder="Value (Template Allowed)" value="${esc(h.value)}" oninput="updateWebhookTargetHeader(${i}, ${hIndex}, 'value', this.value)" style="flex:2;padding:4px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:11px;outline:none">
            <button onclick="removeWebhookTargetHeader(${i}, ${hIndex})" tabindex="-1" style="background:none;border:none;color:var(--red);cursor:pointer;padding:0 4px" title="Remove Header">&times;</button>
          </div>
          <div id="previewHeader_${i}_${hIndex}" style="display:none;font-size:10px;color:var(--accent);margin-left:5px"></div>
      </div>
    `).join('');

    return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;position:relative;padding:10px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <select onchange="toggleWebhookTargetType(${i})" style="padding:4px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);font-size:12px;color:var(--text);outline:none">
          <option value="basic" ${t.type === 'basic' ? 'selected' : ''}>Basic Forward</option>
          <option value="custom" ${t.type === 'custom' ? 'selected' : ''}>Custom Action</option>
        </select>
        <button onclick="removeWebhookTarget(${i})" style="margin-left:auto;background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;line-height:1" title="Remove Target">&times;</button>
      </div>
      
      <div style="display:flex;flex-direction:column;gap:6px">
        <div>
           <input type="text" placeholder="Target URL (e.g. https://api.com/user/{{user.id}})" value="${esc(t.url)}" oninput="updateWebhookTargetField(${i}, 'url', this.value)" style="width:100%;padding:6px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:12px;outline:none">
           <div id="previewUrl_${i}" style="display:none;font-size:10px;color:var(--accent);margin-top:2px;margin-left:4px"></div>
        </div>
        
        ${t.type === 'custom' ? `
          <div style="display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;align-items:center;gap:6px">
              <select onchange="updateWebhookTargetField(${i}, 'method', this.value)" style="padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:11px;outline:none">
                <option value="POST" ${t.method === 'POST' ? 'selected' : ''}>POST</option>
                <option value="PUT" ${t.method === 'PUT' ? 'selected' : ''}>PUT</option>
                <option value="GET" ${t.method === 'GET' ? 'selected' : ''}>GET</option>
                <option value="DELETE" ${t.method === 'DELETE' ? 'selected' : ''}>DELETE</option>
              </select>
              <label style="font-size:11px;color:var(--text);display:flex;align-items:center;gap:4px;margin-left:auto;cursor:pointer">
                <input type="checkbox" ${t.forwardHeaders ? 'checked' : ''} onchange="updateWebhookTargetField(${i}, 'forwardHeaders', this.checked)"> Forward incoming headers
              </label>
            </div>
            
            <div style="border:1px solid var(--border);border-radius:4px;padding:6px;background:var(--surface)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <span style="font-size:11px;color:var(--text2)">Custom Headers</span>
                <button onclick="addWebhookTargetHeader(${i})" class="btn" style="padding:2px 6px;font-size:10px">+ Add Header</button>
              </div>
              ${headersHtml}
            </div>

            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;user-select:none">
                <input type="checkbox" ${t.customBody ? 'checked' : ''} onchange="updateWebhookTargetField(${i}, 'customBody', this.checked); renderWebhookTargets()" style="cursor:pointer;accent-color:var(--accent)">
                <span style="font-weight:600">Custom Body</span>
                <span style="color:var(--text3);font-weight:400">— leave unchecked to forward the incoming body as-is</span>
              </label>
              ${t.customBody ? `
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;margin-top:2px">
                <span style="font-size:11px;color:var(--text2)">Body Template (JSON)</span>
                <button onclick="openBodyEditor(${i})" class="btn" style="padding:2px 6px;font-size:10px;display:flex;align-items:center;gap:4px">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
                  Expand
                </button>
              </div>
              <div id="aceBody_${i}" style="width:100%; min-height:100px; border-radius:4px; border:1px solid var(--border);"></div>
              <div style="font-size:10px;color:var(--text3);margin-top:3px;margin-left:2px">Supports JSON + <code style="background:rgba(0,120,212,0.15);padding:1px 4px;border-radius:3px;color:var(--accent);font-size:10px">{{template.vars}}</code></div>
              <div id="previewBody_${i}" style="display:none;font-size:10px;color:var(--accent);margin-top:2px;margin-left:4px;white-space:pre-wrap;font-family:monospace"></div>
              ` : `<div id="aceBody_${i}" style="display:none"></div><div id="previewBody_${i}" style="display:none"></div>`}
            </div>
          </div>
        ` : ''}

        <!-- Per-destination retry override -->
        <div class="destination-retry-override" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;${document.getElementById('wRetryEnabled')?.checked ? 'display:none' : ''}">
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);cursor:pointer" onclick="toggleTargetRetry(${i});return false">
            <input type="checkbox" ${t.retryOpen ? 'checked' : ''} onclick="event.preventDefault()">
            Override retry for this destination
          </label>
          ${t.retryOpen ? `
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;padding:8px;background:var(--surface2);border-radius:4px;border:1px solid var(--border)">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
              <div>
                <label style="font-size:10px;color:var(--text3);display:block;margin-bottom:2px">Max retries${t.retry?.retryUntilSuccess ? ' <span style="color:var(--orange);font-size:10px">(hard cap)</span>' : ''}</label>
                <input type="number" min="1" max="20" value="${t.retry?.maxRetries ?? 3}" oninput="updateTargetRetry(${i},'maxRetries',+this.value)" style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11px;outline:none">
              </div>
              <div>
                <label style="font-size:10px;color:var(--text3);display:block;margin-bottom:2px">Initial delay (ms)</label>
                <input type="number" min="100" max="60000" step="100" value="${t.retry?.retryDelayMs ?? 1000}" oninput="updateTargetRetry(${i},'retryDelayMs',+this.value)" style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11px;outline:none">
              </div>
              <div>
                <label style="font-size:10px;color:var(--text3);display:block;margin-bottom:2px">Backoff</label>
                <select oninput="updateTargetRetry(${i},'backoff',this.value)" style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11px;outline:none">
                  <option value="exponential" ${(t.retry?.backoff ?? 'exponential') === 'exponential' ? 'selected' : ''}>Exponential</option>
                  <option value="fixed" ${t.retry?.backoff === 'fixed' ? 'selected' : ''}>Fixed</option>
                </select>
              </div>
            </div>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
              <input type="checkbox" ${t.retry?.retryUntilSuccess ? 'checked' : ''} onchange="updateTargetRetry(${i},'retryUntilSuccess',this.checked);document.getElementById('tRetryOnRow_${i}').style.display=this.checked?'none':'flex';renderWebhookTargets()">
              <strong>Retry until success (2xx)</strong>
            </label>
            <div id="tRetryOnRow_${i}" style="display:${t.retry?.retryUntilSuccess ? 'none' : 'flex'};align-items:center;gap:6px">
              <label style="font-size:10px;color:var(--text3);white-space:nowrap">Retry on codes</label>
              <input type="text" value="${(t.retry?.retryOn ?? [429,502,503,504]).join(', ')}" placeholder="429, 502, 503, 504"
                oninput="updateTargetRetry(${i},'retryOn',this.value.split(',').map(s=>parseInt(s.trim())).filter(n=>n>0))"
                style="flex:1;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11px;outline:none">
            </div>
          </div>` : ''}
        </div>
      </div>
    </div>
  `}).join('');

  initAceEditors();
  updateAllPreviews();
}

function openWebhookModal(webhook = null) {
  editingWebhook = webhook;
  document.getElementById('webhookModalTitle').textContent = webhook ? 'Edit Webhook Distributor' : 'New Webhook Distributor';
  document.getElementById('wName').value = webhook ? webhook.name : ''; document.getElementById('wName').disabled = !!webhook;
  document.getElementById('wPort').value = webhook ? webhook.port : '';
  
  webhookTargetState = [];
  if (webhook && webhook.targets && webhook.targets.length > 0) {
      webhook.targets.forEach(t => addWebhookTarget(t));
  } else {
      addWebhookTarget(''); // one empty default
  }
  
  document.getElementById('wAuthToken').value = webhook ? (webhook.authToken || '') : '';
  IpTagInput.setValue('wAllowedIps', webhook?.allowedIps || []);

  // Populate retry config
  const r = webhook?.retry;
  const retryEnabled = !!r;
  document.getElementById('wRetryEnabled').checked = retryEnabled;
  document.getElementById('wRetrySection').style.display = retryEnabled ? 'flex' : 'none';
  document.getElementById('wRetryMax').value = r?.maxRetries ?? 3;
  document.getElementById('wRetryDelay').value = r?.retryDelayMs ?? 1000;
  document.getElementById('wRetryBackoff').value = r?.backoff ?? 'exponential';
  document.getElementById('wRetryUntilSuccess').checked = !!r?.retryUntilSuccess;
  document.getElementById('wRetryOn').value = (r?.retryOn ?? [429, 502, 503, 504]).join(', ');
  document.getElementById('wRetryOnRow').style.display = r?.retryUntilSuccess ? 'none' : 'flex';

  document.getElementById('webhookModal').style.display = 'flex';
}

function closeWebhookModal() { document.getElementById('webhookModal').style.display = 'none'; editingWebhook = null; }

async function saveWebhook() {
  const targetsRaw = [];
  for (const t of webhookTargetState) {
      if (!t.url.trim()) continue;
      if (t.type === 'basic') {
          targetsRaw.push(t.url.trim());
      } else {
          let headersObj = undefined;
          if (t.customHeaders && t.customHeaders.length > 0) {
              headersObj = {};
              for (const h of t.customHeaders) {
                  if (h.key.trim()) headersObj[h.key.trim()] = h.value.trim();
              }
              if (Object.keys(headersObj).length === 0) headersObj = undefined;
          }
          const dest = {
              url: t.url.trim(),
              method: t.method || 'POST',
              customHeaders: headersObj,
              forwardHeaders: t.forwardHeaders,
              bodyTemplate: (t.customBody && t.bodyTemplate.trim()) ? t.bodyTemplate.trim() : undefined
          };
          if (t.retryOpen && t.retry) dest.retry = t.retry;
          targetsRaw.push(dest);
      }
  }

  const wName = document.getElementById('wName').value.trim();
  if (!wName) return toast('Name is required', 'error');
  if (!/^[a-z0-9_-]+$/.test(wName)) return toast('Name may only contain lowercase letters, numbers, hyphens and underscores — no spaces', 'error');
  if (wName.length < 2 || wName.length > 48) return toast('Name must be between 2 and 48 characters', 'error');

  const body = {
    name: wName,
    port: parseInt(document.getElementById('wPort').value) || 0,
    targets: targetsRaw
  };
  if (targetsRaw.length === 0) return toast('At least one valid destination is required', 'error');
  const at = document.getElementById('wAuthToken').value.trim(); if (at) body.authToken = at;
  const wIps = IpTagInput.getValue('wAllowedIps'); if (wIps.length) body.allowedIps = wIps;

  if (document.getElementById('wRetryEnabled').checked) {
    const retryUntilSuccess = document.getElementById('wRetryUntilSuccess').checked;
    body.retry = {
      maxRetries: parseInt(document.getElementById('wRetryMax').value) || 3,
      retryDelayMs: parseInt(document.getElementById('wRetryDelay').value) || 1000,
      backoff: document.getElementById('wRetryBackoff').value,
      retryUntilSuccess,
      retryOn: retryUntilSuccess ? undefined : document.getElementById('wRetryOn').value
        .split(',').map(s => parseInt(s.trim())).filter(n => n > 0),
    };
  }
  try {
    const res = await api('/admin/webhooks', { method: 'POST', body: JSON.stringify(body) }); const d = await res.json();
    if (res.ok) { toast('Webhook ' + (d.status || 'saved')); closeWebhookModal(); await fetchWebhooks(); } else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function editWebhook(name) {
  try { const res = await api('/admin/webhooks/' + encodeURIComponent(name)); if (!res.ok) return toast('Not found', 'error'); openWebhookModal((await res.json()).webhook); } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteWebhook(name) {
  if (!confirm('Delete webhook "' + name + '"?')) return;
  try { const res = await api('/admin/webhooks/' + encodeURIComponent(name), { method: 'DELETE' }); if (res.ok) { toast('Deleted'); await fetchWebhooks(); } } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function restartWebhookAction(name) {
  const btn = event?.target;
  const originalText = btn ? btn.textContent : 'Restart';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Restarting...';
  }
  
  try { 
    const res = await api('/admin/webhooks/' + encodeURIComponent(name) + '/restart', { method: 'POST' }); 
    const data = await res.json();
    if (data.status) { 
      toast('Restarted "' + name + '"'); 
      // Wait a bit for the server to actually be ready
      await new Promise(r => setTimeout(r, 1000));
      await fetchWebhooks(); 
    } else {
      toast(data.error || 'Failed to restart', 'error');
    }
  } catch (e) { 
    toast('Error: ' + e.message, 'error'); 
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

// ─── Request Log ─────────────────────────────────────────────────────────────
let rlPage = 1; const rlLimit = 50; let rlData = null;
async function fetchRequestLogs() {
  try {
    const params = new URLSearchParams({ page: rlPage, limit: rlLimit });
    const type = document.getElementById('rlType').value;
    const method = document.getElementById('rlMethod').value;
    const status = document.getElementById('rlStatus').value;
    const search = document.getElementById('rlSearch').value.trim();
    if (type) params.set('type', type); if (method) params.set('method', method);
    if (status) params.set('status', status); if (search) params.set('search', search);
    const res = await api('/admin/requests?' + params.toString()); if (!res.ok) return;
    rlData = await res.json(); renderRequestLogs();
    const sres = await api('/admin/requests/stats'); if (sres.ok) {
      const s = await sres.json();
      document.getElementById('reqLogStats').textContent = s.total + ' total | ' + (s.dbSizeMB || 0) + ' MB';
      document.getElementById('navReqBadge').textContent = fmtNum(s.total);
    }
  } catch { }
}
function renderRequestLogs() {
  if (!rlData) return;
  const { requests, total, page, totalPages } = rlData;
  const tbody = document.getElementById('reqLogBody');
  if (requests.length === 0) { tbody.innerHTML = '<tr><td colspan="8" style="padding:40px;text-align:center;color:var(--text3)">No requests found.</td></tr>'; }
  else {
    tbody.innerHTML = requests.map(r => {
      const ts = new Date(r.timestamp + 'Z'); const sc = r.resStatus;
      const statusCls = !sc ? 'color:var(--text3)' : sc < 300 ? 'color:var(--green)' : sc < 400 ? 'color:var(--blue)' : sc < 500 ? 'color:var(--orange)' : 'color:var(--red)';
      const typeBadge = r.type === 'proxy'
        ? '<span class="rdm-badge" style="background:var(--accent-bg);color:var(--accent2);padding:2px 8px;border-radius:4px;font-size:11px">proxy' + (r.profileName ? ' / ' + esc(r.profileName) : '') + '</span>'
        : r.type === 'webhook'
        ? '<span class="rdm-badge" style="background:var(--orange-bg);color:var(--orange);padding:2px 8px;border-radius:4px;font-size:11px">webhook' + (r.targetName ? ' / ' + esc(r.targetName) : '') + '</span>'
        : '<span class="rdm-badge" style="background:var(--blue-bg);color:var(--blue);padding:2px 8px;border-radius:4px;font-size:11px">target' + (r.targetName ? ' / ' + esc(r.targetName) : '') + '</span>';
      const methodCls = r.method === 'GET' ? 'color:var(--green)' : r.method === 'POST' ? 'color:var(--blue)' : r.method === 'DELETE' ? 'color:var(--red)' : 'color:var(--orange)';
      const sz = (r.reqBodySize || 0) + (r.resBodySize || 0);
      return `<tr style="border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''" onclick="openReqDetail(${r.id})">
  <td style="padding:8px 12px;white-space:nowrap;color:var(--text2);font-size:12px">${esc(ts.toLocaleString())}</td>
  <td style="padding:8px">${typeBadge}</td>
  <td style="padding:8px;font-weight:600;${methodCls}">${esc(r.method)}</td>
  <td style="padding:8px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.path)}">${esc(r.path)}</td>
  <td style="padding:8px;font-weight:600;${statusCls}">${sc || (r.error ? 'ERR' : '-')}</td>
  <td style="padding:8px;color:var(--text2)">${r.durationMs ? fmtMs(r.durationMs) : '-'}</td>
  <td style="padding:8px;color:var(--text3);font-size:12px">${sz > 0 ? fmtBytes(sz) : '-'}</td>
  <td style="padding:8px 12px"><span style="color:var(--accent2);font-size:12px">View</span></td>
</tr>`;
    }).join('');
  }
  document.getElementById('reqLogInfo').textContent = total === 0 ? 'No results' : `Showing ${(page - 1) * rlLimit + 1}-${Math.min(page * rlLimit, total)} of ${total}`;
  document.getElementById('rlPrev').disabled = page <= 1;
  document.getElementById('rlNext').disabled = page >= totalPages;
}
function reqLogPrevPage() { if (rlPage > 1) { rlPage--; fetchRequestLogs(); } }
function reqLogNextPage() { if (rlData && rlPage < rlData.totalPages) { rlPage++; fetchRequestLogs(); } }

// ─── Request Detail ──────────────────────────────────────────────────────────
async function openReqDetail(id) {
  const modal = document.getElementById('reqDetailModal');
  modal.style.display = 'block';
  document.getElementById('reqDetailContent').innerHTML = '<div class="rdm-loading"><div class="rdm-spinner"></div><span>Loading request details\u2026</span></div>';
  try {
    const res = await api('/admin/requests/' + id);
    if (!res.ok) { document.getElementById('reqDetailContent').innerHTML = '<div class="rdm-error">Failed to load request details.</div>'; return; }
    renderReqDetail(await res.json());
  } catch (e) { document.getElementById('reqDetailContent').innerHTML = '<div class="rdm-error">Error: ' + esc(e.message) + '</div>'; }
}
function closeReqDetail() { document.getElementById('reqDetailModal').style.display = 'none'; }

function renderReqDetail(d) {
  const sc = d.resStatus;
  const statusCls = !sc ? 'rdm-st-unknown' : sc < 300 ? 'rdm-st-ok' : sc < 400 ? 'rdm-st-redirect' : sc < 500 ? 'rdm-st-client' : 'rdm-st-server';
  const ts = new Date(d.timestamp + 'Z');
  let reqH = ''; try { reqH = JSON.stringify(JSON.parse(d.reqHeaders || '{}'), null, 2); } catch { reqH = d.reqHeaders || ''; }
  let resH = ''; try { resH = JSON.stringify(JSON.parse(d.resHeaders || '{}'), null, 2); } catch { resH = d.resHeaders || ''; }

  const methodColors = { GET: 'var(--green)', POST: 'var(--blue)', PUT: 'var(--orange)', PATCH: 'var(--orange)', DELETE: 'var(--red)', HEAD: 'var(--text3)', OPTIONS: 'var(--text3)' };
  const mColor = methodColors[d.method] || 'var(--text2)';
  const durPct = d.durationMs ? Math.min((d.durationMs / 5000) * 100, 100) : 0;
  const durColor = d.durationMs < 200 ? 'var(--green)' : d.durationMs < 1000 ? 'var(--orange)' : 'var(--red)';
  const typeBadge = d.type === 'proxy'
    ? `<span class="rdm-badge rdm-badge-proxy" style="background:var(--accent-bg);color:var(--accent2);padding:2px 8px;border-radius:4px;font-size:11px">Proxy${d.profileName ? ' &middot; ' + esc(d.profileName) : ''}</span>`
    : d.type === 'webhook'
    ? `<span class="rdm-badge" style="background:var(--orange-bg);color:var(--orange);padding:2px 8px;border-radius:4px;font-size:11px">Webhook${d.targetName ? ' &middot; ' + esc(d.targetName) : ''}</span>`
    : `<span class="rdm-badge rdm-badge-target" style="background:var(--blue-bg);color:var(--blue);padding:2px 8px;border-radius:4px;font-size:11px">Target${d.targetName ? ' &middot; ' + esc(d.targetName) : ''}</span>`;
  let reqHCount = 0; try { reqHCount = Object.keys(JSON.parse(d.reqHeaders || '{}')).length; } catch { }
  let resHCount = 0; try { resHCount = Object.keys(JSON.parse(d.resHeaders || '{}')).length; } catch { }

  document.getElementById('reqDetailTitle').innerHTML = `<span style="color:${mColor};font-weight:700">${esc(d.method)}</span> <span style="font-weight:400;color:var(--text2)">${esc(d.path)}</span>`;

  document.getElementById('reqDetailContent').innerHTML = `
<div class="rdm-hero ${statusCls}">
  <div class="rdm-hero-main">
    <div class="rdm-status-code">${sc || '\u2014'}</div>
    <div class="rdm-status-info">
      <div class="rdm-status-text">${esc(d.resStatusText || 'No Response')}</div>
      <div class="rdm-status-meta">${typeBadge}</div>
    </div>
  </div>
  <div class="rdm-hero-metrics">
    <div class="rdm-metric">
      <div class="rdm-metric-val">${d.durationMs ? fmtMs(d.durationMs) : '\u2014'}</div>
      <div class="rdm-metric-lbl">Duration</div>
      ${d.durationMs ? `<div class="rdm-perf-bar"><div class="rdm-perf-fill" style="width:${durPct}%;background:${durColor}"></div></div>` : ''}
    </div>
    <div class="rdm-metric">
      <div class="rdm-metric-val">${fmtBytes((d.reqBodySize || 0) + (d.resBodySize || 0))}</div>
      <div class="rdm-metric-lbl">Total Size</div>
    </div>
  </div>
</div>
<div class="rdm-meta-grid">
  <div class="rdm-meta-item"><div><div class="rdm-meta-lbl">Timestamp</div><div class="rdm-meta-val">${esc(ts.toLocaleString())}</div></div></div>
  <div class="rdm-meta-item"><div><div class="rdm-meta-lbl">Client IP</div><div class="rdm-meta-val" style="font-family:'SF Mono',ui-monospace,monospace">${esc(d.clientIp || 'unknown')}</div></div></div>
  <div class="rdm-meta-item rdm-meta-wide">
    <div style="min-width:0;flex:1"><div class="rdm-meta-lbl">Request ID</div><div class="rdm-meta-val rdm-mono-val" title="${esc(d.requestId)}">${esc(d.requestId)}</div></div>
    <button class="rdm-copy-btn" onclick="navigator.clipboard.writeText('${esc(d.requestId)}').then(()=>toast('Copied ID'))" title="Copy ID">Copy</button>
  </div>
  <div class="rdm-meta-item rdm-meta-wide">
    <div style="min-width:0;flex:1"><div class="rdm-meta-lbl">Target URL</div><div class="rdm-meta-val rdm-mono-val" title="${esc(d.targetUrl)}">${esc(d.targetUrl)}</div></div>
    <button class="rdm-copy-btn" onclick="navigator.clipboard.writeText('${esc(d.targetUrl)}').then(()=>toast('Copied URL'))" title="Copy URL">Copy</button>
  </div>
</div>
${d.error ? `<div class="rdm-error-banner"><div><div style="font-weight:600;margin-bottom:2px">Error</div><div>${esc(d.error)}</div></div></div>` : ''}
<div class="rdm-tabs">
  <button class="rdm-tab active" onclick="rdmSwitchTab(this,'rdmReqPanel')">
    <span style="color:${mColor};font-weight:600">${esc(d.method)}</span> Request
    <span class="rdm-tab-badge">${fmtBytes(d.reqBodySize || 0)}</span>
  </button>
  <button class="rdm-tab" onclick="rdmSwitchTab(this,'rdmResPanel')">
    <span style="color:${statusCls === 'rdm-st-ok' ? 'var(--green)' : statusCls === 'rdm-st-redirect' ? 'var(--blue)' : statusCls === 'rdm-st-client' ? 'var(--orange)' : statusCls === 'rdm-st-server' ? 'var(--red)' : 'var(--text3)'};font-weight:600">${sc || '\u2014'}</span> Response
    <span class="rdm-tab-badge">${fmtBytes(d.resBodySize || 0)}</span>
  </button>
  ${d.attempts && d.attempts.length > 1 ? `<button class="rdm-tab" onclick="rdmSwitchTab(this,'rdmAttemptsPanel')"><span style="color:var(--orange);font-weight:600">Attempts</span><span class="rdm-tab-badge">${d.attempts.length}</span></button>` : ''}
  ${d.type === 'webhook' ? `<button class="rdm-tab" onclick="rdmSwitchTab(this,'rdmFanoutPanel');loadFanoutDeliveries('${esc(d.requestId)}')"><span style="color:var(--orange);font-weight:600">Fanouts</span></button>` : ''}
</div>
<div id="rdmReqPanel" class="rdm-tab-panel active">
  <div class="rdm-section">
    <div class="rdm-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="rdm-section-chevron">&#9660;</span><span class="rdm-section-title">Headers</span><span class="rdm-section-count">${reqHCount}</span>
    </div>
    <div class="rdm-section-body"><div class="rdm-code-block"><button class="rdm-copy-btn rdm-copy-code" onclick="rdmCopyCode(this)" title="Copy">Copy</button><pre>${rdmSyntaxHL(reqH)}</pre></div></div>
  </div>
  <div class="rdm-section">
    <div class="rdm-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="rdm-section-chevron">&#9660;</span><span class="rdm-section-title">Body</span><span class="rdm-section-count">${fmtBytes(d.reqBodySize || 0)}</span>
    </div>
    <div class="rdm-section-body"><div class="rdm-code-block"><button class="rdm-copy-btn rdm-copy-code" onclick="rdmCopyCode(this)" title="Copy">Copy</button><pre>${rdmSyntaxHL(fmtBody(d.reqBody))}</pre></div></div>
  </div>
</div>
<div id="rdmResPanel" class="rdm-tab-panel">
  <div class="rdm-section">
    <div class="rdm-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="rdm-section-chevron">&#9660;</span><span class="rdm-section-title">Headers</span><span class="rdm-section-count">${resHCount}</span>
    </div>
    <div class="rdm-section-body"><div class="rdm-code-block"><button class="rdm-copy-btn rdm-copy-code" onclick="rdmCopyCode(this)" title="Copy">Copy</button><pre>${rdmSyntaxHL(resH)}</pre></div></div>
  </div>
  <div class="rdm-section">
    <div class="rdm-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="rdm-section-chevron">&#9660;</span><span class="rdm-section-title">Body</span><span class="rdm-section-count">${fmtBytes(d.resBodySize || 0)}</span>
    </div>
    <div class="rdm-section-body"><div class="rdm-code-block"><button class="rdm-copy-btn rdm-copy-code" onclick="rdmCopyCode(this)" title="Copy">Copy</button><pre>${rdmSyntaxHL(fmtBody(d.resBody))}</pre></div></div>
  </div>
</div>
${d.attempts && d.attempts.length > 1 ? `
<div id="rdmAttemptsPanel" class="rdm-tab-panel">
  <div style="padding:0">
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid var(--border)">
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">#</th>
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">Status</th>
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">Duration</th>
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">Delay before</th>
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">Error</th>
        </tr>
      </thead>
      <tbody>
        ${d.attempts.map(a => {
          const st = a.status;
          const stText = a.statusText ? ' ' + esc(a.statusText) : '';
          const statusHtml = !st
            ? '<span style="color:var(--red);font-weight:600">Network err</span>'
            : st < 300 ? `<span style="color:var(--green);font-weight:600">${st}${stText}</span>`
            : `<span style="color:var(--red);font-weight:600">${st}${stText}</span>`;
          return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:10px 16px;color:var(--text2);font-weight:600">${a.attempt}</td>
            <td style="padding:10px 16px">${statusHtml}</td>
            <td style="padding:10px 16px;color:var(--text2)">${fmtMs(a.durationMs)}</td>
            <td style="padding:10px 16px;color:var(--text3)">${a.delayMs ? fmtMs(a.delayMs) : '—'}</td>
            <td style="padding:10px 16px;color:var(--red);font-family:monospace;font-size:11px">${a.error ? esc(a.error) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</div>` : ''}
${d.type === 'webhook' ? `
<div id="rdmFanoutPanel" class="rdm-tab-panel">
  <div style="padding:0">
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid var(--border)">
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">Timestamp</th>
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">Status</th>
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">Destination</th>
          <th style="padding:8px 16px;color:var(--text2);font-weight:600">Time</th>
          <th style="padding:8px 16px;color:var(--text2);font-weight:600"></th>
        </tr>
      </thead>
      <tbody id="fanoutDeliveriesList">
        <tr><td colspan="5" style="padding:30px;text-align:center;color:var(--text3)"><div class="rdm-spinner" style="display:inline-block;vertical-align:middle;margin-right:8px"></div>Loading...</td></tr>
      </tbody>
    </table>
  </div>
</div>` : ''}`;
}

async function loadFanoutDeliveries(reqId) {
  try {
    const res = await api('/admin/requests?limit=100&type=webhook-fanout&search=' + reqId);
    if (!res.ok) throw new Error('Failed to load fanouts');
    const data = await res.json();
    const c = document.getElementById('fanoutDeliveriesList');
    if (!data.requests || data.requests.length === 0) {
      c.innerHTML = '<tr><td colspan="5" style="padding:30px;text-align:center;color:var(--text3)">No fanout deliveries found for this payload.</td></tr>';
      return;
    }
    c.innerHTML = data.requests.map(f => {
      const ts = new Date(f.timestamp + 'Z').toLocaleTimeString();
      const st = f.resStatus;
      const stText = f.resStatusText ? ' ' + esc(f.resStatusText) : '';
      const statusHtml = !st ? '<span style="color:var(--text3)">Err</span>' : st < 300 ? `<span style="color:var(--green);font-weight:600">${st}${stText}</span>` : `<span style="color:var(--red);font-weight:600">${st}${stText}</span>`;
      const attemptBadge = f.attemptCount && f.attemptCount > 1 ? ` <span style="background:var(--orange-bg);color:var(--orange);padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px" title="${f.attemptCount} attempts">${f.attemptCount}×</span>` : '';
      return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
        <td style="padding:10px 16px;color:var(--text2)">${ts}</td>
        <td style="padding:10px 16px">${statusHtml}${attemptBadge}</td>
        <td style="padding:10px 16px;font-family:monospace;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.targetUrl)}">${esc(f.targetUrl)}</td>
        <td style="padding:10px 16px;color:var(--text2)">${f.durationMs ? fmtMs(f.durationMs) : '-'}</td>
        <td style="padding:10px 16px"><button class="btn btn-sm" onclick="openReqDetail(${f.id})" style="font-size:11px;padding:3px 8px">Details</button></td>
      </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('fanoutDeliveriesList').innerHTML = `<tr><td colspan="5" style="padding:20px;color:var(--red);text-align:center">Error: ${esc(e.message)}</td></tr>`;
  }
}

function rdmSwitchTab(btn, panelId) {
  btn.closest('.rdm-tabs').querySelectorAll('.rdm-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const panels = btn.closest('.rdm-body').querySelectorAll('.rdm-tab-panel');
  panels.forEach(p => p.classList.remove('active'));
  document.getElementById(panelId).classList.add('active');
}

function rdmCopyCode(btn) {
  const pre = btn.parentElement.querySelector('pre');
  navigator.clipboard.writeText(pre.textContent).then(() => toast('Copied to clipboard'));
}

function rdmSyntaxHL(str) {
  if (!str || str === '(empty)') return '<span style="color:var(--text3);font-style:italic">(empty)</span>';
  return esc(str)
    .replace(/("[^"]*")\s*:/g, '<span style="color:var(--blue)">$1</span>:')
    .replace(/:\s*("[^"]*")/g, ': <span style="color:var(--green)">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:var(--orange)">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span style="color:var(--accent2)">$1</span>')
    .replace(/:\s*(null)/g, ': <span style="color:var(--text3)">$1</span>');
}

function fmtBody(body) { if (!body) return '(empty)'; try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; } }

// ─── TCP/UDP Proxies (integrated in Proxies tab) ──────────────────────────────
let _allTcpUdpProxies = [];
let _editingSip = null;

async function fetchSipProxies() {
  try {
    const res = await api('/admin/tcpudp'); if (!res.ok) return;
    const d = await res.json(); _allTcpUdpProxies = d.tcpUdpProxies || [];
    renderTcpUdpProxies(_allTcpUdpProxies);
    const sec = document.getElementById('tcpUdpSection');
    if (sec) sec.style.display = _allTcpUdpProxies.length ? '' : 'none';
  } catch (e) { console.error('fetchSipProxies:', e); }
}

function renderTcpUdpProxies(list) {
  const c = document.getElementById('tcpUdpListBody');
  if (!c) return;
  if (!list.length) { c.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text3)">No TCP/UDP proxies yet.</td></tr>'; return; }
  c.innerHTML = list.map(p => {
    const dot = p.running
      ? '<span class="status-dot online" style="display:inline-block;margin-right:5px"></span>Running'
      : '<span class="status-dot offline" style="display:inline-block;margin-right:5px"></span>Stopped';
    const listeners = (p.listeners || []).map(l => {
      const colors = { tls: 'var(--accent)', udp: 'var(--blue)', tcp: 'var(--text2)' };
      return `<span style="color:${colors[l.transport]||'var(--text2)'};font-size:11px;margin-right:4px;font-family:monospace">${l.transport.toUpperCase()}:${l.port}</span>`;
    }).join('');
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:10px 12px;font-weight:600;font-family:monospace">${esc(p.name)}</td>
      <td style="padding:10px 8px;font-size:12px">${dot}</td>
      <td style="padding:10px 8px">${listeners}</td>
      <td style="padding:10px 8px;font-family:monospace">${esc(p.upstreamHost)}:${p.upstreamPort}</td>
      <td style="padding:10px 8px"><span style="background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:1px 6px;font-size:11px;text-transform:uppercase">${esc(p.upstreamTransport)}</span></td>
      <td style="padding:10px 12px;text-align:right">
        <button onclick="restartSipProxy('${esc(p.name)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--text2);font-size:11px;margin-right:4px">Restart</button>
        <button onclick="editSipProxy('${esc(p.name)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--text2);font-size:11px;margin-right:4px">Edit</button>
        <button onclick="deleteSipProxy('${esc(p.name)}')" style="background:none;border:1px solid rgba(239,68,68,0.4);border-radius:4px;padding:2px 8px;cursor:pointer;color:#fca5a5;font-size:11px">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function openSipModal(proxy) {
  _editingSip = proxy || null;
  document.getElementById('sipModalTitle').textContent = proxy ? 'Edit TCP/UDP Proxy' : 'New TCP/UDP Proxy';
  document.getElementById('sipModalError').style.display = 'none';
  document.getElementById('sipName').value = proxy ? proxy.name : '';
  document.getElementById('sipName').disabled = !!proxy;
  document.getElementById('sipUpstreamHost').value = (proxy && proxy.upstreamHost) || '';
  document.getElementById('sipUpstreamPort').value = (proxy && proxy.upstreamPort) || 5060;
  document.getElementById('sipUpstreamTransport').value = (proxy && proxy.upstreamTransport) || 'udp';
  document.getElementById('sipAllowSelfSignedUpstream').checked = !!(proxy && proxy.allowSelfSignedUpstream);
  const publicHost = (proxy && proxy.sipPublicHost) || '';
  document.getElementById('sipPublicHost').value = publicHost;
  // Open Advanced section automatically if it has a value
  const advSection = document.getElementById('sipAdvancedSection');
  const advArrow = document.getElementById('sipAdvancedArrow');
  if (publicHost) {
    advSection.style.display = '';
    advArrow.textContent = '▼';
  } else {
    advSection.style.display = 'none';
    advArrow.textContent = '▶';
  }
  toggleSipUpstreamTls();
  document.getElementById('sipAllowedIps').value = (proxy && proxy.allowedIps || []).join(', ');
  document.getElementById('sipRtpRelay').checked = !!(proxy && proxy.rtpRelay);
  document.getElementById('sipRtpPortStart').value = (proxy && proxy.rtpPortStart) || '';
  document.getElementById('sipRtpPortEnd').value = (proxy && proxy.rtpPortEnd) || '';
  document.getElementById('sipRtpWorkers').value = (proxy && proxy.rtpWorkers !== undefined && proxy.rtpWorkers !== null) ? proxy.rtpWorkers : '';
  toggleSipRtpRelay();
  // Populate listener checkboxes
  const listeners = (proxy && proxy.listeners) || [];
  document.getElementById('sipListenerUdp').checked = listeners.some(l => l.transport === 'udp');
  document.getElementById('sipListenerTcp').checked = listeners.some(l => l.transport === 'tcp');
  document.getElementById('sipListenerTls').checked = listeners.some(l => l.transport === 'tls');
  const isAcme = proxy && !!proxy.acmeDomain;
  document.getElementById('sipCertMode').value = isAcme ? 'acme' : 'manual';
  document.getElementById('sipTlsCert').value = (proxy && proxy.tlsCert) || '';
  document.getElementById('sipTlsKey').value = (proxy && proxy.tlsKey) || '';
  document.getElementById('sipAcmeDomain').value = (proxy && proxy.acmeDomain) || '';
  document.getElementById('sipAcmeEmail').value = (proxy && proxy.acmeEmail) || '';
  document.getElementById('sipAcmeStaging').checked = !!(proxy && proxy.acmeStaging);
  toggleSipTlsSection();
  toggleSipCertMode();
  document.getElementById('sipModal').classList.add('active');
  document.getElementById('sipName').focus();
}

function toggleSipTlsSection() {
  const tls = document.getElementById('sipListenerTls').checked;
  document.getElementById('sipTlsSection').style.display = tls ? '' : 'none';
}

function toggleSipUpstreamTls() {
  const isTls = document.getElementById('sipUpstreamTransport').value === 'tls';
  document.getElementById('sipUpstreamTlsGroup').style.display = isTls ? '' : 'none';
}

function toggleSipAdvanced(btn) {
  const section = document.getElementById('sipAdvancedSection');
  const arrow = document.getElementById('sipAdvancedArrow');
  const open = section.style.display === 'none';
  section.style.display = open ? '' : 'none';
  arrow.textContent = open ? '▼' : '▶';
}

function toggleSipRtpRelay() {
  const enabled = document.getElementById('sipRtpRelay').checked;
  document.getElementById('sipRtpRelayGroup').style.display = enabled ? 'block' : 'none';
}

function toggleSipCertMode() {
  const isAcme = document.getElementById('sipCertMode').value === 'acme';
  document.getElementById('sipCertPathGroup').style.display = isAcme ? 'none' : '';
  document.getElementById('sipKeyPathGroup').style.display = isAcme ? 'none' : '';
  document.getElementById('sipAcmeDomainGroup').style.display = isAcme ? '' : 'none';
  document.getElementById('sipAcmeEmailGroup').style.display = isAcme ? '' : 'none';
  document.getElementById('sipAcmeStagingGroup').style.display = isAcme ? '' : 'none';
}

function closeSipModal() {
  document.getElementById('sipModal').classList.remove('active');
  _editingSip = null;
}

async function saveSipProxy() {
  const errEl = document.getElementById('sipModalError');
  errEl.style.display = 'none';

  // Build listeners array from checkboxes
  const listeners = [];
  if (document.getElementById('sipListenerUdp').checked) listeners.push({ transport: 'udp', port: 0 });
  if (document.getElementById('sipListenerTcp').checked) listeners.push({ transport: 'tcp', port: 0 });
  if (document.getElementById('sipListenerTls').checked) listeners.push({ transport: 'tls', port: 0 });

  if (listeners.length === 0) {
    errEl.textContent = 'Select at least one listener (UDP, TCP, or TLS)';
    errEl.style.display = 'block';
    return;
  }

  const hasTls = listeners.some(l => l.transport === 'tls');
  const isAcme = hasTls && document.getElementById('sipCertMode').value === 'acme';
  const allowedIpsRaw = document.getElementById('sipAllowedIps').value;

  const body = {
    name: document.getElementById('sipName').value.trim().toLowerCase(),
    listeners,
    upstreamHost: document.getElementById('sipUpstreamHost').value.trim(),
    upstreamPort: parseInt(document.getElementById('sipUpstreamPort').value) || 5060,
    upstreamTransport: document.getElementById('sipUpstreamTransport').value,
    allowSelfSignedUpstream: document.getElementById('sipAllowSelfSignedUpstream').checked,
    sipPublicHost: document.getElementById('sipPublicHost').value.trim() || undefined,
    rtpRelay: document.getElementById('sipRtpRelay').checked,
    rtpPortStart: parseInt(document.getElementById('sipRtpPortStart').value) || undefined,
    rtpPortEnd: parseInt(document.getElementById('sipRtpPortEnd').value) || undefined,
    rtpWorkers: document.getElementById('sipRtpWorkers').value !== '' ? parseInt(document.getElementById('sipRtpWorkers').value) : undefined,
    allowedIps: allowedIpsRaw ? allowedIpsRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
  };

  if (hasTls) {
    if (isAcme) {
      body.acmeDomain = document.getElementById('sipAcmeDomain').value.trim();
      body.acmeEmail = document.getElementById('sipAcmeEmail').value.trim();
      body.acmeStaging = document.getElementById('sipAcmeStaging').checked;
    } else {
      body.tlsCert = document.getElementById('sipTlsCert').value.trim();
      body.tlsKey = document.getElementById('sipTlsKey').value.trim();
    }
  }

  try {
    const res = await api('/admin/tcpudp', { method: 'POST', body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) { errEl.textContent = d.error || 'Error saving'; errEl.style.display = 'block'; return; }
    const ports = (d.listeners || []).map(l => l.transport.toUpperCase() + ':' + l.port).join(', ');
    toast('TCP/UDP proxy ' + (d.status || 'saved') + (ports ? ' [' + ports + ']' : ''));
    closeSipModal();
    await fetchSipProxies();
  } catch (e) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = 'block'; }
}

async function editSipProxy(name) {
  try {
    const res = await api('/admin/tcpudp/' + encodeURIComponent(name));
    if (!res.ok) return toast('Not found', 'error');
    openSipModal((await res.json()).tcpUdpProxy);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteSipProxy(name) {
  if (!confirm('Delete TCP/UDP proxy "' + name + '"? This stops the listener immediately.')) return;
  try {
    const res = await api('/admin/tcpudp/' + encodeURIComponent(name), { method: 'DELETE' });
    if (res.ok) { toast('TCP/UDP proxy deleted'); await fetchSipProxies(); }
    else { const d = await res.json(); toast(d.error || 'Delete failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function restartSipProxy(name) {
  try {
    const res = await api('/admin/tcpudp/' + encodeURIComponent(name) + '/restart', { method: 'POST' });
    if (res.ok) { toast('TCP/UDP proxy "' + name + '" restarted'); await fetchSipProxies(); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── OAuth Clients ───────────────────────────────────────────────────────────
async function fetchOauthClients() {
  try {
    const res = await api('/admin/oauth-clients');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { clients } = await res.json();
    _allOauthClients = clients || [];
    renderOauthClients(clients || []);
    if (_allInvites.length) renderInvites(_allInvites);
    const badge = document.getElementById('navOauthBadge');
    if (badge) badge.textContent = String(clients.length);
  } catch (e) {
    document.getElementById('oauthClientListBody').innerHTML =
      '<tr><td colspan="5" style="padding:40px;text-align:center;color:var(--err-text)">Error: ' + esc(e.message) + '</td></tr>';
  }
  renderOauthEndpoints();
}

function renderOauthEndpoints() {
  const origin = window.location.protocol + '//' + window.location.hostname;
  const note = ' <span style="color:var(--text3)">(replace with the public issuer)</span>';
  const set = (id, path) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = esc(origin + ':JWKS_PORT' + path) + note;
  };
  set('oeDiscovery', '/.well-known/openid-configuration');
  set('oeAuth',      '/oauth/authorize');
  set('oeToken',     '/oauth/token');
  set('oeUserinfo',  '/oauth/userinfo');
  set('oeJwks',      '/.well-known/jwks.json');
}

function renderOauthClients(clients) {
  const tbody = document.getElementById('oauthClientListBody');
  if (!clients.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--text3)">Sem clients registados.</td></tr>';
    return;
  }
  tbody.innerHTML = clients.map(c => {
    const uris = (c.redirectUris || []).map(esc).join('<br>');
    const created = c.createdAt ? new Date(c.createdAt).toLocaleString() : '—';
    const accessBadge = c.allowListEnabled
      ? '<span style="display:inline-block;background:rgba(234,179,8,.15);color:#ca8a04;border:1px solid rgba(234,179,8,.3);border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600">Restricted</span>'
      : '<span style="display:inline-block;background:rgba(34,197,94,.1);color:var(--green);border:1px solid rgba(34,197,94,.25);border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600">Open</span>';
    // Encode args so that JSON's double quotes don't terminate the onclick="" attribute.
    const cid = JSON.stringify(c.clientId).replace(/"/g, '&quot;');
    const cname = JSON.stringify(c.name).replace(/"/g, '&quot;');
    return '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:10px 12px;font-weight:500">' + esc(c.name) + '</td>' +
      '<td style="padding:10px 8px;font-family:\'SF Mono\',ui-monospace,monospace;font-size:11.5px;color:var(--text2);word-break:break-all;max-width:200px">' + esc(c.clientId) + '</td>' +
      '<td style="padding:10px 8px;font-family:\'SF Mono\',ui-monospace,monospace;font-size:11px;color:var(--text2)">' + uris + '</td>' +
      '<td style="padding:10px 8px;color:var(--text3);font-size:11.5px">' + esc(created) + '</td>' +
      '<td style="padding:10px 8px">' + accessBadge + '</td>' +
      '<td style="padding:10px 12px;text-align:right;white-space:nowrap">' +
        '<button class="btn btn-sm" onclick="openEditOauthClientModal(' + cid + ')" style="margin-right:4px">Edit</button>' +
        '<button class="btn btn-sm" onclick="openOauthClientUsersModal(' + cid + ',' + cname + ')" style="margin-right:4px">Users</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="deleteOauthClient(' + cid + ',' + cname + ')" style="color:var(--err-text)">Delete</button>' +
      '</td>' +
      '</tr>';
  }).join('');
}

// Tracks the client being edited (null in create mode) and the original URIs
// joined by newline, used to detect a real change before warning/revoking.
let _editingOauthClientId = null;
let _editingOauthClientOriginalUris = '';

function _populateConsentPageDropdown(selectId, selectedId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const options = ['<option value="">— Choose a page —</option>'];
  for (const p of (_consentPages || [])) {
    const selected = (selectedId != null && Number(selectedId) === p.id) ? ' selected' : '';
    options.push('<option value="' + p.id + '"' + selected + '>' + esc(p.name) + (p.title ? ' — ' + esc(p.title) : '') + '</option>');
  }
  sel.innerHTML = options.join('');
}

function _resetOauthClientForm() {
  document.getElementById('oauthClientName').value = '';
  document.getElementById('oauthClientUris').value = '';
  document.getElementById('oauthClientPkceRequired').checked = true;
  document.getElementById('oauthClientConsentEnabled').checked = false;
  _populateConsentPageDropdown('oauthClientConsentPageId', null);
  document.getElementById('oauthClientConsentFields').style.display = 'none';
  document.getElementById('oauthClientUrisChangeWarning').style.display = 'none';
  document.getElementById('oauthClientForm').style.display = '';
  document.getElementById('oauthClientSecret').style.display = 'none';
  document.getElementById('oauthClientCancelBtn').style.display = '';
}

function toggleOauthClientConsentFields() {
  const on = document.getElementById('oauthClientConsentEnabled').checked;
  document.getElementById('oauthClientConsentFields').style.display = on ? '' : 'none';
}

async function openCreateOauthClientModal() {
  _editingOauthClientId = null;
  _editingOauthClientOriginalUris = '';
  // Ensure dropdown reflects latest pages.
  if (!_consentPages.length) await fetchConsentPages();
  _resetOauthClientForm();
  document.getElementById('oauthClientSubmitBtn').textContent = 'Create';
  document.getElementById('oauthClientSubmitBtn').onclick = submitOauthClient;
  document.getElementById('oauthClientCancelBtn').textContent = 'Cancel';
  document.getElementById('oauthClientModalTitle').textContent = 'New OAuth Client';
  document.getElementById('oauthClientModal').style.display = 'flex';
}

async function openEditOauthClientModal(clientId) {
  try {
    // Refresh pages so the dropdown is current (admin may have just created one).
    await fetchConsentPages();
    const res = await api('/admin/oauth-clients');
    if (!res.ok) return toast('Failed to load client', 'error');
    const data = await res.json();
    const client = (data.clients || []).find(c => c.clientId === clientId);
    if (!client) return toast('Client not found', 'error');

    _editingOauthClientId = clientId;
    _resetOauthClientForm();
    document.getElementById('oauthClientName').value = client.name || '';
    const urisText = (client.redirectUris || []).join('\n');
    document.getElementById('oauthClientUris').value = urisText;
    _editingOauthClientOriginalUris = urisText;
    document.getElementById('oauthClientPkceRequired').checked = client.pkceRequired !== false;
    document.getElementById('oauthClientConsentEnabled').checked = !!client.consentEnabled;
    _populateConsentPageDropdown('oauthClientConsentPageId', client.consentPageId);
    toggleOauthClientConsentFields();

    // Live-warn when the user changes the URIs vs original.
    document.getElementById('oauthClientUris').oninput = function () {
      const changed = this.value.trim() !== _editingOauthClientOriginalUris.trim();
      document.getElementById('oauthClientUrisChangeWarning').style.display = changed ? '' : 'none';
    };

    document.getElementById('oauthClientSubmitBtn').textContent = 'Save';
    document.getElementById('oauthClientSubmitBtn').onclick = submitEditOauthClient;
    document.getElementById('oauthClientCancelBtn').textContent = 'Cancel';
    document.getElementById('oauthClientModalTitle').textContent = 'Edit — ' + (client.name || clientId);
    document.getElementById('oauthClientModal').style.display = 'flex';
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function closeOauthClientModal() {
  document.getElementById('oauthClientModal').style.display = 'none';
  document.getElementById('oauthClientUris').oninput = null;
  _editingOauthClientId = null;
  _editingOauthClientOriginalUris = '';
}

async function submitOauthClient() {
  const name = document.getElementById('oauthClientName').value.trim();
  const redirectUris = document.getElementById('oauthClientUris').value
    .split('\n').map(s => s.trim()).filter(Boolean);
  if (!name) return toast('Name is required', 'error');
  if (!redirectUris.length) return toast('At least one redirect URI', 'error');
  const pkceRequired = document.getElementById('oauthClientPkceRequired').checked;
  if (!pkceRequired && !confirm('Disable PKCE for this client?\n\nThis removes a security defense (auth-code interception protection). Only do this for legacy clients that cannot send a code_challenge.')) return;
  try {
    const res = await api('/admin/oauth-clients', {
      method: 'POST',
      body: JSON.stringify({ name, redirectUris, pkceRequired }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Failed to create', 'error');

    document.getElementById('newClientId').textContent = data.client.clientId;
    document.getElementById('newClientSecret').textContent = data.clientSecret;
    document.getElementById('oauthClientForm').style.display = 'none';
    document.getElementById('oauthClientSecret').style.display = '';
    document.getElementById('oauthClientSubmitBtn').textContent = 'Done';
    document.getElementById('oauthClientSubmitBtn').onclick = closeOauthClientModal;
    document.getElementById('oauthClientCancelBtn').style.display = 'none';
    document.getElementById('oauthClientModalTitle').textContent = 'Client created';
    toast('OAuth client created');
    fetchOauthClients();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function submitEditOauthClient() {
  if (!_editingOauthClientId) return;
  const name = document.getElementById('oauthClientName').value.trim();
  const redirectUris = document.getElementById('oauthClientUris').value
    .split('\n').map(s => s.trim()).filter(Boolean);
  if (!name) return toast('Name is required', 'error');
  if (!redirectUris.length) return toast('At least one redirect URI', 'error');
  const urisChanged = redirectUris.join('\n') !== _editingOauthClientOriginalUris.trim();
  if (urisChanged && !confirm('Changing redirect URIs will revoke every refresh token for this client. Continue?')) return;
  const consentEnabled = document.getElementById('oauthClientConsentEnabled').checked;
  const consentPageRaw = document.getElementById('oauthClientConsentPageId').value;
  const consentPageId = consentPageRaw ? Number(consentPageRaw) : null;
  if (consentEnabled && !consentPageId) {
    return toast('Choose a consent page or disable consent.', 'error');
  }
  const pkceRequired = document.getElementById('oauthClientPkceRequired').checked;
  if (!pkceRequired && !confirm('Disable PKCE for this client?\n\nThis removes a security defense (auth-code interception protection). Only do this for legacy clients that cannot send a code_challenge.')) return;
  const payload = {
    name,
    redirectUris,
    consentEnabled,
    consentPageId,
    pkceRequired,
  };
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(_editingOauthClientId), {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'Failed to save', 'error');
    if (data.redirectUrisChanged && data.revokedRefreshTokens > 0) {
      toast('Client updated — ' + data.revokedRefreshTokens + ' refresh token(s) revoked');
    } else {
      toast(data.status === 'no_changes' ? 'No changes' : 'Client updated');
    }
    closeOauthClientModal();
    fetchOauthClients();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteOauthClient(clientId, name) {
  if (!confirm('Delete client "' + name + '"? Every issued token will be revoked.')) return;
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(clientId), { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return toast(data.error || 'Failed to delete', 'error');
    }
    toast('Client deleted');
    fetchOauthClients();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── OAuth Client Allow-list modal ──────────────────────────────────────────────────────
let _ocuClientId = null;
let _ocuClientName = null;

async function openOauthClientUsersModal(clientId, clientName) {
  _ocuClientId = clientId;
  _ocuClientName = clientName;
  document.getElementById('oauthClientUsersTitle').textContent = 'Acesso — ' + clientName;
  document.getElementById('oauthClientUsersModal').classList.add('active');
  await refreshOauthClientUsers();
  // Populate user dropdown
  try {
    const res = await api('/admin/proxy-users');
    if (res.ok) {
      const data = await res.json();
      const sel = document.getElementById('ocuAddSelect');
      sel.innerHTML = '<option value="">Select user...</option>' +
        (data.users || []).map(u => '<option value="' + u.id + '">' + esc(u.username) + (u.email ? ' — ' + esc(u.email) : '') + '</option>').join('');
    }
  } catch {}
  await refreshOauthClientLdapGroups();
}

function closeOauthClientUsersModal() {
  document.getElementById('oauthClientUsersModal').classList.remove('active');
  _ocuClientId = null;
  _ocuClientName = null;
}

async function refreshOauthClientUsers() {
  if (!_ocuClientId) return;
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(_ocuClientId) + '/users');
    if (!res.ok) return;
    const data = await res.json();
    const enabled = !!data.allowListEnabled;
    document.getElementById('oauthAllowListToggle').checked = enabled;
    document.getElementById('oauthAllowListSection').style.display = enabled ? '' : 'none';
    document.getElementById('oauthAllowListOpen').style.display = enabled ? 'none' : '';
    const tbody = document.getElementById('ocuListBody');
    const users = data.users || [];
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--text3)">Nenhum utilizador na lista.</td></tr>';
    } else {
      tbody.innerHTML = users.map(u => '<tr style="border-top:1px solid var(--border)">' +
        '<td style="padding:8px 12px;font-weight:500">' + esc(u.username) + '</td>' +
        '<td style="padding:8px;color:var(--text2);font-size:12px">' + esc(u.email || '—') + '</td>' +
        '<td style="padding:8px 12px;text-align:right"><button class="btn btn-sm btn-ghost" onclick="removeUserFromOauthClientUI(' + u.id + ',\'' + esc(u.username) + '\')" style="color:var(--err-text)">Remove</button></td>' +
        '</tr>').join('');
    }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function toggleOauthAllowList(enabled) {
  if (!_ocuClientId) return;
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(_ocuClientId) + '/allow-list', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'Failed', 'error'); }
    toast(enabled ? 'Allow-list ativada' : 'Allow-list desativada');
    await refreshOauthClientUsers();
    fetchOauthClients(); // refresh badge in table
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function addUserToOauthClientUI() {
  if (!_ocuClientId) return;
  const sel = document.getElementById('ocuAddSelect');
  const userId = sel.value;
  if (!userId) return toast('Seleciona um utilizador', 'error');
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(_ocuClientId) + '/users', {
      method: 'POST',
      body: JSON.stringify({ userId: Number(userId) }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'Failed', 'error'); }
    sel.value = '';
    toast('Utilizador adicionado');
    await refreshOauthClientUsers();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function removeUserFromOauthClientUI(userId, username) {
  if (!_ocuClientId) return;
  if (!confirm('Remove "' + username + '" from this client\'s access?')) return;
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(_ocuClientId) + '/users/' + encodeURIComponent(userId), { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'Failed', 'error'); }
    toast('Utilizador removido');
    await refreshOauthClientUsers();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── OAuth client: LDAP group rules ────────────────────────────────────────

let _oclgDirectories = [];

async function refreshOauthClientLdapGroups() {
  if (!_ocuClientId) return;
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(_ocuClientId) + '/ldap-groups');
    if (!res.ok) return;
    const data = await res.json();
    _oclgDirectories = data.directories || [];
    const sel = document.getElementById('oclgConfigSelect');
    if (sel) {
      sel.innerHTML = '<option value="">Directory…</option>' +
        _oclgDirectories.map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('');
    }
    const tbody = document.getElementById('oclgListBody');
    const rules = data.groups || [];
    if (!rules.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--text3)">Sem regras de grupo configuradas.</td></tr>';
      return;
    }
    const dirName = id => (_oclgDirectories.find(d => d.id === id) || {}).name || ('#' + id);
    tbody.innerHTML = rules.map(r => '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:8px 12px;font-weight:500">' + esc(dirName(r.ldapConfigId)) + '</td>' +
      '<td style="padding:8px;color:var(--text2);font-family:\'SF Mono\',ui-monospace,monospace;font-size:11.5px;word-break:break-all">' + esc(r.groupMatch) + '</td>' +
      '<td style="padding:8px 12px;text-align:right"><button class="btn btn-sm btn-ghost" onclick="removeLdapGroupFromClientUI(' + r.id + ')" style="color:var(--err-text)">Remove</button></td>' +
      '</tr>').join('');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function addLdapGroupToClientUI() {
  if (!_ocuClientId) return;
  const ldapConfigId = Number(document.getElementById('oclgConfigSelect').value);
  const groupMatch = document.getElementById('oclgGroupInput').value.trim();
  if (!ldapConfigId) return toast('Seleciona um directory', 'error');
  if (!groupMatch) return toast('Indica o CN ou DN do grupo', 'error');
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(_ocuClientId) + '/ldap-groups', {
      method: 'POST',
      body: JSON.stringify({ ldapConfigId, groupMatch }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'Failed', 'error'); }
    document.getElementById('oclgGroupInput').value = '';
    toast('Regra adicionada');
    await refreshOauthClientLdapGroups();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function removeLdapGroupFromClientUI(ruleId) {
  if (!_ocuClientId) return;
  if (!confirm('Remove this group rule? Users that depended on it will lose access on the next login (or sync).')) return;
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(_ocuClientId) + '/ldap-groups/' + encodeURIComponent(ruleId), { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'Failed', 'error'); }
    toast('Regra removida');
    await refreshOauthClientLdapGroups();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── Admins ──────────────────────────────────────────────────────────────────
let _currentUserId = null;

// ─── SMTP / Email ─────────────────────────────────────────────────────────────
let _smtpHasPassword = false;
let _smtpTestController = null;
let _smtpSendController = null;

function setSmtpStatus(elId, msg, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!msg) { el.textContent = ''; el.style.color = ''; return; }
  const colorMap = { ok: 'var(--ok-text)', err: 'var(--err-text)', info: 'var(--text2)' };
  el.style.color = colorMap[kind] || colorMap.info;
  el.textContent = msg;
}

async function fetchSmtpConfig() {
  try {
    const res = await api('/admin/smtp');
    if (!res.ok) return;
    const data = await res.json();
    const cfg = data.smtp;
    const hostEl = document.getElementById('smtpHost');
    const portEl = document.getElementById('smtpPort');
    const secEl  = document.getElementById('smtpSecurity');
    const userEl = document.getElementById('smtpUsername');
    const pwEl   = document.getElementById('smtpPassword');
    const fromAEl= document.getElementById('smtpFromAddress');
    const fromNEl= document.getElementById('smtpFromName');
    const allowEl= document.getElementById('smtpAllowInvalid');
    const clearBtn = document.getElementById('smtpClearBtn');
    const pwHint = document.getElementById('smtpPwHint');
    if (cfg) {
      hostEl.value = cfg.host || '';
      portEl.value = cfg.port || 587;
      secEl.value = cfg.security || 'starttls';
      userEl.value = cfg.username || '';
      pwEl.value = '';
      fromAEl.value = cfg.fromAddress || '';
      fromNEl.value = cfg.fromName || '';
      allowEl.checked = !!cfg.allowInvalidCerts;
      _smtpHasPassword = !!cfg.hasPassword;
      pwHint.textContent = _smtpHasPassword
        ? 'Leave empty to keep the current password.'
        : 'No password set.';
      clearBtn.style.display = '';
      setSmtpStatus('smtpStatus', 'Active configuration: ' + cfg.host + ':' + cfg.port, 'ok');
    } else {
      hostEl.value = '';
      portEl.value = 587;
      secEl.value = 'starttls';
      userEl.value = '';
      pwEl.value = '';
      fromAEl.value = '';
      fromNEl.value = '';
      allowEl.checked = false;
      _smtpHasPassword = false;
      pwHint.textContent = 'No password set.';
      clearBtn.style.display = 'none';
      setSmtpStatus('smtpStatus', 'No SMTP configuration active.', 'info');
    }
  } catch (e) {
    setSmtpStatus('smtpStatus', 'Failed to load: ' + e.message, 'err');
  }
}

function _readSmtpForm(includePasswordOnlyIfFilled) {
  const pw = document.getElementById('smtpPassword').value;
  const body = {
    host: document.getElementById('smtpHost').value.trim(),
    port: parseInt(document.getElementById('smtpPort').value, 10) || 0,
    security: document.getElementById('smtpSecurity').value,
    username: document.getElementById('smtpUsername').value.trim(),
    fromAddress: document.getElementById('smtpFromAddress').value.trim(),
    fromName: document.getElementById('smtpFromName').value.trim(),
    allowInvalidCerts: document.getElementById('smtpAllowInvalid').checked,
  };
  if (!includePasswordOnlyIfFilled || pw) body.password = pw;
  return body;
}

async function saveSmtpConfig() {
  const body = _readSmtpForm(true);
  if (!body.host) { setSmtpStatus('smtpStatus', 'Host is required.', 'err'); return; }
  if (!body.fromAddress) { setSmtpStatus('smtpStatus', 'Sender email is required.', 'err'); return; }
  setSmtpStatus('smtpStatus', 'Saving…', 'info');
  try {
    const res = await api('/admin/smtp', { method: 'PUT', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setSmtpStatus('smtpStatus', data.error || 'Failed to save.', 'err'); return; }
    toast('SMTP configuration saved');
    await fetchSmtpConfig();
  } catch (e) {
    setSmtpStatus('smtpStatus', 'Network error: ' + e.message, 'err');
  }
}

async function testSmtpConnectionUi() {
  const body = _readSmtpForm(true);
  if (!body.host) { setSmtpStatus('smtpStatus', 'Host is required.', 'err'); return; }
  if (!body.fromAddress) { setSmtpStatus('smtpStatus', 'Sender email is required.', 'err'); return; }
  if (_smtpTestController) return;
  _smtpTestController = new AbortController();
  document.getElementById('smtpTestBtn').style.display = 'none';
  document.getElementById('smtpTestCancelBtn').style.display = '';
  setSmtpStatus('smtpStatus', 'Testing connection…', 'info');
  try {
    const res = await fetch('/admin/smtp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: _smtpTestController.signal,
    });
    if (res.status === 401) { window.location.reload(); return; }
    const data = await res.json();
    if (data.ok) setSmtpStatus('smtpStatus', 'Connection OK ✔', 'ok');
    else setSmtpStatus('smtpStatus', 'Failed: ' + (data.error || 'unknown error'), 'err');
  } catch (e) {
    if (e.name === 'AbortError') setSmtpStatus('smtpStatus', 'Test cancelled.', 'info');
    else setSmtpStatus('smtpStatus', 'Network error: ' + e.message, 'err');
  } finally {
    _smtpTestController = null;
    document.getElementById('smtpTestBtn').style.display = '';
    document.getElementById('smtpTestCancelBtn').style.display = 'none';
  }
}

function cancelSmtpTest() {
  if (_smtpTestController) _smtpTestController.abort();
}

async function clearSmtpConfig() {
  if (!confirm('Remove the entire SMTP configuration?')) return;
  try {
    const res = await api('/admin/smtp', { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return setSmtpStatus('smtpStatus', d.error || 'Error', 'err'); }
    toast('SMTP configuration removed');
    await fetchSmtpConfig();
  } catch (e) {
    setSmtpStatus('smtpStatus', 'Network error: ' + e.message, 'err');
  }
}

function openSmtpSendTestModal() {
  document.getElementById('smtpTestTo').value = '';
  setSmtpStatus('smtpTestStatus', '', 'info');
  document.getElementById('smtpSendTestModal').style.display = 'flex';
}
function closeSmtpSendTestModal() {
  document.getElementById('smtpSendTestModal').style.display = 'none';
}

async function sendSmtpTest() {
  const to = document.getElementById('smtpTestTo').value.trim();
  if (!to) { setSmtpStatus('smtpTestStatus', 'Enter a recipient.', 'err'); return; }
  if (_smtpSendController) return;
  _smtpSendController = new AbortController();
  const sendBtn = document.getElementById('smtpTestSendBtn');
  const cancelBtn = document.getElementById('smtpSendCancelBtn');
  sendBtn.style.display = 'none';
  cancelBtn.style.display = '';
  setSmtpStatus('smtpTestStatus', 'Sending…', 'info');
  try {
    const res = await fetch('/admin/smtp/send-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
      signal: _smtpSendController.signal,
    });
    if (res.status === 401) { window.location.reload(); return; }
    const data = await res.json();
    if (data.ok) {
      setSmtpStatus('smtpTestStatus', 'Email sent ✔', 'ok');
      toast('Test email sent');
    } else {
      setSmtpStatus('smtpTestStatus', 'Failed: ' + (data.error || 'unknown error'), 'err');
    }
  } catch (e) {
    if (e.name === 'AbortError') setSmtpStatus('smtpTestStatus', 'Send cancelled.', 'info');
    else setSmtpStatus('smtpTestStatus', 'Network error: ' + e.message, 'err');
  } finally {
    _smtpSendController = null;
    sendBtn.style.display = '';
    cancelBtn.style.display = 'none';
  }
}

function cancelSmtpSend() {
  if (_smtpSendController) _smtpSendController.abort();
}

// ─── Audit Log ───────────────────────────────────────────────────────────────
let _auditOffset = 0;
const AUDIT_PAGE_SIZE = 50;

async function fetchAuditLogs(resetOffset) {
  if (resetOffset) _auditOffset = 0;
  const params = new URLSearchParams();
  const actor = document.getElementById('auditFilterActor') ? document.getElementById('auditFilterActor').value.trim() : '';
  const action = document.getElementById('auditFilterAction') ? document.getElementById('auditFilterAction').value : '';
  const from = document.getElementById('auditFilterFrom') ? document.getElementById('auditFilterFrom').value : '';
  const to = document.getElementById('auditFilterTo') ? document.getElementById('auditFilterTo').value : '';
  if (actor) params.set('actor', actor);
  if (action) params.set('action', action);
  if (from) params.set('from', from + 'T00:00:00');
  if (to) params.set('to', to + 'T23:59:59');
  params.set('limit', String(AUDIT_PAGE_SIZE));
  params.set('offset', String(_auditOffset));
  try {
    const res = await api('/admin/audit?' + params.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderAuditLogs(data.logs || [], data.total || 0);
  } catch (e) {
    document.getElementById('auditListBody').innerHTML =
      '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--err-text)">Error: ' + esc(e.message) + '</td></tr>';
  }
}

function renderAuditLogs(logs, total) {
  window._lastAuditLogs = logs;
  const tbody = document.getElementById('auditListBody');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--text3)">Sem entradas.</td></tr>';
  } else {
    tbody.innerHTML = logs.map(function(l, idx) {
      const when = new Date(l.createdAt).toLocaleString();
      const actor = l.actorUsername || '<system>';
      const target = (l.targetType || '') + (l.targetId ? ' #' + l.targetId : '');
      const failed = l.action.endsWith('.failed') || l.action.indexOf('error') !== -1;
      const actionStyle = failed ? 'color:var(--err-text);font-weight:500' : '';
      return '<tr style="border-top:1px solid var(--border)">' +
        '<td style="padding:10px 12px;color:var(--text2);font-size:11.5px;white-space:nowrap">' + esc(when) + '</td>' +
        '<td style="padding:10px 8px;font-weight:500">' + esc(actor) + '</td>' +
        '<td style="padding:10px 8px;font-family:monospace;font-size:11.5px;' + actionStyle + '">' + esc(l.action) + '</td>' +
        '<td style="padding:10px 8px;color:var(--text2);font-size:11.5px">' + esc(target || '—') + '</td>' +
        '<td style="padding:10px 8px;color:var(--text3);font-size:11.5px;font-family:monospace">' + esc(l.ipAddress || '—') + '</td>' +
        '<td style="padding:10px 12px;text-align:right"><button class="btn btn-sm btn-ghost" onclick="showAuditDetail(' + idx + ')">Detalhes</button></td>' +
        '</tr>';
    }).join('');
  }
  const fromN = total === 0 ? 0 : _auditOffset + 1;
  const toN = Math.min(_auditOffset + logs.length, total);
  document.getElementById('auditTotal').textContent = fromN + '–' + toN + ' de ' + total;
  document.getElementById('auditPrev').disabled = _auditOffset === 0;
  document.getElementById('auditNext').disabled = _auditOffset + logs.length >= total;
}

function auditPrevPage() {
  _auditOffset = Math.max(0, _auditOffset - AUDIT_PAGE_SIZE);
  fetchAuditLogs(false);
}
function auditNextPage() {
  _auditOffset += AUDIT_PAGE_SIZE;
  fetchAuditLogs(false);
}
function resetAuditFilters() {
  document.getElementById('auditFilterActor').value = '';
  document.getElementById('auditFilterAction').value = '';
  document.getElementById('auditFilterFrom').value = '';
  document.getElementById('auditFilterTo').value = '';
  fetchAuditLogs(true);
}

function showAuditDetail(idx) {
  const l = (window._lastAuditLogs || [])[idx];
  if (!l) return;
  document.getElementById('auditDetailBody').innerHTML =
    '<div style="font-size:12.5px;line-height:1.7">' +
      '<div><span style="color:var(--text3)">When:</span> ' + esc(new Date(l.createdAt).toLocaleString()) + '</div>' +
      '<div><span style="color:var(--text3)">Actor:</span> ' + esc(l.actorUsername || '<system>') + (l.actorUserId ? ' (#' + l.actorUserId + ')' : '') + '</div>' +
      '<div><span style="color:var(--text3)">Action:</span> <code>' + esc(l.action) + '</code></div>' +
      '<div><span style="color:var(--text3)">Target:</span> ' + esc(l.targetType || '—') + (l.targetId ? ' #' + esc(l.targetId) : '') + '</div>' +
      '<div><span style="color:var(--text3)">IP:</span> <code>' + esc(l.ipAddress || '—') + '</code></div>' +
      '<div><span style="color:var(--text3)">User-Agent:</span> <span style="font-size:11px">' + esc(l.userAgent || '—') + '</span></div>' +
      (l.details ? '<div style="margin-top:10px"><span style="color:var(--text3)">Details:</span><pre style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:4px;font-size:11px;overflow-x:auto">' + esc(JSON.stringify(l.details, null, 2)) + '</pre></div>' : '') +
    '</div>';
  document.getElementById('auditDetailModal').style.display = 'flex';
}
function closeAuditDetail() { document.getElementById('auditDetailModal').style.display = 'none'; }

// ─── LDAP directories ──────────────────────────────────────────────────────
let _ldapConfigs = [];

async function fetchLdapConfigs() {
  try {
    const res = await api('/admin/ldap/configs');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { configs } = await res.json();
    _ldapConfigs = configs || [];
    renderLdapConfigs(_ldapConfigs);
    const badge = document.getElementById('navLdapBadge');
    if (badge) badge.textContent = String(_ldapConfigs.filter(c => c.enabled).length);
  } catch (e) {
    document.getElementById('ldapListBody').innerHTML =
      '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--err-text)">Error: ' + esc(e.message) + '</td></tr>';
  }
}

function renderLdapConfigs(configs) {
  const tbody = document.getElementById('ldapListBody');
  if (!configs.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text3)">Sem directories configurados. Clica em <strong>Novo directory</strong> para adicionar.</td></tr>';
    return;
  }
  const scopeBadge = s => {
    const map = {
      admin:  ['Admins',     'rgba(59,130,246,.15)', '#2563eb', 'rgba(59,130,246,.3)'],
      proxy:  ['Proxy',      'rgba(168,85,247,.15)', '#9333ea', 'rgba(168,85,247,.3)'],
      both:   ['Ambos',      'rgba(34,197,94,.1)',   'var(--green)', 'rgba(34,197,94,.25)'],
    };
    const [label, bg, fg, br] = map[s] || map.both;
    return '<span style="display:inline-block;background:' + bg + ';color:' + fg + ';border:1px solid ' + br + ';border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600">' + label + '</span>';
  };
  const totpBadge = p => {
    const map = {
      required: ['Required',  '#dc2626'],
      optional: ['Optional',  'var(--text2)'],
      disabled: ['Disabled',  'var(--text3)'],
    };
    const [label, color] = map[p] || map.optional;
    return '<span style="font-size:11px;color:' + color + ';font-weight:600">' + label + '</span>';
  };
  const stateBadge = enabled => enabled
    ? '<span style="display:inline-block;background:rgba(34,197,94,.1);color:var(--green);border:1px solid rgba(34,197,94,.25);border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600">Active</span>'
    : '<span style="display:inline-block;background:rgba(148,163,184,.15);color:var(--text3);border:1px solid var(--border);border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600">Inactive</span>';

  tbody.innerHTML = configs.map(c =>
    '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:10px 12px;font-weight:500">' + esc(c.name) + '</td>' +
      '<td style="padding:10px 8px;font-family:\'SF Mono\',ui-monospace,monospace;font-size:11.5px;color:var(--text2);word-break:break-all;max-width:240px">' + esc(c.url) + '</td>' +
      '<td style="padding:10px 8px;font-family:\'SF Mono\',ui-monospace,monospace;font-size:11.5px;color:var(--text2);word-break:break-all;max-width:240px">' + esc(c.baseDn) + '</td>' +
      '<td style="padding:10px 8px">' + scopeBadge(c.scope) + '</td>' +
      '<td style="padding:10px 8px">' + totpBadge(c.totpPolicy) + '</td>' +
      '<td style="padding:10px 8px">' + stateBadge(c.enabled) + '</td>' +
      '<td style="padding:10px 12px;text-align:right;white-space:nowrap">' +
        '<button class="btn btn-sm" onclick="openEditLdapModal(' + c.id + ')" style="margin-right:4px">Edit</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="deleteLdapConfig(' + c.id + ',' + JSON.stringify(c.name) + ')" style="color:var(--err-text)">Delete</button>' +
      '</td>' +
    '</tr>'
  ).join('');
}

function _ldapResetForm() {
  document.getElementById('ldapEditId').value = '';
  document.getElementById('ldapName').value = '';
  document.getElementById('ldapUrl').value = '';
  document.getElementById('ldapBaseDn').value = '';
  document.getElementById('ldapBindDn').value = '';
  document.getElementById('ldapBindPassword').value = '';
  document.getElementById('ldapBindPassword').placeholder = '(opcional)';
  document.getElementById('ldapUserFilter').value = '';
  document.getElementById('ldapUsernameAttr').value = '';
  document.getElementById('ldapEmailAttr').value = '';
  document.getElementById('ldapFullnameAttr').value = '';
  document.getElementById('ldapGroupAttr').value = '';
  document.getElementById('ldapScope').value = 'both';
  document.getElementById('ldapTotpPolicy').value = 'optional';
  document.getElementById('ldapTimeoutMs').value = '5000';
  document.getElementById('ldapStartTls').checked = false;
  document.getElementById('ldapTlsVerify').checked = true;
  document.getElementById('ldapEnabled').checked = true;
  document.getElementById('ldapAdminGroups').value = '';
  document.getElementById('ldapDefaultProfile').value = '';
  document.getElementById('ldapAutoAdoptLocal').checked = false;
  document.getElementById('ldapTestLogin').value = '';
  const tr = document.getElementById('ldapTestResult');
  tr.style.display = 'none';
  tr.className = 'ldap-test-result';
  tr.innerHTML = '';
}

function openCreateLdapModal() {
  _ldapResetForm();
  document.getElementById('ldapModalTitle').textContent = 'Novo directory LDAP';
  document.getElementById('ldapSubmitBtn').textContent = 'Create';
  document.getElementById('ldapModal').classList.add('active');
}

function openEditLdapModal(id) {
  const c = _ldapConfigs.find(x => x.id === id);
  if (!c) return toast('Config not found', 'error');
  _ldapResetForm();
  document.getElementById('ldapEditId').value = String(c.id);
  document.getElementById('ldapName').value = c.name;
  document.getElementById('ldapUrl').value = c.url;
  document.getElementById('ldapBaseDn').value = c.baseDn;
  document.getElementById('ldapBindDn').value = c.bindDn || '';
  document.getElementById('ldapBindPassword').value = '';
  document.getElementById('ldapBindPassword').placeholder = '(deixar vazio para manter)';
  document.getElementById('ldapUserFilter').value = c.userFilter;
  document.getElementById('ldapUsernameAttr').value = c.usernameAttr;
  document.getElementById('ldapEmailAttr').value = c.emailAttr;
  document.getElementById('ldapFullnameAttr').value = c.fullnameAttr;
  document.getElementById('ldapGroupAttr').value = c.groupAttr;
  document.getElementById('ldapScope').value = c.scope;
  document.getElementById('ldapTotpPolicy').value = c.totpPolicy;
  document.getElementById('ldapTimeoutMs').value = String(c.timeoutMs);
  document.getElementById('ldapStartTls').checked = !!c.startTls;
  document.getElementById('ldapTlsVerify').checked = !!c.tlsVerify;
  document.getElementById('ldapEnabled').checked = !!c.enabled;
  document.getElementById('ldapAdminGroups').value = (c.adminGroups || []).join('\n');
  document.getElementById('ldapDefaultProfile').value = c.defaultProfile || '';
  document.getElementById('ldapAutoAdoptLocal').checked = !!c.autoAdoptLocal;
  document.getElementById('ldapModalTitle').textContent = 'Edit directory: ' + c.name;
  document.getElementById('ldapSubmitBtn').textContent = 'Save';
  document.getElementById('ldapModal').classList.add('active');
}

function closeLdapModal() {
  document.getElementById('ldapModal').classList.remove('active');
}

function _ldapCollectPayload(isEdit) {
  const name = document.getElementById('ldapName').value.trim();
  const url = document.getElementById('ldapUrl').value.trim();
  const baseDn = document.getElementById('ldapBaseDn').value.trim();
  if (!name) { toast('Name is required', 'error'); return null; }
  if (!url)  { toast('URL is required (ldap:// or ldaps://)', 'error'); return null; }
  if (!baseDn) { toast('Base DN is required', 'error'); return null; }

  const payload = {
    name, url, baseDn,
    bindDn: document.getElementById('ldapBindDn').value.trim(),
    userFilter: document.getElementById('ldapUserFilter').value.trim() || undefined,
    usernameAttr: document.getElementById('ldapUsernameAttr').value.trim() || undefined,
    emailAttr: document.getElementById('ldapEmailAttr').value.trim() || undefined,
    fullnameAttr: document.getElementById('ldapFullnameAttr').value.trim() || undefined,
    groupAttr: document.getElementById('ldapGroupAttr').value.trim() || undefined,
    scope: document.getElementById('ldapScope').value,
    totpPolicy: document.getElementById('ldapTotpPolicy').value,
    timeoutMs: parseInt(document.getElementById('ldapTimeoutMs').value, 10) || 5000,
    startTls: document.getElementById('ldapStartTls').checked,
    tlsVerify: document.getElementById('ldapTlsVerify').checked,
    enabled: document.getElementById('ldapEnabled').checked,
    adminGroups: document.getElementById('ldapAdminGroups').value
      .split('\n').map(s => s.trim()).filter(Boolean),
    defaultProfile: document.getElementById('ldapDefaultProfile').value.trim(),
    autoAdoptLocal: document.getElementById('ldapAutoAdoptLocal').checked,
  };
  // Only send bindPassword if the user typed one (avoids overwriting on edit)
  const pw = document.getElementById('ldapBindPassword').value;
  if (pw) payload.bindPassword = pw;
  else if (!isEdit) payload.bindPassword = ''; // explicit empty for create (anonymous bind)
  // Strip undefined so backend defaults apply on create
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
  return payload;
}

async function submitLdap() {
  const editId = document.getElementById('ldapEditId').value;
  const isEdit = !!editId;
  const payload = _ldapCollectPayload(isEdit);
  if (!payload) return;
  try {
    const path = isEdit ? '/admin/ldap/configs/' + encodeURIComponent(editId) : '/admin/ldap/configs';
    const res = await api(path, {
      method: isEdit ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'Failed', 'error');
    toast(isEdit ? 'Directory atualizado' : 'Directory criado');
    closeLdapModal();
    fetchLdapConfigs();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteLdapConfig(id, name) {
  if (!confirm('Delete directory "' + name + '"?\n\nAlready-provisioned LDAP users will lose their source — they won\'t be able to log in until you configure it again.')) return;
  try {
    const res = await api('/admin/ldap/configs/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return toast(data.error || 'Failed to delete', 'error');
    }
    toast('Directory apagado');
    fetchLdapConfigs();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function forceLdapSync() {
  const btn = document.getElementById('ldapSyncBtn');
  const out = document.getElementById('ldapSyncReport');
  const origText = btn ? btn.textContent : 'Sync now';
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  if (out) {
    out.style.display = 'block';
    out.innerHTML = 'Running sync against every active directory…';
  }
  try {
    const res = await api('/admin/ldap/sync', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (out) out.innerHTML = '<span style="color:var(--err-text)">Failed: ' + esc(data.error || 'unknown error') + '</span>';
      return;
    }
    const report = data.report || {};
    const cfgs = report.configs || [];
    if (cfgs.length === 0) {
      out.innerHTML = '<strong>Sync complete</strong> in ' + (report.durationMs || 0) + 'ms — no active directory.';
    } else {
      const rows = cfgs.map(c => {
        const errBits = (c.errors && c.errors.length)
          ? ' · <span style="color:var(--err-text)">' + c.errors.length + ' error(s)</span>'
          : '';
        return '<div style="padding:4px 0;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:12px">' +
          '<span><strong>' + esc(c.configName) + '</strong></span>' +
          '<span style="color:var(--text3)">' +
            c.users + ' user(s) · ' +
            c.groupsUpdated + ' updated · ' +
            c.revokedClients + ' tokens revoked · ' +
            c.orphans + ' orphan(s)' +
            errBits +
          '</span>' +
          '</div>';
      }).join('');
      out.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">' +
          '<strong>Sync complete</strong>' +
          '<span style="color:var(--text3);font-size:11.5px">' + (report.durationMs || 0) + 'ms</span>' +
        '</div>' + rows;
    }
    // Refresh table because orphan/sync status may have changed
    fetchLdapConfigs();
  } catch (e) {
    if (out) out.innerHTML = '<span style="color:var(--err-text)">Error: ' + esc(e.message) + '</span>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

function _ldapSetTestState(tr, state) {
  tr.classList.remove('is-ok', 'is-fail');
  if (state === 'ok') tr.classList.add('is-ok');
  else if (state === 'fail') tr.classList.add('is-fail');
}

async function testLdap() {
  const editId = document.getElementById('ldapEditId').value;
  const sampleLogin = document.getElementById('ldapTestLogin').value.trim();
  const tr = document.getElementById('ldapTestResult');
  const btn = document.getElementById('ldapTestBtn');
  tr.style.display = 'block';
  _ldapSetTestState(tr, '');
  tr.innerHTML = '<div class="ldap-test-title">Testing…</div>';
  btn.disabled = true;

  try {
    if (!editId) {
      _ldapSetTestState(tr, 'fail');
      tr.innerHTML = '<div class="ldap-test-title">Save first</div>' +
        '<div style="color:var(--text2)">Click <strong>Create</strong> and then reopen the directory to test the connection.</div>';
      return;
    }
    const res = await api('/admin/ldap/configs/' + encodeURIComponent(editId) + '/test', {
      method: 'POST',
      body: JSON.stringify(sampleLogin ? { sampleLogin } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      _ldapSetTestState(tr, 'fail');
      tr.innerHTML = '<div class="ldap-test-title">✗ HTTP Error ' + res.status + '</div>' +
        '<div style="color:var(--text2)">' + esc(data.error || '') + '</div>';
      return;
    }
    const stepsHtml = (data.steps || []).map(s =>
      '<div class="ldap-test-step ' + (s.ok ? 'ok' : 'fail') + '">' +
        '<span class="step-icon">' + (s.ok ? '✓' : '✗') + '</span>' +
        '<span><span class="step-name">' + esc(s.step) + '</span>' +
        (s.detail ? '<span class="step-detail">' + esc(s.detail) + '</span>' : '') +
        '</span>' +
      '</div>'
    ).join('');
    let sampleHtml = '';
    if (data.sample) {
      const rows = [];
      rows.push('<div><span class="sk">dn:</span>' + esc(data.sample.dn) + '</div>');
      for (const [k, v] of Object.entries(data.sample.attrs || {})) {
        const val = Array.isArray(v) ? v.join(', ') : String(v);
        rows.push('<div><span class="sk">' + esc(k) + ':</span>' + esc(val) + '</div>');
      }
      sampleHtml = '<div class="ldap-test-sample">' + rows.join('') + '</div>';
    }
    _ldapSetTestState(tr, data.ok ? 'ok' : 'fail');
    tr.innerHTML =
      '<div class="ldap-test-title">' + (data.ok ? '✓ Success' : '✗ Failed') +
      ' <span style="color:var(--text3);font-weight:500;margin-left:6px">' + (data.durationMs || 0) + 'ms</span></div>' +
      stepsHtml + sampleHtml;
  } catch (e) {
    _ldapSetTestState(tr, 'fail');
    tr.innerHTML = '<div class="ldap-test-title">✗ Error</div><div style="color:var(--text2)">' + esc(e.message) + '</div>';
  } finally {
    btn.disabled = false;
  }
}

// ─── LDAP adoption conflicts ───────────────────────────────────────────────
let _ldapcFilter = 'pending';

async function fetchLdapAdoptions() {
  try {
    const url = _ldapcFilter ? '/admin/ldap/adoptions?state=' + encodeURIComponent(_ldapcFilter) : '/admin/ldap/adoptions';
    const res = await api(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderLdapAdoptions(data.events || []);
    const badge = document.getElementById('ldapConflictsBtnBadge');
    if (badge) {
      const pending = Number(data.pending || 0);
      if (pending > 0) { badge.textContent = String(pending); badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    }
  } catch (e) {
    const body = document.getElementById('ldapcListBody');
    if (body) body.innerHTML =
      '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--err-text)">Error: ' + esc(e.message) + '</td></tr>';
  }
}

function openLdapConflictsModal() {
  document.getElementById('ldapConflictsModal').style.display = 'flex';
  filterLdapAdoptions('pending');
}

function closeLdapConflictsModal() {
  document.getElementById('ldapConflictsModal').style.display = 'none';
}

function filterLdapAdoptions(state) {
  _ldapcFilter = state;
  ['ldapcBtnPending','ldapcBtnConfirmed','ldapcBtnReverted','ldapcBtnAll'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.classList.remove('btn-primary');
  });
  const active = state === 'pending' ? 'ldapcBtnPending'
    : state === 'confirmed' ? 'ldapcBtnConfirmed'
    : state === 'reverted' ? 'ldapcBtnReverted'
    : 'ldapcBtnAll';
  const ae = document.getElementById(active);
  if (ae) ae.classList.add('btn-primary');
  fetchLdapAdoptions();
}

function renderLdapAdoptions(events) {
  const tbody = document.getElementById('ldapcListBody');
  if (!events.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--text3)">No records.</td></tr>';
    return;
  }
  const stateBadge = s => {
    const map = {
      pending:   ['Pending',   'rgba(234,179,8,.15)',  '#ca8a04'],
      confirmed: ['Confirmed', 'rgba(34,197,94,.1)',   'var(--green)'],
      reverted:  ['Reverted',  'rgba(148,163,184,.15)','var(--text3)'],
    };
    const [label, bg, fg] = map[s] || map.pending;
    return '<span style="display:inline-block;background:' + bg + ';color:' + fg + ';border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600">' + label + '</span>';
  };
  tbody.innerHTML = events.map(e => {
    const when = e.createdAt ? new Date(e.createdAt).toLocaleString() : '—';
    const actions = e.state === 'pending'
      ? '<button class="btn btn-sm btn-primary" onclick="confirmLdapAdoption(' + e.id + ')">Confirmar</button> ' +
        '<button class="btn btn-sm btn-ghost" onclick="revertLdapAdoption(' + e.id + ')" style="color:var(--err-text)">Reverter</button>'
      : '<span style="color:var(--text3);font-size:11.5px">—</span>';
    return '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:10px 12px;color:var(--text3);font-size:11.5px">' + esc(when) + '</td>' +
      '<td style="padding:10px 8px"><div style="font-weight:500">' + esc(e.previousUsername || '—') + '</div>' +
         '<div style="font-size:11.5px;color:var(--text3)">' + esc(e.previousEmail || '—') + '</div></td>' +
      '<td style="padding:10px 8px;color:var(--text2);font-size:12px">' + esc(e.matchedOn) + ': <code>' + esc(e.matchedValue) + '</code></td>' +
      '<td style="padding:10px 8px;font-family:\'SF Mono\',ui-monospace,monospace;font-size:11.5px;color:var(--text2);word-break:break-all;max-width:280px">' + esc(e.ldapDn) + '</td>' +
      '<td style="padding:10px 8px">' + stateBadge(e.state) + '</td>' +
      '<td style="padding:10px 12px;text-align:right;white-space:nowrap">' + actions + '</td>' +
    '</tr>';
  }).join('');
}

async function confirmLdapAdoption(id) {
  if (!confirm('Confirm this adoption? The local account becomes permanently replaced by the LDAP identity.')) return;
  try {
    const res = await api('/admin/ldap/adoptions/' + encodeURIComponent(id) + '/confirm', { method: 'POST' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'Failed', 'error'); }
    toast('Adoption confirmed');
    fetchLdapAdoptions();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function revertLdapAdoption(id) {
  if (!confirm('Revert? The local account goes back to its previous state (original username, email and password hash). The LDAP identity will need to be registered manually on another user — sessions and tokens get revoked.')) return;
  try {
    const res = await api('/admin/ldap/adoptions/' + encodeURIComponent(id) + '/revert', { method: 'POST' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'Failed', 'error'); }
    toast('Adoption reverted');
    fetchLdapAdoptions();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── Consent pages ──────────────────────────────────────────────────────────
let _consentPages = [];
let _editingConsentPageId = null;

async function fetchConsentPages() {
  try {
    const res = await api('/admin/consent-pages');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { pages } = await res.json();
    _consentPages = pages || [];
    renderConsentPages(_consentPages);
    const badge = document.getElementById('navConsentBadge');
    if (badge) badge.textContent = String(_consentPages.length);
  } catch (e) {
    const tbody = document.getElementById('consentPagesListBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="padding:40px;text-align:center;color:var(--err-text)">Error: ' + esc(e.message) + '</td></tr>';
  }
}

function renderConsentPages(pages) {
  const tbody = document.getElementById('consentPagesListBody');
  if (!tbody) return;
  if (!pages.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:40px;text-align:center;color:var(--text3)">No pages yet — create the first one to reference it from clients or profiles.</td></tr>';
    return;
  }
  tbody.innerHTML = pages.map(p => {
    const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '—';
    return '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:10px 12px;font-family:\'SF Mono\',ui-monospace,monospace;font-size:12px;font-weight:500">' + esc(p.name) + '</td>' +
      '<td style="padding:10px 8px">' + esc(p.title || '—') + '</td>' +
      '<td style="padding:10px 8px;color:var(--text3);font-size:11.5px">' + esc(updated) + '</td>' +
      '<td style="padding:10px 12px;text-align:right;white-space:nowrap">' +
        '<button class="btn btn-sm" onclick="openEditConsentPageModal(' + p.id + ')" style="margin-right:4px">Edit</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="deleteConsentPage(' + p.id + ',' + JSON.stringify(p.name).replace(/"/g, '&quot;') + ')" style="color:var(--err-text)">Delete</button>' +
      '</td>' +
      '</tr>';
  }).join('');
}

/** Tiny safe markdown renderer for the live preview only.
 *  Backend renderConsentMarkdown is authoritative for what users see. */
function renderConsentMarkdownPreview(src) {
  if (!src) return '';
  const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = src.split(/\r?\n/);
  const out = [];
  let listOpen = false, paraBuf = [];
  const flushPara = () => { if (paraBuf.length) { out.push('<p>' + inline(paraBuf.join(' ')) + '</p>'); paraBuf = []; } };
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  function inline(text) {
    let t = escapeHtml(text);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return t;
  }
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (!trimmed) { closeList(); flushPara(); continue; }
    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      if (!listOpen) { out.push('<ul style="margin:0 0 8px;padding-left:18px">'); listOpen = true; }
      out.push('<li>' + inline(trimmed.replace(/^[-*]\s+/, '')) + '</li>');
    } else {
      closeList();
      paraBuf.push(trimmed);
    }
  }
  closeList();
  flushPara();
  return out.join('');
}

function renderConsentPagePreview() {
  const title = document.getElementById('consentPageTitle').value || '';
  const body = document.getElementById('consentPageBody').value || '';
  document.getElementById('consentPagePreviewTitle').textContent = title || ' ';
  document.getElementById('consentPagePreviewBody').innerHTML = renderConsentMarkdownPreview(body) || '<span style="color:var(--text3)">Preview appears here.</span>';
}

function openCreateConsentPageModal() {
  _editingConsentPageId = null;
  document.getElementById('consentPageName').value = '';
  document.getElementById('consentPageTitle').value = '';
  document.getElementById('consentPageBody').value = '';
  document.getElementById('consentPageModalTitle').textContent = 'New page';
  document.getElementById('consentPageSubmitBtn').textContent = 'Create';
  renderConsentPagePreview();
  document.getElementById('consentPageModal').style.display = 'flex';
}

function openEditConsentPageModal(id) {
  const page = _consentPages.find(p => p.id === id);
  if (!page) return toast('Page not found', 'error');
  _editingConsentPageId = id;
  document.getElementById('consentPageName').value = page.name || '';
  document.getElementById('consentPageTitle').value = page.title || '';
  document.getElementById('consentPageBody').value = page.body || '';
  document.getElementById('consentPageModalTitle').textContent = 'Edit — ' + page.name;
  document.getElementById('consentPageSubmitBtn').textContent = 'Save';
  renderConsentPagePreview();
  document.getElementById('consentPageModal').style.display = 'flex';
}

function closeConsentPageModal() {
  document.getElementById('consentPageModal').style.display = 'none';
  _editingConsentPageId = null;
}

async function submitConsentPage() {
  const name = document.getElementById('consentPageName').value.trim();
  const title = document.getElementById('consentPageTitle').value;
  const body = document.getElementById('consentPageBody').value;
  if (!name) return toast('Name is required', 'error');
  const payload = { name, title, body };
  try {
    const url = _editingConsentPageId
      ? '/admin/consent-pages/' + _editingConsentPageId
      : '/admin/consent-pages';
    const method = _editingConsentPageId ? 'PUT' : 'POST';
    const res = await api(url, { method, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'Failed to save', 'error');
    toast(_editingConsentPageId ? 'Page updated' : 'Page created');
    closeConsentPageModal();
    fetchConsentPages();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteConsentPage(id, name) {
  if (!confirm('Delete page "' + name + '"?')) return;
  try {
    const res = await api('/admin/consent-pages/' + id, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && Array.isArray(data.references)) {
      const list = data.references.map(r => '• [' + r.kind + '] ' + r.name).join('\n');
      return toast('In use by:\n' + list, 'error');
    }
    if (!res.ok) return toast(data.error || 'Failed to delete', 'error');
    toast('Page deleted');
    fetchConsentPages();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

