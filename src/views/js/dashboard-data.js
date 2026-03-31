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
IpTagInput.init('tAllowedIps');
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
  } else if (type === 'target') {
    const t = _allTargets.find(x => x.name === name);
    if (!t) return;
    showActionMenu(btn, [
      { label: 'Restart', fn: () => restartTargetAction(name) },
      t.hasAuth ? { label: 'Copy Token', fn: () => copyTargetCredential(name) } : null,
      { label: 'Edit', fn: () => editTarget(name) },
      '---',
      { label: 'Delete', fn: () => deleteTarget(name), danger: true },
    ]);
  } else if (type === 'profile') {
    const p = _allProfiles.find(x => x.name === name);
    if (!p) return;
    showActionMenu(btn, [
      p.port ? { label: `Open :${p.port}`, fn: () => window.open(`${location.protocol}//${location.hostname}:${p.port}/`, '_blank') } : null,
      { label: 'Copy URL', fn: () => copyProxyUrl(p.name, p.port || 0) },
      p.hasAccessKey ? { label: 'Copy Key', fn: () => copyProfileCredential(p.name) } : null,
      { label: 'Restart', fn: () => restartProfileAction(p.name) },
      { label: 'Edit', fn: () => editProfile(p.name) },
      '---',
      { label: 'Delete', fn: () => deleteProfile(p.name), danger: true },
    ]);
  }
}

// ─── Data Fetch ──────────────────────────────────────────────────────────────
async function refreshAll() {
  await Promise.all([fetchHealth(), fetchConfig(), fetchProfiles(), fetchTargets(), fetchWebhooks(), fetchRequestLogStats(), fetchRecentRequests(), fetchChartData()]);
}

