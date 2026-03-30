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
  if (profiles.length === 0) { c.innerHTML = '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text3)">No profiles yet. Click "+ New Profile".</td></tr>'; return; }
  c.innerHTML = profiles.map(p => {
    const hasAuth = p.authHeader;
    const authVal = hasAuth
      ? esc(p.authHeader) + (p.authPrefix ? ` <span style="color:var(--text3)">(${esc(p.authPrefix)})</span>` : '')
      : '<span style="color:var(--text3)">Passthrough</span>';
    const accessBadge = p.hasAccessKey
      ? '<span style="background:var(--orange-bg);color:var(--orange);padding:2px 8px;border-radius:4px;font-size:11px">Protected</span>'
      : '<span style="color:var(--text3)">Public</span>';
    const blockedVal = p.blockedExtensions?.length
      ? `<span style="color:var(--red)">${esc(p.blockedExtensions.join(', '))}</span>`
      : '<span style="color:var(--text3)">None</span>';
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
  <td style="padding:8px 12px;font-weight:600">${esc(p.name)}</td>
  <td style="padding:8px;font-family:'SF Mono',Monaco,monospace;color:var(--accent2)">${p.port || '<span style="color:var(--text3)">N/A</span>'}</td>
  <td style="padding:8px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'SF Mono',Monaco,monospace;color:var(--text2)" title="${esc(p.targetUrl)}">${esc(p.targetUrl)}</td>
  <td style="padding:8px">${authVal}</td>
  <td style="padding:8px">${accessBadge}</td>
  <td style="padding:8px">${blockedVal}</td>
  <td style="padding:8px 12px">
    <div style="display:flex;gap:6px;justify-content:flex-end">
      ${p.port ? `<a class="btn btn-sm" href="${location.protocol}//${location.hostname}:${p.port}/" target="_blank" style="text-decoration:none">Open :${p.port}</a>` : ''}
      <button class="btn btn-sm" onclick="copyProxyUrl('${esc(p.name)}', ${p.port || 0})">Copy URL</button>
      ${p.hasAccessKey ? `<button class="btn btn-sm" onclick="copyProfileCredential('${esc(p.name)}')">Copy Key</button>` : ''}
      <button class="btn btn-sm" onclick="editProfile('${esc(p.name)}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="deleteProfile('${esc(p.name)}')">Delete</button>
    </div>
  </td>
</tr>`;
  }).join('');
}

// ─── Profile CRUD ────────────────────────────────────────────────────────────
function openProfileModal(profile = null) {
  editingProfile = profile;
  document.getElementById('modalTitle').textContent = profile ? 'Edit Profile' : 'New Profile';
  document.getElementById('pName').value = profile ? profile.name : ''; document.getElementById('pName').disabled = !!profile;
  document.getElementById('pTargetUrl').value = profile ? profile.targetUrl : '';
  document.getElementById('pApiKey').value = profile ? (profile.apiKey || '') : '';
  document.getElementById('pAuthHeader').value = profile ? (profile.authHeader || '') : '';
  document.getElementById('pAuthPrefix').value = profile ? (profile.authPrefix || '') : '';
  document.getElementById('pAccessKey').value = profile ? (profile.accessKey || '') : '';
  document.getElementById('pBlocked').value = profile?.blockedExtensions ? profile.blockedExtensions.join(', ') : '';
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
  try {
    const res = await api('/admin/profiles', { method: 'POST', body: JSON.stringify(body) }); const d = await res.json();
    if (res.ok) { toast('Profile ' + (d.status || 'saved')); closeProfileModal(); await fetchProfiles(); }
    else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function editProfile(name) {
  try { const res = await api('/admin/profiles/' + encodeURIComponent(name)); if (!res.ok) return toast('Not found', 'error'); openProfileModal((await res.json()).profile); } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function deleteProfile(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try { const res = await api('/admin/profiles/' + encodeURIComponent(name), { method: 'DELETE' }); if (res.ok) { toast('Deleted'); await fetchProfiles(); } } catch (e) { toast('Error: ' + e.message, 'error'); }
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
    if (res.ok) { toast('Reloaded: ' + (d.profiles || []).join(', ')); await fetchProfiles(); } else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
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
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
  <td style="padding:8px 12px;font-weight:600">${esc(t.name)}</td>
  <td style="padding:8px">${statusBadge}</td>
  <td style="padding:8px;font-family:'SF Mono',Monaco,monospace;color:var(--accent2)">${t.port}</td>
  <td style="padding:8px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'SF Mono',Monaco,monospace;color:var(--text2)" title="${esc(t.targetUrl)}">${esc(t.targetUrl)}</td>
  <td style="padding:8px">${t.forwardPath ? '<span style="color:var(--green)">Yes</span>' : '<span style="color:var(--text3)">No</span>'}</td>
  <td style="padding:8px">${authBadge}</td>
  <td style="padding:8px;color:var(--accent2)">${t.active > 0 ? t.active : '<span style="color:var(--text3)">0</span>'}</td>
  <td style="padding:8px 12px">
    <div style="display:flex;gap:6px;justify-content:flex-end">
      <button class="btn btn-sm" onclick="restartTargetAction('${esc(t.name)}')">Restart</button>
      ${t.hasAuth ? `<button class="btn btn-sm" onclick="copyTargetCredential('${esc(t.name)}')">Copy Token</button>` : ''}
      <button class="btn btn-sm" onclick="editTarget('${esc(t.name)}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="deleteTarget('${esc(t.name)}')">Delete</button>
    </div>
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
  document.getElementById('targetModal').style.display = 'block';
}
function closeTargetModal() { document.getElementById('targetModal').style.display = 'none'; editingTarget = null; }
async function saveTarget() {
  const body = { name: document.getElementById('tName').value.trim(), targetUrl: document.getElementById('tTargetUrl').value.trim(), port: parseInt(document.getElementById('tPort').value) || 0, forwardPath: document.getElementById('tForwardPath').checked };
  const at = document.getElementById('tAuthToken').value.trim(); if (at) body.authToken = at;
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
let editingWebhook = null;

async function fetchWebhooks() {
  try {
    const res = await api('/admin/webhooks'); if (!res.ok) return;
    const d = await res.json();
    _allWebhooks = d.webhooks || [];
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
    const numTargets = w.targets.length;
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
  <td style="padding:8px 12px;font-weight:600">${esc(w.name)}</td>
  <td style="padding:8px">${statusBadge}</td>
  <td style="padding:8px;font-family:'SF Mono',Monaco,monospace;color:var(--accent2)">${w.port}</td>
  <td style="padding:8px;color:var(--text2)">${numTargets} destinations</td>
  <td style="padding:8px">${authBadge}</td>
  <td style="padding:8px;color:var(--accent2)">${w.active > 0 ? w.active : '<span style="color:var(--text3)">0</span>'}</td>
  <td style="padding:8px 12px">
    <div style="display:flex;gap:6px;justify-content:flex-end">
      <button class="btn btn-sm" onclick="viewWebhookLogs('${esc(w.name)}')">Logs</button>
      <button class="btn btn-sm" onclick="restartWebhookAction('${esc(w.name)}')">Restart</button>
      <button class="btn btn-sm" onclick="editWebhook('${esc(w.name)}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="deleteWebhook('${esc(w.name)}')">Delete</button>
    </div>
  </td>
</tr>`;
  }).join('');
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