async function fetchHealth() {
  try {
    const res = await fetch('/health'); const d = await res.json();
    document.getElementById('navDot').className = 'status-dot online';
    document.getElementById('navStatus').textContent = 'Online';
    document.getElementById('navUptime').textContent = fmtUptime(d.uptime);
    document.getElementById('ovStatus').textContent = 'Online';
    document.getElementById('ovStatus').style.color = 'var(--green)';
    document.getElementById('ovUptime').textContent = 'Uptime: ' + fmtUptime(d.uptime);
    document.getElementById('ovActive').textContent = d.activeRequests;
    document.getElementById('ovProfiles').textContent = (d.proxyProfiles || 0) + (d.proxyTargets || 0);
    document.getElementById('ovWebhooks').textContent = d.webhooks || 0;
  } catch {
    document.getElementById('navDot').className = 'status-dot offline';
    document.getElementById('navStatus').textContent = 'Offline';
    document.getElementById('navUptime').textContent = '';
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
        : '<span style="background:var(--blue-bg);color:var(--blue);padding:2px 8px;border-radius:4px;font-size:11px">target' + (r.targetName ? ' / ' + esc(r.targetName) : '') + '</span>';
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
    const accessBadge = p.hasAccessKey
      ? '<span style="background:var(--orange-bg);color:var(--orange);padding:2px 8px;border-radius:4px;font-size:11px">Protected</span>'
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
function openProfileModal(profile = null) {
  editingProfile = profile;
  document.getElementById('modalTitle').textContent = profile ? 'Edit Proxy' : 'New Proxy';
  document.getElementById('pName').value = profile ? profile.name : ''; document.getElementById('pName').disabled = !!profile;
  document.getElementById('pTargetUrl').value = profile ? profile.targetUrl : '';
  document.getElementById('pApiKey').value = profile ? (profile.apiKey || '') : '';
  document.getElementById('pAuthHeader').value = profile ? (profile.authHeader || '') : '';
  document.getElementById('pAuthPrefix').value = profile ? (profile.authPrefix || '') : '';
  document.getElementById('pAccessKey').value = profile ? (profile.accessKey || '') : '';
  document.getElementById('pBlocked').value = profile?.blockedExtensions ? profile.blockedExtensions.join(', ') : '';
  IpTagInput.setValue('pAllowedIps', profile?.allowedIps || []);
  document.getElementById('profileModal').classList.add('active');
}
function closeProfileModal() { document.getElementById('profileModal').classList.remove('active'); editingProfile = null; }
async function saveProfile() {
  const body = { name: document.getElementById('pName').value.trim(), targetUrl: document.getElementById('pTargetUrl').value.trim() };
  const v = (id) => document.getElementById(id).value.trim();
  if (v('pApiKey')) body.apiKey = v('pApiKey');
  if (v('pAuthHeader')) body.authHeader = v('pAuthHeader');
  if (v('pAuthPrefix')) body.authPrefix = v('pAuthPrefix');
  if (v('pAccessKey')) body.accessKey = v('pAccessKey');
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
async function copyTargetCredential(name) {
  try {
    const res = await api('/admin/targets/' + encodeURIComponent(name));
    if (!res.ok) return toast('Not found', 'error');
    const { target } = await res.json();
    const token = target.authToken;
    if (!token) return toast('No auth token set', 'error');
    navigator.clipboard.writeText(token).then(() => toast('Auth token copied')).catch(() => prompt('Copy:', token));
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

// ─── Target CRUD ─────────────────────────────────────────────────────────────
async function fetchTargets() {
  try { const res = await api('/admin/targets'); if (!res.ok) return; const d = await res.json(); _allTargets = d.targets || []; filterTargets(); document.getElementById('navTargetBadge').textContent = _allTargets.length; } catch { }
}

function filterTargets() {
  const search = (document.getElementById('targetSearch')?.value || '').toLowerCase();
  const statusF = document.getElementById('targetStatusFilter')?.value || '';
  const authF = document.getElementById('targetAuthFilter')?.value || '';
  const filtered = _allTargets.filter(t => {
    if (search && !t.name.toLowerCase().includes(search) && !t.targetUrl.toLowerCase().includes(search)) return false;
    if (statusF === 'running' && !t.running) return false;
    if (statusF === 'stopped' && t.running) return false;
    if (authF === 'enabled' && !t.hasAuth) return false;
    if (authF === 'disabled' && t.hasAuth) return false;
    return true;
  });
  renderTargets(filtered);
}
function renderTargets(targets) {
  const c = document.getElementById('targetListBody');
  if (targets.length === 0) { c.innerHTML = '<tr><td colspan="8" style="padding:40px;text-align:center;color:var(--text3)">No targets yet. Click "+ New Target".</td></tr>'; return; }
  c.innerHTML = targets.map(t => {
    const statusBadge = t.running
      ? '<span style="background:var(--green-bg);color:var(--green);padding:2px 8px;border-radius:4px;font-size:11px">Running</span>'
      : '<span style="background:var(--red-bg);color:var(--red);padding:2px 8px;border-radius:4px;font-size:11px">Stopped</span>';
    const authBadge = t.hasAuth
      ? '<span style="color:var(--green)">Enabled</span>'
      : '<span style="color:var(--text3)">Disabled</span>';
    const tIpBadge = (t.allowedIps && t.allowedIps.length)
      ? `<span style="background:var(--surface2);color:var(--text2);padding:2px 6px;border-radius:4px;font-size:11px;margin-left:4px" title="${esc(t.allowedIps.join(', '))}">IP restricted</span>`
      : '';
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
  <td style="padding:8px 12px;font-weight:600">${esc(t.name)}</td>
  <td style="padding:8px">${statusBadge}</td>
  <td style="padding:8px;font-family:'SF Mono',Monaco,monospace;color:var(--accent2)">${t.port}</td>
  <td style="padding:8px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'SF Mono',Monaco,monospace;color:var(--text2)" title="${esc(t.targetUrl)}">${esc(t.targetUrl)}</td>
  <td style="padding:8px">${t.forwardPath ? '<span style="color:var(--green)">Yes</span>' : '<span style="color:var(--text3)">No</span>'}</td>
  <td style="padding:8px">${authBadge}${tIpBadge}</td>
  <td style="padding:8px;color:var(--accent2)">${t.active > 0 ? t.active : '<span style="color:var(--text3)">0</span>'}</td>
  <td style="padding:8px 12px;text-align:right">
    <button data-type="target" data-name="${esc(t.name)}" onclick="showContextMenu(event,this)" style="background:none;border:1px solid var(--border);border-radius:6px;padding:2px 10px;cursor:pointer;color:var(--text2);font-size:18px;line-height:1.2;letter-spacing:1px" title="Actions">&#8942;</button>
  </td>
</tr>`;
  }).join('');
}
function openTargetModal(target = null) {
  editingTarget = target;
  document.getElementById('targetModalTitle').textContent = target ? 'Edit Target' : 'New Target';
  document.getElementById('tName').value = target ? target.name : ''; document.getElementById('tName').disabled = !!target;
  document.getElementById('tTargetUrl').value = target ? target.targetUrl : '';
  document.getElementById('tPort').value = target ? target.port : '';
  document.getElementById('tAuthToken').value = target ? (target.authToken || '') : '';
  document.getElementById('tForwardPath').checked = target ? target.forwardPath !== false : true;
  IpTagInput.setValue('tAllowedIps', target?.allowedIps || []);
  document.getElementById('targetModal').style.display = 'block';
}
function closeTargetModal() { document.getElementById('targetModal').style.display = 'none'; editingTarget = null; }
async function saveTarget() {
  const body = { name: document.getElementById('tName').value.trim(), targetUrl: document.getElementById('tTargetUrl').value.trim(), port: parseInt(document.getElementById('tPort').value) || 0, forwardPath: document.getElementById('tForwardPath').checked };
  const at = document.getElementById('tAuthToken').value.trim(); if (at) body.authToken = at;
  const tIps = IpTagInput.getValue('tAllowedIps'); if (tIps.length) body.allowedIps = tIps;
  try {
    const res = await api('/admin/targets', { method: 'POST', body: JSON.stringify(body) }); const d = await res.json();
    if (res.ok) { toast('Target ' + (d.status || 'saved')); closeTargetModal(); await fetchTargets(); } else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function editTarget(name) {
  try { const res = await api('/admin/targets/' + encodeURIComponent(name)); if (!res.ok) return toast('Not found', 'error'); openTargetModal((await res.json()).target); } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function deleteTarget(name) {
  if (!confirm('Delete target "' + name + '"?')) return;
  try { const res = await api('/admin/targets/' + encodeURIComponent(name), { method: 'DELETE' }); if (res.ok) { toast('Deleted'); await fetchTargets(); } } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function restartTargetAction(name) {
  try { const res = await api('/admin/targets/' + encodeURIComponent(name) + '/restart', { method: 'POST' }); if ((await res.json()).status) { toast('Restarted "' + name + '"'); await fetchTargets(); } } catch (e) { toast('Error: ' + e.message, 'error'); }
}

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
    webhookTargetState.push({ type: 'basic', url: target, method: 'POST', bodyTemplate: '', customHeaders: [], forwardHeaders: false, retry: null, retryOpen: false });
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
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                <span style="font-size:11px;color:var(--text2)">Body Template (JSON)</span>
                <button onclick="openBodyEditor(${i})" class="btn" style="padding:2px 6px;font-size:10px;display:flex;align-items:center;gap:4px">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
                  Expand
                </button>
              </div>
              <div id="aceBody_${i}" style="width:100%; min-height:100px; border-radius:4px; border:1px solid var(--border);"></div>
              <div style="font-size:10px;color:var(--text3);margin-top:3px;margin-left:2px">Supports JSON + <code style="background:rgba(0,120,212,0.15);padding:1px 4px;border-radius:3px;color:var(--accent);font-size:10px">{{template.vars}}</code></div>
              <div id="previewBody_${i}" style="display:none;font-size:10px;color:var(--accent);margin-top:2px;margin-left:4px;white-space:pre-wrap;font-family:monospace"></div>
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
                <label style="font-size:10px;color:var(--text3);display:block;margin-bottom:2px">Max retries</label>
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
              <input type="checkbox" ${t.retry?.retryUntilSuccess ? 'checked' : ''} onchange="updateTargetRetry(${i},'retryUntilSuccess',this.checked);document.getElementById('tRetryOnRow_${i}').style.display=this.checked?'none':'flex'">
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
              bodyTemplate: t.bodyTemplate.trim() || undefined
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
      return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
        <td style="padding:10px 16px;color:var(--text2)">${ts}</td>
        <td style="padding:10px 16px">${statusHtml}</td>
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