function syntaxHighlightTemplate(code) {
    if (!code) return '';
    let html = esc(code);
    
    // Highlight Template Variables {{ ... }}
    html = html.replace(/(\{\{[\s]*[a-zA-Z0-9_.-]+[\s]*\}\})/g, '<span style="color:var(--accent);font-weight:600;background:rgba(0,120,212,0.1);padding:0 2px;border-radius:2px">$1</span>');
    // Highlight JSON Keys "key":
    html = html.replace(/(&quot;[a-zA-Z0-9_.-]+&quot;)(?=\s*:)/g, '<span style="color:#4ec9b0">$1</span>');
    // Highlight JSON Strings "value"
    html = html.replace(/:\s*(&quot;.*?&quot;)(?![\w])/g, ': <span style="color:#ce9178">$1</span>');
    // Highlight JSON Numbers/Booleans/Null
    html = html.replace(/:\s*([0-9.]+|true|false|null)(?![\w])/g, ': <span style="color:#b5cea8">$1</span>');
    // Re-highlight templates that might have been caught inside strings
    html = html.replace(/(<span style="color:#ce9178">&quot;.*?)(\{\{[\s]*[a-zA-Z0-9_.-]+[\s]*\}\})(.*?&quot;<\/span>)/g, '$1</span><span style="color:var(--accent);font-weight:600;background:rgba(0,120,212,0.1);padding:0 2px;border-radius:2px">$2</span><span style="color:#ce9178">$3');
    
    return html;
}

function updateSyntaxEditor(index, value) {
    const pre = document.getElementById(`preBody_${index}`);
    if (pre) {
        pre.innerHTML = syntaxHighlightTemplate(value);
    }
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
        const res = await api('/admin/requests?type=webhook&limit=1');
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

function addWebhookTarget(target = "") {
  if (typeof target === 'string') {
    webhookTargetState.push({ type: 'basic', url: target, method: 'POST', bodyTemplate: '', customHeaders: [], forwardHeaders: false });
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
      forwardHeaders: target.forwardHeaders === true
    });
  }
  renderWebhookTargets();
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

            <div>
              <div style="display:grid; border-radius:4px; border:1px solid var(--border); background:#1e1e1e; font-size:12px; font-family:monospace; line-height:1.5;">
                <pre id="preBody_${i}" style="grid-area: 1 / 1 / 2 / 2; margin:0; padding:8px; box-sizing:border-box; color:#d4d4d4; white-space:pre-wrap; word-wrap:break-word; overflow:hidden; pointer-events:none;">${syntaxHighlightTemplate(t.bodyTemplate)}</pre>
                <textarea placeholder='Body Template (JSON)\\nExample: {"id": "{{data.id}}"}\\nDefaults to original payload if left empty' oninput="updateWebhookTargetField(${i}, 'bodyTemplate', this.value); updateSyntaxEditor(${i}, this.value)" onscroll="document.getElementById('preBody_'+${i}).scrollTop = this.scrollTop" style="grid-area: 1 / 1 / 2 / 2; margin:0; padding:8px; box-sizing:border-box; background:transparent; color:transparent; caret-color:#fff; border:none; outline:none; resize:vertical; min-height:80px;" spellcheck="false">${esc(t.bodyTemplate)}</textarea>
              </div>
              <div id="previewBody_${i}" style="display:none;font-size:10px;color:var(--accent);margin-top:2px;margin-left:4px;white-space:pre-wrap;font-family:monospace"></div>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `}).join('');

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
  document.getElementById('webhookModal').style.display = 'block';
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
          targetsRaw.push({
              url: t.url.trim(),
              method: t.method || 'POST',
              customHeaders: headersObj,
              forwardHeaders: t.forwardHeaders,
              bodyTemplate: t.bodyTemplate.trim() || undefined
          });
      }
  }

  const body = { 
    name: document.getElementById('wName').value.trim(), 
    port: parseInt(document.getElementById('wPort').value) || 0, 
    targets: targetsRaw 
  };
  if (targetsRaw.length === 0) return toast('At least one valid destination is required', 'error');
  const at = document.getElementById('wAuthToken').value.trim(); if (at) body.authToken = at;
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
  try { const res = await api('/admin/webhooks/' + encodeURIComponent(name) + '/restart', { method: 'POST' }); if ((await res.json()).status) { toast('Restarted "' + name + '"'); await fetchWebhooks(); } } catch (e) { toast('Error: ' + e.message, 'error'); }
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
