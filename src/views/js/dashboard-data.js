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
IpTagInput.init('wTargetAllowedCidrs');

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
    const pendingCount = _pendingByWebhook[name] || 0;
    const npmAvailable = Array.isArray(_npmHostsAll) && _npmHostsAll.length > 0;
    const canLinkNpm = !w.npmProxyHostId && npmAvailable;
    showActionMenu(btn, [
      dlqCount > 0 ? { label: `Failed deliveries (${dlqCount})`, fn: () => openDlqModal(name), danger: true } : null,
      pendingCount > 0 ? { label: `Pending retries (${pendingCount})`, fn: () => openPendingRetryModal(name) } : null,
      { label: 'View Logs', fn: () => viewWebhookLogs(name) },
      { label: 'Restart', fn: () => restartWebhookAction(name) },
      { label: 'Edit', fn: () => editWebhook(name) },
      canLinkNpm ? { label: 'Link to NPM host…', fn: () => openLinkToNpmModalForWebhook(name) } : null,
      '---',
      { label: 'Delete', fn: () => deleteWebhook(name), danger: true },
    ]);
  } else if (type === 'profile') {
    const p = _allProfiles.find(x => x.name === name);
    if (!p) return;
    const authMode = p.authMode || (p.hasAccessKey ? 'accessKey' : 'none');
    const npmAvailable = Array.isArray(_npmHostsAll) && _npmHostsAll.length > 0;
    const canLinkNpm = !p.npmProxyHostId && npmAvailable;
    showActionMenu(btn, [
      p.port ? { label: `Open :${p.port}`, fn: () => window.open(`${location.protocol}//${location.hostname}:${p.port}/`, '_blank') } : null,
      { label: 'Copy URL', fn: () => copyProxyUrl(p.name, p.port || 0) },
      authMode === 'accessKey' && p.hasAccessKey ? { label: 'Copy Key', fn: () => copyProfileCredential(p.name) } : null,
      authMode === 'login' ? { label: 'Manage Users', fn: () => openProxyUsersModal(p.name) } : null,
      { label: 'Restart', fn: () => restartProfileAction(p.name) },
      { label: 'Edit', fn: () => editProfile(p.name) },
      canLinkNpm ? { label: 'Link to NPM host…', fn: () => openLinkToNpmModal(p.name) } : null,
      '---',
      { label: 'Delete', fn: () => deleteProfile(p.name), danger: true },
    ]);
  } else if (type === 'proxyUser') {
    const id = Number(btn.dataset.id);
    const u = _allProxyUsers.find(x => x.id === id);
    if (!u) return;
    showActionMenu(btn, [
      { label: 'Edit', fn: () => openEditProxyUserModal(u.id) },
      { label: 'Resources', fn: () => openUserResourcesModal(u.id, u.username) },
      { label: 'Reset password', fn: () => sendPasswordReset(u.id, u.username) },
      u.totpEnabled
        ? { label: 'Disable 2FA', fn: () => disable2fa(u.id, u.username) }
        : (u.force2faSetup ? null : { label: 'Force 2FA', fn: () => force2fa(u.id, u.username) }),
      '---',
      { label: 'Delete', fn: () => deleteProxyUserAction(u.id, u.username), danger: true },
    ]);
  }
}

// ─── Data Fetch ──────────────────────────────────────────────────────────────
async function refreshAll() {
  await Promise.all([fetchHealth(), fetchConfig(), fetchProfiles(), fetchWebhooks(), fetchConnectors(), fetchSipProxies(), fetchProxyUsers(), fetchInvites(), fetchRequestLogStats(), fetchRecentRequests(), fetchChartData(), fetchOauthClients(), fetchConsentPages(), fetchLdapConfigs(), fetchLdapAdoptions()]);
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
    document.getElementById('ovActive').textContent = (typeof d.activeRequests === 'number') ? d.activeRequests : '—';
    document.getElementById('ovProfiles').textContent = (typeof d.proxyProfiles === 'number') ? d.proxyProfiles : '—';
    document.getElementById('ovWebhooks').textContent = (typeof d.webhooks === 'number') ? d.webhooks : '—';
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
    // Toggle "Import from NPM" button based on integration state, and preload
    // the NPM hosts list so we can show "possible NPM" hints next to unlinked
    // profiles whose forward target matches a known NPM proxy host.
    try {
      const ns = await api('/admin/npm');
      if (ns.ok) {
        const data = await ns.json();
        const importBtn = document.getElementById('npmImportBtn');
        const enabled = !!(data.npm && data.npm.enabled);
        if (importBtn) importBtn.style.display = enabled ? '' : 'none';
        if (enabled) {
          try {
            const hr = await api('/admin/npm/proxy-hosts');
            if (hr.ok) {
              const hd = await hr.json();
              _npmHostsAll = hd.hosts || [];
              filterProfiles();
            }
          } catch { /* ignore */ }
        } else {
          _npmHostsAll = [];
        }
      }
    } catch { /* ignore */ }
  } catch { }
}

async function linkProfileToNpmHost(profileName, hostId, opts) {
  opts = opts || {};
  if (!opts.skipConfirm) {
    const msg = 'Vincular "' + profileName + '" ao host NPM #' + hostId
      + '? O NPM passará a encaminhar tráfego para o Midleman (em vez do backend directamente).';
    if (!(await showConfirm({ title: 'Vincular ao NPM', message: msg, confirmText: 'Vincular' }))) return;
  }
  try {
    const res = await api('/admin/npm/link-profile', {
      method: 'POST',
      body: JSON.stringify({ profileName, hostId, force: !!opts.force }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Mismatch path: ask the user to acknowledge that the NPM host's original
      // forward target will be replaced and any traffic relying on it will stop.
      if (res.status === 409 && data && data.mismatch && !opts.force) {
        const m = data.mismatch;
        const detail = 'NPM #' + hostId + ' encaminha actualmente para ' + m.npm.host + ':' + m.npm.port
          + '. Ao vincular, o NPM passa a encaminhar para o Midleman, e este profile encaminhará para '
          + m.profile.host + ':' + m.profile.port + '. Se não forem o mesmo serviço, o tráfego que ia para '
          + m.npm.host + ':' + m.npm.port + ' via este NPM host deixa de funcionar.';
        const ok = await showConfirm({
          title: 'Forward targets não coincidem',
          message: 'O profile e o NPM host apontam para destinos diferentes. Vincular mesmo assim?',
          detail,
          confirmText: 'Vincular mesmo assim',
          danger: true,
        });
        if (!ok) return;
        return linkProfileToNpmHost(profileName, hostId, { force: true, skipConfirm: true });
      }
      toast(data.error || 'Falha ao vincular', 'error');
      return;
    }
    toast('Profile "' + profileName + '" vinculado ao NPM #' + hostId + (data.forced ? ' (forçado)' : ''));
    await fetchProfiles();
    // If we're on the NPM page, refresh its tables too.
    try { if (typeof fetchNpmHostsTable === 'function') await fetchNpmHostsTable(); } catch { /* ignore */ }
    try { if (typeof _npmImportHostsAll !== 'undefined' && _npmImportHostsAll.length) await fetchNpmProxyHosts(); } catch { /* ignore */ }
  } catch (e) {
    toast('Erro de rede: ' + e.message, 'error');
  }
}

// Modal: pick an existing NPM host to link to the given profile.
// Built dynamically (no HTML changes needed). Lists NPM hosts that are not yet
// linked to any profile or webhook. Match badge highlights exact host+port matches.
async function openLinkToNpmModal(profileName) {
  const profile = _allProfiles.find(p => p.name === profileName);
  if (!profile) { toast('Profile não encontrado', 'error'); return; }
  if (profile.npmProxyHostId) { toast('Profile já vinculado ao NPM #' + profile.npmProxyHostId, 'error'); return; }

  // Ensure we have a fresh NPM hosts list.
  let hosts = [];
  try {
    const r = await api('/admin/npm/proxy-hosts');
    if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error || 'Falha ao carregar NPM hosts', 'error'); return; }
    const d = await r.json();
    hosts = (d.hosts || []).filter(h => !h.linkedProfile && !h.linkedWebhook);
  } catch (e) { toast('Erro de rede: ' + e.message, 'error'); return; }

  if (!hosts.length) { toast('Não há NPM hosts disponíveis para vincular.', 'error'); return; }

  // Compute the profile's target for match highlighting.
  let tHost = '', tPort = 0;
  try {
    const u = new URL(profile.targetUrl);
    tHost = u.hostname.toLowerCase();
    tPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  } catch { /* invalid targetUrl — no match highlighting */ }

  // Sort: exact matches first, then by id.
  hosts.sort((a, b) => {
    const am = ((a.forward_host || '').toLowerCase() === tHost && Number(a.forward_port) === tPort) ? 0 : 1;
    const bm = ((b.forward_host || '').toLowerCase() === tHost && Number(b.forward_port) === tPort) ? 0 : 1;
    return am - bm || (a.id - b.id);
  });

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = '_linkToNpmOverlay';
  overlay.innerHTML =
    '<div class="modal" style="max-width:720px">' +
    '  <div class="modal-header">' +
    '    <h3 style="margin:0">Vincular profile "' + _esc(profileName) + '" a um NPM host</h3>' +
    '    <button type="button" class="btn btn-sm" onclick="closeLinkToNpmModal()">&times;</button>' +
    '  </div>' +
    '  <div class="modal-body" style="max-height:60vh;overflow-y:auto">' +
    '    <div style="color:var(--text2);font-size:12.5px;margin-bottom:10px">' +
    '      Profile encaminha para <code style="font-family:monospace">' + _esc(tHost + ':' + (tPort || '?')) + '</code>. ' +
    '      Hosts com destino exactamente igual aparecem marcados como <strong>match</strong>.' +
    '    </div>' +
    '    <table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '      <thead><tr style="text-align:left;color:var(--text3);border-bottom:1px solid var(--border)">' +
    '        <th style="padding:6px 8px">#</th>' +
    '        <th style="padding:6px 8px">Domains</th>' +
    '        <th style="padding:6px 8px">Forwards to</th>' +
    '        <th style="padding:6px 8px"></th>' +
    '        <th style="padding:6px 8px;text-align:right"></th>' +
    '      </tr></thead>' +
    '      <tbody>' + hosts.map(h => {
      const fh = (h.forward_host || '').toLowerCase();
      const fp = Number(h.forward_port || 0);
      const matches = (tHost && fh === tHost && fp === tPort);
      const fwd = (h.forward_scheme || 'http') + '://' + (h.forward_host || '?') + ':' + (h.forward_port || '?');
      const domains = (h.domain_names || []).length ? h.domain_names.join(', ') : '(no domains)';
      const matchBadge = matches
        ? '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:10px;font-size:11px">match</span>'
        : '<span style="background:var(--surface2);color:var(--text3);padding:2px 8px;border-radius:10px;font-size:11px">mismatch</span>';
      return '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:8px;color:var(--text3)">#' + h.id + '</td>' +
        '<td style="padding:8px">' + _esc(domains) + '</td>' +
        '<td style="padding:8px;font-family:monospace;font-size:11.5px;color:var(--text2)">' + _esc(fwd) + '</td>' +
        '<td style="padding:8px">' + matchBadge + '</td>' +
        '<td style="padding:8px;text-align:right">' +
        '  <button class="btn btn-sm btn-primary" onclick="_pickHostForLink(' + h.id + ',\'' + _esc(profileName) + '\', event)">Vincular</button>' +
        '</td></tr>';
    }).join('') + '</tbody>' +
    '    </table>' +
    '  </div>' +
    '  <div class="modal-footer">' +
    '    <button type="button" class="btn" onclick="closeLinkToNpmModal()">Fechar</button>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function closeLinkToNpmModal() {
  const el = document.getElementById('_linkToNpmOverlay');
  if (el) el.remove();
}

async function _pickHostForLink(hostId, profileName, event) {
  await withBusy(event, 'A vincular…', async () => {
    await linkProfileToNpmHost(profileName, hostId);
  });
  closeLinkToNpmModal();
}

// Modal: pick an existing profile OR webhook to link to the given NPM host.
async function openLinkProfileToHostModal(hostId) {
  // Ensure both lists are fresh.
  if (!_allProfiles || !_allProfiles.length) {
    try { await fetchProfiles(); } catch { /* ignore */ }
  }
  if (!_allWebhooks || !_allWebhooks.length) {
    try { await fetchWebhooks(); } catch { /* ignore */ }
  }
  const profileCandidates = (_allProfiles || []).filter(p => !p.npmProxyHostId);
  const webhookCandidates = (_allWebhooks || []).filter(w => !w.npmProxyHostId);
  if (!profileCandidates.length && !webhookCandidates.length) {
    toast('Não há profiles nem webhooks livres para vincular.', 'error');
    return;
  }

  // Find the host info for match highlighting.
  let host = null;
  try {
    const r = await api('/admin/npm/proxy-hosts/' + hostId);
    if (r.ok) host = (await r.json()).host || null;
  } catch { /* ignore */ }
  let nHost = '', nPort = 0;
  if (host) { nHost = (host.forward_host || '').toLowerCase(); nPort = Number(host.forward_port || 0); }

  const parseUrl = (s) => {
    try {
      const u = new URL(s);
      return { h: u.hostname.toLowerCase(), p: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80) };
    } catch { return { h: '', p: 0 }; }
  };
  const profileTarget = (p) => parseUrl(p.targetUrl);
  const webhookTarget = (w) => {
    const first = w.targets && w.targets[0];
    if (typeof first === 'string') return parseUrl(first);
    if (first && typeof first === 'object' && first.url) return parseUrl(first.url);
    return { h: '', p: 0 };
  };

  // Build a unified row list. Sort matches first, then by name.
  const rows = []
    .concat(profileCandidates.map(p => ({ kind: 'profile', name: p.name, targetStr: p.targetUrl || '', tgt: profileTarget(p) })))
    .concat(webhookCandidates.map(w => {
      const first = w.targets && w.targets[0];
      const targetStr = typeof first === 'string' ? first : (first && first.url) || '(no target)';
      return { kind: 'webhook', name: w.name, targetStr, tgt: webhookTarget(w) };
    }));
  rows.sort((a, b) => {
    const am = (a.tgt.h === nHost && a.tgt.p === nPort) ? 0 : 1;
    const bm = (b.tgt.h === nHost && b.tgt.p === nPort) ? 0 : 1;
    return am - bm || a.name.localeCompare(b.name);
  });

  const hostFwd = host
    ? (host.forward_scheme || 'http') + '://' + (host.forward_host || '?') + ':' + (host.forward_port || '?')
    : '(unknown)';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = '_linkProfileToHostOverlay';
  overlay.innerHTML =
    '<div class="modal" style="max-width:760px">' +
    '  <div class="modal-header">' +
    '    <h3 style="margin:0">Vincular NPM host #' + hostId + ' a um profile ou webhook</h3>' +
    '    <button type="button" class="btn btn-sm" onclick="closeLinkProfileToHostModal()">&times;</button>' +
    '  </div>' +
    '  <div class="modal-body" style="max-height:60vh;overflow-y:auto">' +
    '    <div style="color:var(--text2);font-size:12.5px;margin-bottom:10px">' +
    '      NPM host encaminha para <code style="font-family:monospace">' + _esc(hostFwd) + '</code>. ' +
    '      Entradas com destino exactamente igual aparecem como <strong>match</strong>.' +
    '    </div>' +
    '    <table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '      <thead><tr style="text-align:left;color:var(--text3);border-bottom:1px solid var(--border)">' +
    '        <th style="padding:6px 8px">Tipo</th>' +
    '        <th style="padding:6px 8px">Nome</th>' +
    '        <th style="padding:6px 8px">Target</th>' +
    '        <th style="padding:6px 8px"></th>' +
    '        <th style="padding:6px 8px;text-align:right"></th>' +
    '      </tr></thead>' +
    '      <tbody>' + (rows.length ? rows.map(r => {
      const matches = nHost && r.tgt.h === nHost && r.tgt.p === nPort;
      const matchBadge = matches
        ? '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:10px;font-size:11px">match</span>'
        : '<span style="background:var(--surface2);color:var(--text3);padding:2px 8px;border-radius:10px;font-size:11px">mismatch</span>';
      const kindBadge = r.kind === 'profile'
        ? '<span style="background:var(--accent-bg);color:var(--accent2);padding:2px 8px;border-radius:10px;font-size:11px">Profile</span>'
        : '<span style="background:var(--orange-bg);color:var(--orange);padding:2px 8px;border-radius:10px;font-size:11px">Webhook</span>';
      const pickFn = r.kind === 'profile'
        ? '_pickProfileForLink(\'' + _esc(r.name) + '\',' + hostId + ', event)'
        : '_pickWebhookForLink(\'' + _esc(r.name) + '\',' + hostId + ', event)';
      return '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:8px">' + kindBadge + '</td>' +
        '<td style="padding:8px;font-weight:600">' + _esc(r.name) + '</td>' +
        '<td style="padding:8px;font-family:monospace;font-size:11.5px;color:var(--text2)">' + _esc(r.targetStr) + '</td>' +
        '<td style="padding:8px">' + matchBadge + '</td>' +
        '<td style="padding:8px;text-align:right">' +
        '  <button class="btn btn-sm btn-primary" onclick="' + pickFn + '">Vincular</button>' +
        '</td></tr>';
    }).join('') : '<tr><td colspan="5" style="padding:18px;text-align:center;color:var(--text3)">Sem entradas livres.</td></tr>') + '</tbody>' +
    '    </table>' +
    '  </div>' +
    '  <div class="modal-footer">' +
    '    <button type="button" class="btn" onclick="closeLinkProfileToHostModal()">Fechar</button>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function closeLinkProfileToHostModal() {
  const el = document.getElementById('_linkProfileToHostOverlay');
  if (el) el.remove();
}

async function _pickProfileForLink(profileName, hostId, event) {
  await withBusy(event, 'A vincular…', async () => {
    await linkProfileToNpmHost(profileName, hostId);
  });
  closeLinkProfileToHostModal();
}

async function _pickWebhookForLink(webhookName, hostId, event) {
  await withBusy(event, 'A vincular…', async () => {
    await linkWebhookToNpmHost(webhookName, hostId);
  });
  closeLinkProfileToHostModal();
}

// Webhook ↔ NPM host linking (symmetric to linkProfileToNpmHost).
async function linkWebhookToNpmHost(webhookName, hostId, opts) {
  opts = opts || {};
  if (!opts.skipConfirm) {
    const msg = 'Vincular webhook "' + webhookName + '" ao host NPM #' + hostId
      + '? O NPM passará a encaminhar tráfego para o webhook (em vez do destino actual).';
    if (!(await showConfirm({ title: 'Vincular webhook ao NPM', message: msg, confirmText: 'Vincular' }))) return;
  }
  try {
    const res = await api('/admin/npm/link-webhook', {
      method: 'POST',
      body: JSON.stringify({ webhookName, hostId, force: !!opts.force }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409 && data && data.mismatch && !opts.force) {
        const m = data.mismatch;
        const detail = 'NPM #' + hostId + ' encaminha actualmente para ' + m.npm.host + ':' + m.npm.port
          + '. Ao vincular, o NPM passa a encaminhar para o webhook, cujo primeiro target é '
          + m.webhook.host + ':' + m.webhook.port + '. Se não forem o mesmo serviço, o tráfego que ia para '
          + m.npm.host + ':' + m.npm.port + ' via este NPM host deixa de funcionar.';
        const ok = await showConfirm({
          title: 'Forward targets não coincidem',
          message: 'O webhook e o NPM host apontam para destinos diferentes. Vincular mesmo assim?',
          detail,
          confirmText: 'Vincular mesmo assim',
          danger: true,
        });
        if (!ok) return;
        return linkWebhookToNpmHost(webhookName, hostId, { force: true, skipConfirm: true });
      }
      toast(data.error || 'Falha ao vincular', 'error');
      return;
    }
    toast('Webhook "' + webhookName + '" vinculado ao NPM #' + hostId + (data.forced ? ' (forçado)' : ''));
    try { await fetchWebhooks(); } catch { /* ignore */ }
    try { if (typeof fetchNpmHostsTable === 'function') await fetchNpmHostsTable(); } catch { /* ignore */ }
    try { if (typeof _npmImportHostsAll !== 'undefined' && _npmImportHostsAll.length) await fetchNpmProxyHosts(); } catch { /* ignore */ }
  } catch (e) {
    toast('Erro de rede: ' + e.message, 'error');
  }
}

// Modal: pick an existing NPM host to link to the given webhook.
async function openLinkToNpmModalForWebhook(webhookName) {
  const webhook = (_allWebhooks || []).find(w => w.name === webhookName);
  if (!webhook) { toast('Webhook não encontrado', 'error'); return; }
  if (webhook.npmProxyHostId) { toast('Webhook já vinculado ao NPM #' + webhook.npmProxyHostId, 'error'); return; }

  let hosts = [];
  try {
    const r = await api('/admin/npm/proxy-hosts');
    if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error || 'Falha ao carregar NPM hosts', 'error'); return; }
    const d = await r.json();
    hosts = (d.hosts || []).filter(h => !h.linkedProfile && !h.linkedWebhook);
  } catch (e) { toast('Erro de rede: ' + e.message, 'error'); return; }
  if (!hosts.length) { toast('Não há NPM hosts disponíveis para vincular.', 'error'); return; }

  // First target for match highlighting.
  let tHost = '', tPort = 0;
  const first = webhook.targets && webhook.targets[0];
  const firstUrl = typeof first === 'string' ? first : (first && first.url) || '';
  if (firstUrl) {
    try {
      const u = new URL(firstUrl);
      tHost = u.hostname.toLowerCase();
      tPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    } catch { /* ignore */ }
  }

  hosts.sort((a, b) => {
    const am = ((a.forward_host || '').toLowerCase() === tHost && Number(a.forward_port) === tPort) ? 0 : 1;
    const bm = ((b.forward_host || '').toLowerCase() === tHost && Number(b.forward_port) === tPort) ? 0 : 1;
    return am - bm || (a.id - b.id);
  });

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = '_linkWebhookToNpmOverlay';
  overlay.innerHTML =
    '<div class="modal" style="max-width:720px">' +
    '  <div class="modal-header">' +
    '    <h3 style="margin:0">Vincular webhook "' + _esc(webhookName) + '" a um NPM host</h3>' +
    '    <button type="button" class="btn btn-sm" onclick="closeLinkWebhookToNpmModal()">&times;</button>' +
    '  </div>' +
    '  <div class="modal-body" style="max-height:60vh;overflow-y:auto">' +
    '    <div style="color:var(--text2);font-size:12.5px;margin-bottom:10px">' +
    '      Primeiro target do webhook: <code style="font-family:monospace">' + _esc(firstUrl || '(sem target)') + '</code>. ' +
    '      Hosts com destino exactamente igual aparecem marcados como <strong>match</strong>.' +
    '    </div>' +
    '    <table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '      <thead><tr style="text-align:left;color:var(--text3);border-bottom:1px solid var(--border)">' +
    '        <th style="padding:6px 8px">#</th>' +
    '        <th style="padding:6px 8px">Domains</th>' +
    '        <th style="padding:6px 8px">Forwards to</th>' +
    '        <th style="padding:6px 8px"></th>' +
    '        <th style="padding:6px 8px;text-align:right"></th>' +
    '      </tr></thead>' +
    '      <tbody>' + hosts.map(h => {
      const fh = (h.forward_host || '').toLowerCase();
      const fp = Number(h.forward_port || 0);
      const matches = (tHost && fh === tHost && fp === tPort);
      const fwd = (h.forward_scheme || 'http') + '://' + (h.forward_host || '?') + ':' + (h.forward_port || '?');
      const domains = (h.domain_names || []).length ? h.domain_names.join(', ') : '(no domains)';
      const matchBadge = matches
        ? '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:10px;font-size:11px">match</span>'
        : '<span style="background:var(--surface2);color:var(--text3);padding:2px 8px;border-radius:10px;font-size:11px">mismatch</span>';
      return '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:8px;color:var(--text3)">#' + h.id + '</td>' +
        '<td style="padding:8px">' + _esc(domains) + '</td>' +
        '<td style="padding:8px;font-family:monospace;font-size:11.5px;color:var(--text2)">' + _esc(fwd) + '</td>' +
        '<td style="padding:8px">' + matchBadge + '</td>' +
        '<td style="padding:8px;text-align:right">' +
        '  <button class="btn btn-sm btn-primary" onclick="_pickHostForWebhookLink(' + h.id + ',\'' + _esc(webhookName) + '\')">Vincular</button>' +
        '</td></tr>';
    }).join('') + '</tbody>' +
    '    </table>' +
    '  </div>' +
    '  <div class="modal-footer">' +
    '    <button type="button" class="btn" onclick="closeLinkWebhookToNpmModal()">Fechar</button>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function closeLinkWebhookToNpmModal() {
  const el = document.getElementById('_linkWebhookToNpmOverlay');
  if (el) el.remove();
}

async function _pickHostForWebhookLink(hostId, webhookName) {
  closeLinkWebhookToNpmModal();
  await linkWebhookToNpmHost(webhookName, hostId);
}

// Returns the first NPM host whose forward target matches the profile's target
// URL (host + port), if any. Used to surface a passive hint on profiles that
// are not yet linked. Returns null if no integration data or no match.
function _findPossibleNpmHostForProfile(p) {
  if (!p || p.npmProxyHostId) return null;
  if (!_npmHostsAll || !_npmHostsAll.length) return null;
  const target = p.targetUrl || '';
  if (!target) return null;
  let u;
  try { u = new URL(target); } catch { return null; }
  const tHost = u.hostname.toLowerCase();
  const tPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return _npmHostsAll.find(h => {
    if (h.linkedProfile || h.linkedWebhook) return false;
    const fh = (h.forward_host || '').toLowerCase();
    const fp = Number(h.forward_port || 0);
    return fh === tHost && fp === tPort;
  }) || null;
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
    const npmHint = (() => {
      const match = _findPossibleNpmHostForProfile(p);
      if (!match) return '';
      const domains = (match.domain_names || []).filter(Boolean);
      const first = domains[0] || ('NPM #' + match.id);
      const extra = domains.length > 1 ? ' +' + (domains.length - 1) : '';
      const tip = 'NPM host #' + match.id + (domains.length ? ' (' + domains.join(', ') + ')' : '')
        + ' forwards to the same target as this profile. Click Link to vincular and redirect NPM → Midleman.';
      const linkBtn = '<button type="button" onclick="event.stopPropagation();linkProfileToNpmHost(\'' + esc(p.name) + '\',' + match.id + ')" '
        + 'style="background:var(--accent);color:#fff;border:none;border-radius:3px;font-size:10.5px;padding:1px 7px;cursor:pointer;margin-left:6px" '
        + 'title="Link this profile to NPM host #' + match.id + ' and redirect NPM to Midleman">Link</button>';
      return '<span style="background:var(--surface2);color:var(--text2);padding:2px 4px 2px 8px;border-radius:4px;font-size:11px;margin-left:4px;cursor:help;display:inline-flex;align-items:center" title="' + esc(tip) + '">Possible NPM: ' + esc(first) + esc(extra) + linkBtn + '</span>';
    })();
    const npmBadge = (() => {
      if (!p.npmProxyHostId) return npmHint;
      const hosts = (p.publicHostnames || []).filter(Boolean);
      const tip = (hosts.length ? `Open https://${esc(hosts[0])} (NPM #${p.npmProxyHostId})` : `NPM #${p.npmProxyHostId}`)
        + (hosts.length > 1 ? ` — also: ${esc(hosts.slice(1).join(', '))}` : '');
      const shown = hosts.length === 0
        ? `NPM #${p.npmProxyHostId}`
        : (hosts.length === 1
            ? esc(hosts[0])
            : `${esc(hosts[0])} <span style="color:var(--text3);font-weight:400">+${hosts.length - 1}</span>`);
      const inner = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shown}</span>`;
      if (hosts.length === 0) {
        return `<span style="background:rgba(0,120,212,0.12);color:var(--accent);padding:2px 8px;border-radius:4px;font-size:11px;margin-left:4px;cursor:help;max-width:240px;display:inline-flex;align-items:center;gap:4px;vertical-align:middle" title="${tip}">${inner}</span>`;
      }
      const href = 'https://' + hosts[0].replace(/^\*\./, 'www.');
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="background:rgba(0,120,212,0.12);color:var(--accent);padding:2px 8px;border-radius:4px;font-size:11px;margin-left:4px;max-width:240px;display:inline-flex;align-items:center;gap:4px;vertical-align:middle;text-decoration:none;transition:background 0.15s" onmouseover="this.style.background='rgba(0,120,212,0.22)'" onmouseout="this.style.background='rgba(0,120,212,0.12)'" title="${tip}">${inner}</a>`;
    })();
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
  <td style="padding:8px">${statusBadge}${npmBadge}</td>
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
  // Auto-open the upstream-auth section if any of those fields has a value.
  const hasUpstreamAuth = !!(profile && (profile.apiKey || profile.authHeader || profile.authPrefix));
  document.getElementById('pUpstreamAuthToggle').checked = hasUpstreamAuth;
  toggleUpstreamAuthSection();
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
  document.getElementById('pAllowedPaths').value = profile?.allowedPaths ? profile.allowedPaths.join('\n') : '';
  // NPM fields (hidden inputs — populated by Adopt flow; managed via the Nginx PM page otherwise)
  document.getElementById('pPublicHostnames').value = profile?.publicHostnames ? profile.publicHostnames.join(', ') : '';
  document.getElementById('pTlsMode').value = profile?.tlsMode || 'none';
  document.getElementById('pHttp2').value = String(profile ? profile.http2 !== false : true);
  document.getElementById('pHstsEnabled').value = String(!!(profile && profile.hstsEnabled));
  document.getElementById('pSslForced').value = String(!!(profile && profile.sslForced));
  document.getElementById('pAllowWebsocketUpgrade').value = String(profile ? profile.allowWebsocketUpgrade !== false : true);
  document.getElementById('pAdvancedConfig').value = (profile && profile.advancedConfig) || '';
  renderNpmLocations((profile && profile.npmLocations) || []);
  // Adopted-from-NPM banner
  const banner = document.getElementById('pAdoptedBanner');
  const info = document.getElementById('pAdoptedInfo');
  if (banner && info) {
    if (profile && profile.npmOriginalForwardHost && profile.npmProxyHostId) {
      banner.style.display = 'flex';
      info.textContent = '#' + profile.npmProxyHostId + ' — original forward ' + (profile.npmOriginalForwardScheme || 'http') + '://' + profile.npmOriginalForwardHost + ':' + profile.npmOriginalForwardPort;
    } else {
      banner.style.display = 'none';
    }
  }
  const npmStatusEl = document.getElementById('pNpmStatus');
  if (npmStatusEl) {
    if (profile && profile.npmProxyHostId) npmStatusEl.textContent = '✔ Synced — NPM proxy host #' + profile.npmProxyHostId + (profile.npmCertificateId ? ', cert #' + profile.npmCertificateId : '');
    else if (profile && profile.publicHostnames && profile.publicHostnames.length) npmStatusEl.textContent = 'Hostnames configured but not yet synced — enable NPM integration in settings.';
    else npmStatusEl.textContent = '';
  }
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
function toggleUpstreamAuthSection() {
  const on = document.getElementById('pUpstreamAuthToggle').checked;
  document.getElementById('pUpstreamAuthSection').style.display = on ? '' : 'none';
  if (!on) {
    // Clear the values so a "Save" doesn't accidentally persist stale credentials.
    document.getElementById('pApiKey').value = '';
    document.getElementById('pAuthHeader').value = '';
    document.getElementById('pAuthPrefix').value = '';
  }
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
  const allowedPathsRaw = v('pAllowedPaths');
  if (allowedPathsRaw) {
    const paths = allowedPathsRaw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (paths.length) body.allowedPaths = paths;
  }
  // NPM fields (hidden — only meaningful for adopted profiles; preserved across saves)
  const hostnamesRaw = v('pPublicHostnames');
  if (hostnamesRaw) body.publicHostnames = hostnamesRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const tlsMode = v('pTlsMode');
  if (tlsMode && tlsMode !== 'none') body.tlsMode = tlsMode;
  body.http2 = document.getElementById('pHttp2').value === 'true';
  body.hstsEnabled = document.getElementById('pHstsEnabled').value === 'true';
  body.sslForced = document.getElementById('pSslForced').value === 'true';
  body.allowWebsocketUpgrade = document.getElementById('pAllowWebsocketUpgrade').value === 'true';
  const advanced = document.getElementById('pAdvancedConfig').value;
  if (advanced.trim()) body.advancedConfig = advanced;
  const locations = readNpmLocations();
  if (locations.length) body.npmLocations = locations;
  // Adoption payload (only on first save after Adopt from NPM)
  if (_npmImportPreviewData && !editingProfile) {
    body.npmProxyHostId = _npmImportPreviewData.npmProxyHostId;
    body.npmOriginalForwardHost = _npmImportPreviewData.npmOriginalForwardHost;
    body.npmOriginalForwardPort = _npmImportPreviewData.npmOriginalForwardPort;
    body.npmOriginalForwardScheme = _npmImportPreviewData.npmOriginalForwardScheme;
  }
  try {
    const res = await api('/admin/profiles', { method: 'POST', body: JSON.stringify(body) }); const d = await res.json();
    if (res.ok) { _npmImportPreviewData = null; toast('Proxy ' + (d.status || 'saved')); closeProfileModal(); await fetchProfiles(); }
    else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function editProfile(name) {
  try { const res = await api('/admin/profiles/' + encodeURIComponent(name)); if (!res.ok) return toast('Not found', 'error'); openProfileModal((await res.json()).profile); } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function deleteProfile(name) {
  if (!(await showConfirm({ title: 'Apagar proxy', message: 'Apagar proxy "' + name + '"?', confirmText: 'Apagar' }))) return;
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
    c.innerHTML = '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--text3)">No users match the current filter.</td></tr>';
    return;
  }
  c.innerHTML = users.map(u => {
    const twoFa = u.totpEnabled
      ? '<span style="color:var(--green)">Active</span>'
      : (u.force2faSetup
        ? '<span style="color:var(--orange)" title="User must configure 2FA on next login">Pending setup</span>'
        : '<span style="color:var(--text3)">Off</span>');
    const nameCell = u.fullName
      ? `<div style="font-weight:600;color:var(--text)">${esc(u.fullName)}</div><div style="font-size:11px;color:var(--text3);font-family:monospace">${esc(u.username)}</div>`
      : `<div style="font-weight:600;color:var(--text)">${esc(u.username)}</div>`;
    const emailLine = u.email
      ? `<div style="font-size:12px;color:var(--text2)">${esc(u.email)}</div>`
      : '';
    const phoneLine = u.phoneNumber
      ? `<div style="font-size:11.5px;color:var(--text3);font-family:ui-monospace,Menlo,monospace;margin-top:2px">${esc(u.phoneNumber)}</div>`
      : '';
    const emailCell = (emailLine || phoneLine) ? (emailLine + phoneLine) : `<span style="color:var(--text3)">—</span>`;
    const actionsCell = `<button data-type="proxyUser" data-id="${u.id}" onclick="showContextMenu(event,this)" style="background:none;border:1px solid var(--border);border-radius:6px;padding:2px 10px;cursor:pointer;color:var(--text2);font-size:18px;line-height:1.2;letter-spacing:1px" title="Actions">&#8942;</button>`;
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
      <td style="padding:8px 12px">${nameCell}</td>
      <td style="padding:8px">${emailCell}</td>
      <td style="padding:8px">${_roleBadge(u)}</td>
      <td style="padding:8px">${twoFa}</td>
      <td style="padding:8px;color:var(--text3);font-size:12px">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-GB') : '-'}</td>
      <td style="padding:8px 12px;text-align:right;white-space:nowrap">${actionsCell}</td>
    </tr>`;
  }).join('');
}

function closeNewProxyUserModal() {
  document.getElementById('newProxyUserModal').classList.remove('active');
  // Restore password field visibility so a future create-user flow still works.
  const pwGroup = document.getElementById('npuPasswordGroup');
  if (pwGroup) pwGroup.style.display = '';
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
  document.getElementById('npuPhone').value = user.phoneNumber || '';
  document.getElementById('npuUsername').value = user.username;
  document.getElementById('npuPassword').value = '';
  // Password changes are not allowed via the edit modal — admins must send a
  // password reset link from the user's action menu instead.
  document.getElementById('npuPasswordGroup').style.display = 'none';
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
  const phoneRaw = document.getElementById('npuPhone').value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Invalid email.'; errEl.style.display = 'block'; return; }
  if (phoneRaw && !/^[+0-9 ()-]{6,20}$/.test(phoneRaw)) { errEl.textContent = 'Invalid phone number.'; errEl.style.display = 'block'; return; }
  const body = { fullName, email };
  const currentPhone = _allProxyUsers.find(u => u.id === _editUserId)?.phoneNumber || '';
  if (phoneRaw !== currentPhone) body.phoneNumber = phoneRaw;
  // Send isAdmin only when the toggle is visible (i.e. not self-edit) AND the
  // value actually changed — avoids no-op audit entries and accidental demotes.
  const adminGroupVisible = document.getElementById('npuIsAdminGroup').style.display !== 'none';
  if (adminGroupVisible) {
    const desired = document.getElementById('npuIsAdmin').checked;
    const current = !!_allProxyUsers.find(u => u.id === _editUserId)?.isAdmin;
    if (desired !== current) {
      if (!desired && !(await showConfirm({ title: 'Remover papel de administrador', message: 'Remover o papel de administrador deste utilizador? Perderá acesso ao dashboard.', confirmText: 'Remover' }))) return;
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
  if (!(await showConfirm({ title: 'Apagar utilizador', message: 'Apagar utilizador "' + username + '"? Todo o acesso aos perfis será revogado.', confirmText: 'Apagar' }))) return;
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
  if (!(await showConfirm({ title: 'Desativar 2FA', message: 'Desativar 2FA para "' + username + '"?', detail: 'A conta ficará protegida apenas pela palavra-passe. O utilizador será notificado por email.', confirmText: 'Desativar' }))) return;
  try {
    const res = await api('/admin/proxy-users/' + id, { method: 'PUT', body: JSON.stringify({ reset2fa: true }) });
    if (res.ok) { toast('2FA disabled — user notified by email'); fetchProxyUsers(); } else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function force2fa(id, username) {
  if (!(await showConfirm({ title: 'Exigir configuração de 2FA', message: 'Exigir que "' + username + '" configure 2FA no próximo login?', detail: 'Se já tiver 2FA, será reposto e terá de o configurar novamente. O utilizador será notificado por email.', confirmText: 'Exigir', danger: false }))) return;
  try {
    const res = await api('/admin/proxy-users/' + id, { method: 'PUT', body: JSON.stringify({ force2fa: true }) });
    if (res.ok) { toast('User will be required to set up 2FA on next login'); fetchProxyUsers(); } else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// Backwards-compatible alias (in case any inline handler still references it).
async function reset2fa(id, username) { return disable2fa(id, username); }

async function sendPasswordReset(id, username) {
  if (!(await showConfirm({ title: 'Enviar link de reposição de palavra-passe', message: 'Enviar email de reposição para "' + username + '"?', detail: 'O utilizador recebe um link único que expira em 60 minutos. A configuração de 2FA permanece inalterada.', confirmText: 'Enviar' }))) return;
  try {
    const res = await api('/admin/proxy-users/' + id + '/password-reset', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) toast('Reset email sent to ' + (d.email || username));
    else toast(d.error || 'Failed to send reset email', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── Profile ↔ User Association ─────────────────────────────────────────────
let _profileUsersProfile = null;

function openProxyUsersModal(profileName) {
  _profileUsersProfile = profileName;
  document.getElementById('profileUsersTitle').textContent = 'Users — ' + profileName;
  document.getElementById('profileUsersModal').classList.add('active');
  refreshProfileUsers();
  refreshProfileLdapGroups();
}
function closeProfileUsersModal() {
  document.getElementById('profileUsersModal').classList.remove('active');
  _profileUsersProfile = null;
}

// ─── Profile ↔ LDAP group rules ──────────────────────────────────────────────
async function refreshProfileLdapGroups() {
  if (!_profileUsersProfile) return;
  const body = document.getElementById('pflgListBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--text3)">Loading...</td></tr>';
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(_profileUsersProfile) + '/ldap-groups');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      body.innerHTML = `<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--red)">${esc(err.error || 'Failed to load')}</td></tr>`;
      return;
    }
    const data = await res.json();
    const groups = data.groups || [];
    const directories = data.directories || [];

    // Populate directory dropdown
    const sel = document.getElementById('pflgConfigSelect');
    if (sel) {
      sel.innerHTML = '<option value="">Directory…</option>' + directories.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    }

    if (groups.length === 0) {
      body.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--text3)">No group rules configured.</td></tr>';
      return;
    }
    const dirById = new Map(directories.map(d => [d.id, d.name]));
    body.innerHTML = groups.map(g => `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px">${esc(dirById.get(g.ldapConfigId) || ('#' + g.ldapConfigId))}</td>
      <td style="padding:8px;font-family:'SF Mono',ui-monospace,monospace;font-size:12px">${esc(g.groupMatch)}</td>
      <td style="padding:8px 12px;text-align:right">
        <button onclick="removeLdapGroupFromProfileUI(${g.id})" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--red);font-size:11px">Remove</button>
      </td>
    </tr>`).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--red)">Error: ' + esc(e.message) + '</td></tr>';
  }
}

async function addLdapGroupToProfileUI() {
  if (!_profileUsersProfile) return;
  const sel = document.getElementById('pflgConfigSelect');
  const input = document.getElementById('pflgGroupInput');
  const ldapConfigId = parseInt(sel.value, 10);
  const groupMatch = (input.value || '').trim();
  if (!ldapConfigId) { toast('Select a directory', 'error'); return; }
  if (!groupMatch) { toast('Enter a group (CN, DN or *)', 'error'); return; }
  const btn = input.nextElementSibling;
  if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(_profileUsersProfile) + '/ldap-groups', {
      method: 'POST', body: JSON.stringify({ ldapConfigId, groupMatch }),
    });
    if (res.ok) {
      input.value = '';
      toast('Rule added');
      await refreshProfileLdapGroups();
    } else {
      const d = await res.json().catch(() => ({}));
      toast(d.error || 'Failed', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
  }
}

async function removeLdapGroupFromProfileUI(ruleId) {
  if (!_profileUsersProfile) return;
  if (!(await showConfirm({ title: 'Remover regra de grupo LDAP', message: 'Remover esta regra de grupo LDAP?', confirmText: 'Remover' }))) return;
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(_profileUsersProfile) + '/ldap-groups/' + ruleId, { method: 'DELETE' });
    if (res.ok) { toast('Rule removed'); await refreshProfileLdapGroups(); }
    else { const d = await res.json().catch(() => ({})); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
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
  if (!(await showConfirm({ title: 'Remover do perfil', message: 'Remover "' + username + '" deste perfil?', confirmText: 'Remover' }))) return;
  const btn = document.querySelector(`#pfuListBody button[onclick*="removeUserFromProfile(${userId},"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Removing...'; }
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(_profileUsersProfile) + '/users/' + userId, { method: 'DELETE' });
    if (res.ok) { toast('User removed'); await refreshProfileUsers(); fetchProxyUsers(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Remove'; } }
  } catch (e) { toast('Error: ' + e.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Remove'; } }
}

// ─── User ↔ Resources (HTTP proxies + OAuth clients) ─────────────────────────
let _userProfilesUserId = null;
let _userProfilesUsername = null;

function openUserResourcesModal(userId, username) {
  _userProfilesUserId = userId;
  _userProfilesUsername = username;
  document.getElementById('userProfilesTitle').textContent = 'Resources — ' + username;
  document.getElementById('userProfilesModal').classList.add('active');
  refreshUserResources();
}
function closeUserResourcesModal() {
  document.getElementById('userProfilesModal').classList.remove('active');
  _userProfilesUserId = null;
  _userProfilesUsername = null;
}
// Back-compat aliases (in case anything else still calls these)
function openUserProfilesModal(userId, username) { openUserResourcesModal(userId, username); }
function closeUserProfilesModal() { closeUserResourcesModal(); }

function _sourceBadge(source) {
  if (source === 'direct') return '<span style="color:var(--text2);font-size:11px">Direct</span>';
  if (source === 'ldap_group') return '<span style="color:var(--primary);font-size:11px" title="Granted by LDAP group membership">LDAP group</span>';
  if (source === 'open') return '<span style="color:var(--text3);font-size:11px" title="Allow-list disabled — open to all users">Open</span>';
  return '<span style="color:var(--text3)">—</span>';
}

async function refreshUserResources() {
  if (!_userProfilesUserId) return;
  const httpBody = document.getElementById('upListBody');
  const oauthBody = document.getElementById('urcOauthListBody');
  if (httpBody) httpBody.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--text3)">Loading...</td></tr>';
  if (oauthBody) oauthBody.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--text3)">Loading...</td></tr>';

  try {
    const res = await api('/admin/proxy-users/' + _userProfilesUserId + '/resources');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (httpBody) httpBody.innerHTML = `<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--red)">${esc(err.error || 'Failed to load')}</td></tr>`;
      if (oauthBody) oauthBody.innerHTML = `<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--red)">${esc(err.error || 'Failed to load')}</td></tr>`;
      return;
    }
    const data = await res.json();
    const httpProxies = data.httpProxies || [];
    const oauthClients = data.oauthClients || [];

    // ── HTTP proxies ──
    const httpSel = document.getElementById('upAddSelect');
    if (httpSel) {
      httpSel.innerHTML = '<option value="">Select proxy to assign...</option>';
      httpProxies.filter(p => !p.assigned || p.source === 'ldap_group').forEach(p => {
        const suffix = p.source === 'ldap_group' ? ' (already via LDAP)' : '';
        httpSel.innerHTML += `<option value="${esc(p.name)}">${esc(p.name)}${suffix}</option>`;
      });
    }
    const httpAssigned = httpProxies.filter(p => p.assigned);
    if (httpBody) {
      if (httpAssigned.length === 0) {
        httpBody.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--text3)">No HTTP proxies accessible.</td></tr>';
      } else {
        httpBody.innerHTML = httpAssigned.map(p => {
          const canRemove = p.source === 'direct';
          const action = canRemove
            ? `<button onclick="removeProfileFromCurrentUser('${esc(p.name)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--red);font-size:11px">Remove</button>`
            : '<span style="color:var(--text3);font-size:11px" title="Remove via the LDAP group rule">—</span>';
          return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 12px;font-weight:600;font-family:monospace">${esc(p.name)}</td>
            <td style="padding:8px">${_sourceBadge(p.source)}</td>
            <td style="padding:8px 12px;text-align:right">${action}</td>
          </tr>`;
        }).join('');
      }
    }

    // ── OAuth clients ──
    const oauthSel = document.getElementById('urcOauthSelect');
    if (oauthSel) {
      oauthSel.innerHTML = '<option value="">Select OAuth client to assign...</option>';
      // Offerable: clients with allow_list_enabled and not yet directly assigned.
      // Clients with allow-list disabled are "open" — no need to assign.
      oauthClients.filter(c => c.allowListEnabled && c.source !== 'direct').forEach(c => {
        const suffix = c.source === 'ldap_group' ? ' (already via LDAP)' : '';
        oauthSel.innerHTML += `<option value="${esc(c.clientId)}">${esc(c.name || c.clientId)}${suffix}</option>`;
      });
    }
    const oauthAssigned = oauthClients.filter(c => c.assigned);
    if (oauthBody) {
      if (oauthAssigned.length === 0) {
        oauthBody.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--text3)">No OAuth clients accessible.</td></tr>';
      } else {
        oauthBody.innerHTML = oauthAssigned.map(c => {
          const canRemove = c.source === 'direct';
          const action = canRemove
            ? `<button onclick="removeOauthClientFromCurrentUser('${esc(c.clientId)}','${esc(c.name || c.clientId)}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--red);font-size:11px">Remove</button>`
            : '<span style="color:var(--text3);font-size:11px" title="Granted by LDAP or open allow-list">—</span>';
          return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 12px;font-weight:600">${esc(c.name || c.clientId)}<div style="font-size:10px;color:var(--text3);font-family:monospace">${esc(c.clientId)}</div></td>
            <td style="padding:8px">${_sourceBadge(c.source)}</td>
            <td style="padding:8px 12px;text-align:right">${action}</td>
          </tr>`;
        }).join('');
      }
    }
  } catch (e) {
    if (httpBody) httpBody.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--red)">Error: ' + esc(e.message) + '</td></tr>';
    if (oauthBody) oauthBody.innerHTML = '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--red)">Error: ' + esc(e.message) + '</td></tr>';
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
    if (res.ok) { toast('Proxy assigned'); refreshUserResources(); fetchProxyUsers(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function removeProfileFromCurrentUser(profileName) {
  if (!_userProfilesUserId) return;
  if (!(await showConfirm({ title: 'Remover acesso', message: 'Remover acesso a "' + profileName + '"?', confirmText: 'Remover' }))) return;
  try {
    const res = await api('/admin/profiles/' + encodeURIComponent(profileName) + '/users/' + _userProfilesUserId, { method: 'DELETE' });
    if (res.ok) { toast('Access removed'); refreshUserResources(); fetchProxyUsers(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function assignOauthClientToCurrentUser() {
  if (!_userProfilesUserId) return;
  const clientId = document.getElementById('urcOauthSelect').value;
  if (!clientId) { toast('Select an OAuth client first', 'error'); return; }
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(clientId) + '/users', {
      method: 'POST', body: JSON.stringify({ userId: _userProfilesUserId }),
    });
    if (res.ok) { toast('Client assigned'); refreshUserResources(); }
    else { const d = await res.json().catch(() => ({})); toast(d.error || 'Failed', 'error'); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function removeOauthClientFromCurrentUser(clientId, clientName) {
  if (!_userProfilesUserId) return;
  if (!(await showConfirm({ title: 'Remover acesso', message: 'Remover acesso a "' + clientName + '"?', confirmText: 'Remover' }))) return;
  try {
    const res = await api('/admin/oauth-clients/' + encodeURIComponent(clientId) + '/users/' + _userProfilesUserId, { method: 'DELETE' });
    if (res.ok) { toast('Access removed'); refreshUserResources(); }
    else { const d = await res.json().catch(() => ({})); toast(d.error || 'Failed', 'error'); }
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
  if (!(await showConfirm({ title: 'Revogar convite', message: 'Revogar este convite? O link deixará de funcionar.', confirmText: 'Revogar' }))) return;
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
let _pendingByWebhook = {}; // { [webhookName]: count }
let editingWebhook = null;

async function fetchWebhooks() {
  try {
    const [wRes, dlqRes, prRes] = await Promise.all([
      api('/admin/webhooks'),
      api('/admin/webhooks/dlq'),
      api('/admin/webhooks/pending-retry'),
    ]);
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

    if (prRes.ok) {
      const prData = await prRes.json();
      _pendingByWebhook = {};
      for (const e of (prData.queue || [])) {
        _pendingByWebhook[e.webhookName] = (_pendingByWebhook[e.webhookName] || 0) + 1;
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
    const pendingCount = _pendingByWebhook[w.name] || 0;
    const dlqDot = dlqCount > 0
      ? `<span style="position:absolute;top:2px;right:2px;width:7px;height:7px;background:var(--red);border-radius:50%;display:block" title="${dlqCount} failed deliveries"></span>`
      : (pendingCount > 0
          ? `<span style="position:absolute;top:2px;right:2px;width:7px;height:7px;background:var(--orange);border-radius:50%;display:block" title="${pendingCount} pending persistent retries"></span>`
          : '');
    const wNpmBadge = (() => {
      if (!w.npmProxyHostId) return '';
      const hosts = (w.publicHostnames || []).filter(Boolean);
      const tip = (hosts.length ? `Open https://${esc(hosts[0])} (NPM #${w.npmProxyHostId})` : `NPM #${w.npmProxyHostId}`)
        + (hosts.length > 1 ? ` — also: ${esc(hosts.slice(1).join(', '))}` : '');
      const shown = hosts.length === 0
        ? `NPM #${w.npmProxyHostId}`
        : (hosts.length === 1
            ? esc(hosts[0])
            : `${esc(hosts[0])} <span style="color:var(--text3);font-weight:400">+${hosts.length - 1}</span>`);
      const inner = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shown}</span>`;
      if (hosts.length === 0) {
        return `<span style="background:rgba(0,120,212,0.12);color:var(--accent);padding:2px 8px;border-radius:4px;font-size:11px;margin-left:4px;cursor:help;max-width:240px;display:inline-flex;align-items:center;gap:4px;vertical-align:middle" title="${tip}">${inner}</span>`;
      }
      const href = 'https://' + hosts[0].replace(/^\*\./, 'www.');
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="background:rgba(0,120,212,0.12);color:var(--accent);padding:2px 8px;border-radius:4px;font-size:11px;margin-left:4px;max-width:240px;display:inline-flex;align-items:center;gap:4px;vertical-align:middle;text-decoration:none;transition:background 0.15s" onmouseover="this.style.background='rgba(0,120,212,0.22)'" onmouseout="this.style.background='rgba(0,120,212,0.12)'" title="${tip}">${inner}</a>`;
    })();
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
  <td style="padding:8px 12px;font-weight:600">${esc(w.name)}</td>
  <td style="padding:8px">${statusBadge}${wNpmBadge}</td>
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

// ─── GoContact Connectors ────────────────────────────────────────────────────
let _allConnectors = [];

async function fetchConnectors() {
  try {
    const res = await api('/admin/connectors');
    if (!res.ok) return;
    const d = await res.json();
    _allConnectors = d.connectors || [];
    renderConnectors(_allConnectors);
    const badge = document.getElementById('navConnectorBadge');
    if (badge) badge.textContent = _allConnectors.length;
  } catch { }
}

function renderConnectors(connectors) {
  const c = document.getElementById('connectorListBody');
  if (!c) return;
  if (connectors.length === 0) { c.innerHTML = '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text3)">No connectors yet. Click "+ New Connector".</td></tr>'; return; }
  c.innerHTML = connectors.map(cn => {
    const statusBadge = cn.running
      ? '<span style="background:var(--green-bg);color:var(--green);padding:2px 8px;border-radius:4px;font-size:11px">Running</span>'
      : (cn.enabled
        ? '<span style="background:var(--red-bg);color:var(--red);padding:2px 8px;border-radius:4px;font-size:11px">Stopped</span>'
        : '<span style="background:var(--surface2);color:var(--text3);padding:2px 8px;border-radius:4px;font-size:11px">Disabled</span>');
    const replies = [
      cn.directReply ? (cn.channel === 'smooch' ? 'Smooch' : cn.channel === 'meta-whatsapp' ? 'Meta' : 'Direct') : null,
      (cn.webhookTargets && cn.webhookTargets.length)
        ? (cn.webhooksEnabled === false
            ? '<span style="color:var(--text3);text-decoration:line-through" title="Webhook delivery paused">' + cn.webhookTargets.length + ' webhook(s)</span>'
            : cn.webhookTargets.length + ' webhook(s)')
        : null,
    ].filter(Boolean).join(' + ') || '<span style="color:var(--text3)">none</span>';
    const stats = cn.stats || {};
    const activity = `↓${stats.inboundMessages || 0} ↑${stats.agentMessages || 0}` +
      (stats.lastError ? ` <span style="color:var(--red)" title="${esc(stats.lastError)}">⚠</span>` : '');
    return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
  <td style="padding:8px 12px;font-weight:600">${esc(cn.name)}</td>
  <td style="padding:8px">${statusBadge}</td>
  <td style="padding:8px;color:var(--text2)">${esc(cn.channel)}</td>
  <td style="padding:8px;font-family:'SF Mono',Monaco,monospace;color:var(--accent2)">${cn.port ?? '--'}</td>
  <td style="padding:8px;color:var(--text2)">${replies}</td>
  <td style="padding:8px;color:var(--text2);font-family:'SF Mono',Monaco,monospace;font-size:12px" title="received / agent replies">${activity}</td>
  <td style="padding:8px 12px;text-align:right;white-space:nowrap">
    <button class="btn btn-sm" onclick="openConnectorSessionsModal('${esc(cn.name)}')">Sessions</button>
    <button class="btn btn-sm" onclick="editConnector('${esc(cn.name)}')">Edit</button>
    <button class="btn btn-sm" onclick="restartConnectorAction('${esc(cn.name)}')">Restart</button>
    <button class="btn btn-sm btn-danger" onclick="deleteConnector('${esc(cn.name)}')">Delete</button>
  </td>
</tr>`;
  }).join('');
}

let _editingConnector = null;

function connectorChannelChanged() {
  const channel = document.getElementById('cnChannel').value;
  const isMeta = channel === 'meta-whatsapp';
  const isSmooch = channel === 'smooch';
  const hasProvider = isMeta || isSmooch;
  document.getElementById('cnProviderHeader').style.display = hasProvider ? 'block' : 'none';
  document.getElementById('cnMetaSection').style.display = isMeta ? 'block' : 'none';
  document.getElementById('cnSmoochSection').style.display = isSmooch ? 'block' : 'none';
  // Direct reply only makes sense for channels that have a sender.
  const row = document.getElementById('cnDirectReplyRow');
  row.style.display = hasProvider ? 'flex' : 'none';
  if (!hasProvider) document.getElementById('cnDirectReply').checked = false;
}

function connectorAutoReplyChanged() {
  const on = document.getElementById('cnAutoReplyEnabled').checked;
  document.getElementById('cnAutoReplySection').style.display = on ? 'block' : 'none';
}

function connectorBusinessHoursChanged() {
  const on = document.getElementById('cnBusinessHoursEnabled').checked;
  document.getElementById('cnBusinessHoursSection').style.display = on ? 'block' : 'none';
}

function connectorGoModeChanged() {
  const webchat = document.getElementById('cnGoMode').value === 'webchat-api';
  document.getElementById('cnWebchatSection').style.display = webchat ? 'block' : 'none';
  document.querySelectorAll('.cn-poll-field').forEach(el => { el.style.display = webchat ? 'none' : ''; });
}

// Structured ranges → "08:00-12:00, 13:00-17:00" for the per-day inputs.
function bhRangesToText(ranges) {
  return (ranges || []).map(r => `${r.start}-${r.end}`).join(', ');
}

// Parse a day input ("08:00-12:00, 13:00-17:00") → [{start,end}]. Throws an
// Error with a human message on the first malformed range so saveConnector can
// surface it before posting (the server validates the same shape again).
function bhParseDayText(text, dayLabel) {
  const out = [];
  for (const part of String(text || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(part);
    if (!m) throw new Error(`${dayLabel}: "${part}" is not a valid HH:MM-HH:MM range`);
    const sH = +m[1], sM = +m[2], eH = +m[3], eM = +m[4];
    if (sH > 23 || eH > 23 || sM > 59 || eM > 59) throw new Error(`${dayLabel}: "${part}" has an invalid time`);
    const start = `${String(sH).padStart(2, '0')}:${String(sM).padStart(2, '0')}`;
    const end = `${String(eH).padStart(2, '0')}:${String(eM).padStart(2, '0')}`;
    if (sH * 60 + sM >= eH * 60 + eM) throw new Error(`${dayLabel}: "${part}" — start must be before end (overnight ranges not supported)`);
    out.push({ start, end });
  }
  return out;
}

const BH_DAY_LABELS = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

function connectorWebhooksEnabledChanged() {
  const on = document.getElementById('cnWebhooksEnabled').checked;
  const ta = document.getElementById('cnWebhookTargets');
  ta.disabled = !on;
  ta.style.opacity = on ? '1' : '0.5';
}

function generateConnectorToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  document.getElementById('cnVerifyToken').value = token;
}

function openConnectorModal(connector = null) {
  _editingConnector = connector ? connector.name : null;
  document.getElementById('connectorModalTitle').textContent = connector ? 'Edit Connector — ' + connector.name : 'New Connector';
  document.getElementById('cnName').value = connector?.name || '';
  document.getElementById('cnName').disabled = !!connector;
  document.getElementById('cnChannel').value = connector?.channel || 'meta-whatsapp';
  document.getElementById('cnPort').value = connector?.port || '';
  document.getElementById('cnVerifyToken').value = '';
  document.getElementById('cnVerifyToken').placeholder = connector?.hasVerifyToken ? '(kept — type to replace)' : 'shared secret';
  document.getElementById('cnGoBaseUrl').value = connector?.gocontact?.baseUrl || '';
  document.getElementById('cnGoUsername').value = connector?.gocontact?.username || '';
  document.getElementById('cnGoPassword').value = '';
  document.getElementById('cnGoPassword').placeholder = connector?.gocontact?.hasPassword ? '(kept — type to replace)' : '';
  document.getElementById('cnGoHashKey').value = connector?.gocontact?.hashKey || '';
  document.getElementById('cnGoDomainUuid').value = connector?.gocontact?.domainUuid || '';
  // GoContact mode + Webchat API fields
  const go = connector?.gocontact || {};
  document.getElementById('cnGoMode').value = go.mode === 'webchat-api' ? 'webchat-api' : 'poll';
  document.getElementById('cnGoAudience').value = go.audience || '';
  document.getElementById('cnGoChannelUuid').value = go.channelUuid || '';
  document.getElementById('cnGoCallbackToken').value = '';
  document.getElementById('cnGoCallbackToken').placeholder = go.hasCallbackToken ? '(kept — type to replace)' : '';
  document.getElementById('cnGoLoginFieldMap').value = Object.entries(go.loginFieldMap || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  connectorGoModeChanged();
  document.getElementById('cnPollInterval').value = connector?.pollIntervalMs || '';
  document.getElementById('cnSessionTtl').value = connector?.sessionTtlMinutes || '';
  document.getElementById('cnMetaToken').value = '';
  document.getElementById('cnPhoneFilter').value = (connector?.phoneNumberFilter || []).join(', ');
  document.getElementById('cnAutoReplyEnabled').checked = !!connector?.autoReply?.enabled;
  document.getElementById('cnAutoReplyText').value = connector?.autoReply?.text || '';
  const arExpires = connector?.autoReply?.expiresAt || '';
  // ISO → datetime-local (local timezone, minute precision)
  let localValue = '';
  if (arExpires) {
    const d = new Date(arExpires);
    if (!isNaN(d.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      localValue = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  document.getElementById('cnAutoReplyExpires').value = localValue;
  const expiredBadge = document.getElementById('cnAutoReplyExpiredBadge');
  expiredBadge.style.display = (arExpires && Date.parse(arExpires) < Date.now() && connector?.autoReply?.enabled) ? 'inline-block' : 'none';
  connectorAutoReplyChanged();
  // Business hours
  const bh = connector?.businessHours || {};
  document.getElementById('cnBusinessHoursEnabled').checked = !!bh.enabled;
  document.getElementById('cnBusinessHoursMessage').value = bh.message || '';
  document.getElementById('cnBusinessHoursForward').checked = !!bh.forwardToGoContact;
  for (let d = 0; d <= 6; d++) {
    const day = (bh.weekly || []).find(w => w.day === d);
    document.getElementById('cnBhDay' + d).value = day ? bhRangesToText(day.ranges) : '';
  }
  connectorBusinessHoursChanged();
  document.getElementById('cnMetaToken').placeholder = connector?.meta?.hasAccessToken ? '(kept — type to replace)' : '';
  // Smooch credentials
  document.getElementById('cnSmoochAppId').value = connector?.smooch?.appId || '';
  document.getElementById('cnSmoochBaseUrl').value = (connector?.smooch?.baseUrl && connector.smooch.baseUrl !== 'https://api.smooch.io') ? connector.smooch.baseUrl : '';
  document.getElementById('cnSmoochKeyId').value = connector?.smooch?.keyId || '';
  document.getElementById('cnSmoochKeySecret').value = '';
  document.getElementById('cnSmoochKeySecret').placeholder = connector?.smooch?.hasKeySecret ? '(kept — type to replace)' : '';
  document.getElementById('cnSmoochBearer').value = '';
  document.getElementById('cnSmoochBearer').placeholder = connector?.smooch?.hasBearerToken ? '(kept — type to replace)' : '';
  document.getElementById('cnSmoochWebhookSecret').value = '';
  document.getElementById('cnSmoochWebhookSecret').placeholder = connector?.smooch?.hasWebhookSecret ? '(kept — type to replace)' : '';
  document.getElementById('cnDirectReply').checked = connector ? !!connector.directReply : false;
  document.getElementById('cnWebhookTargets').value = (connector?.webhookTargets || []).map(t => t.url).join('\n');
  document.getElementById('cnWebhooksEnabled').checked = connector ? connector.webhooksEnabled !== false : true;
  connectorWebhooksEnabledChanged();
  document.getElementById('cnAllowedIps').value = (connector?.allowedIps || []).join(', ');
  document.getElementById('cnEnabled').checked = connector ? connector.enabled !== false : true;
  connectorChannelChanged();
  document.getElementById('connectorModal').style.display = 'block';
}

function closeConnectorModal() {
  document.getElementById('connectorModal').style.display = 'none';
  _editingConnector = null;
}

async function saveConnector() {
  const body = {
    name: document.getElementById('cnName').value.trim().toLowerCase(),
    channel: document.getElementById('cnChannel').value,
    port: parseInt(document.getElementById('cnPort').value, 10) || 0,
    enabled: document.getElementById('cnEnabled').checked,
    gocontact: {
      baseUrl: document.getElementById('cnGoBaseUrl').value.trim(),
      username: document.getElementById('cnGoUsername').value.trim(),
      hashKey: document.getElementById('cnGoHashKey').value.trim(),
      domainUuid: document.getElementById('cnGoDomainUuid').value.trim() || undefined,
      mode: document.getElementById('cnGoMode').value,
      audience: document.getElementById('cnGoAudience').value.trim() || undefined,
      channelUuid: document.getElementById('cnGoChannelUuid').value.trim() || undefined,
    },
    directReply: document.getElementById('cnDirectReply').checked,
  };
  const password = document.getElementById('cnGoPassword').value;
  if (password) body.gocontact.password = password;
  const cbToken = document.getElementById('cnGoCallbackToken').value;
  if (cbToken) body.gocontact.callbackToken = cbToken;
  const lfMap = {};
  document.getElementById('cnGoLoginFieldMap').value.split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
    const i = line.indexOf('=');
    if (i > 0) lfMap[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  if (Object.keys(lfMap).length) body.gocontact.loginFieldMap = lfMap;
  const verifyToken = document.getElementById('cnVerifyToken').value.trim();
  if (verifyToken) body.verifyToken = verifyToken;
  const metaToken = document.getElementById('cnMetaToken').value.trim();
  // Always send meta when editing so the server can merge the stored token;
  // blank token = keep current. phoneNumberId is auto-captured per session.
  if (metaToken || _editingConnector) body.meta = { accessToken: metaToken || undefined };
  // Smooch creds — always send on edit so the server merges kept secrets.
  if (body.channel === 'smooch' || _editingConnector) {
    body.smooch = {
      appId: document.getElementById('cnSmoochAppId').value.trim(),
      baseUrl: document.getElementById('cnSmoochBaseUrl').value.trim() || undefined,
      keyId: document.getElementById('cnSmoochKeyId').value.trim() || undefined,
      keySecret: document.getElementById('cnSmoochKeySecret').value.trim() || undefined,
      bearerToken: document.getElementById('cnSmoochBearer').value.trim() || undefined,
      webhookSecret: document.getElementById('cnSmoochWebhookSecret').value.trim() || undefined,
    };
  }
  const phoneFilter = document.getElementById('cnPhoneFilter').value.split(',').map(s => s.trim()).filter(Boolean);
  body.phoneNumberFilter = phoneFilter;
  body.autoReply = {
    enabled: document.getElementById('cnAutoReplyEnabled').checked,
    text: document.getElementById('cnAutoReplyText').value.trim(),
  };
  const arExpiresLocal = document.getElementById('cnAutoReplyExpires').value;
  if (arExpiresLocal) body.autoReply.expiresAt = new Date(arExpiresLocal).toISOString();
  // Business hours — parse each day's ranges; surface a clean error before posting.
  const bhEnabled = document.getElementById('cnBusinessHoursEnabled').checked;
  const weekly = [];
  try {
    for (let d = 0; d <= 6; d++) {
      const ranges = bhParseDayText(document.getElementById('cnBhDay' + d).value, BH_DAY_LABELS[d]);
      if (ranges.length) weekly.push({ day: d, ranges });
    }
  } catch (e) { return toast(e.message, 'error'); }
  if (bhEnabled && !document.getElementById('cnBusinessHoursMessage').value.trim()) {
    return toast('Business hours: a message is required', 'error');
  }
  if (bhEnabled && weekly.length === 0) {
    return toast('Business hours enabled but no open hours defined — add at least one range or disable it', 'error');
  }
  body.businessHours = {
    enabled: bhEnabled,
    message: document.getElementById('cnBusinessHoursMessage').value.trim(),
    forwardToGoContact: document.getElementById('cnBusinessHoursForward').checked,
    timezone: 'Africa/Luanda',
    weekly,
  };
  const targets = document.getElementById('cnWebhookTargets').value
    .split('\n').map(s => s.trim()).filter(Boolean).map(url => ({ url }));
  if (targets.length) body.webhookTargets = targets;
  body.webhooksEnabled = document.getElementById('cnWebhooksEnabled').checked;
  const pollInterval = parseInt(document.getElementById('cnPollInterval').value, 10);
  if (pollInterval) body.pollIntervalMs = pollInterval;
  const ttl = parseInt(document.getElementById('cnSessionTtl').value, 10);
  if (ttl) body.sessionTtlMinutes = ttl;
  const ips = document.getElementById('cnAllowedIps').value.split(',').map(s => s.trim()).filter(Boolean);
  if (ips.length) body.allowedIps = ips;

  try {
    const res = await api('/admin/connectors', { method: 'POST', body: JSON.stringify(body) });
    const d = await res.json();
    if (res.ok) { toast('Connector ' + (d.status || 'saved') + ' (port ' + d.port + ')'); closeConnectorModal(); await fetchConnectors(); }
    else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function editConnector(name) {
  try {
    const res = await api('/admin/connectors/' + encodeURIComponent(name));
    if (!res.ok) return toast('Not found', 'error');
    openConnectorModal((await res.json()).connector);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteConnector(name) {
  if (!(await showConfirm({ title: 'Apagar connector', message: 'Apagar connector "' + name + '" e todas as sessões ativas?', confirmText: 'Apagar' }))) return;
  try {
    const res = await api('/admin/connectors/' + encodeURIComponent(name), { method: 'DELETE' });
    if (res.ok) { toast('Deleted'); await fetchConnectors(); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function restartConnectorAction(name) {
  try {
    const res = await api('/admin/connectors/' + encodeURIComponent(name) + '/restart', { method: 'POST' });
    const d = await res.json();
    if (res.ok) { toast('Restarted'); await fetchConnectors(); } else toast(d.error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

let _sessionsModalConnector = null;

async function openConnectorSessionsModal(name) {
  _sessionsModalConnector = name;
  document.getElementById('connectorSessionsTitle').textContent = 'Active Sessions — ' + name;
  document.getElementById('connectorSessionsModal').style.display = 'block';
  await refreshConnectorSessions();
}

function closeConnectorSessionsModal() {
  document.getElementById('connectorSessionsModal').style.display = 'none';
  _sessionsModalConnector = null;
}

async function refreshConnectorSessions() {
  if (!_sessionsModalConnector) return;
  const c = document.getElementById('connectorSessionsList');
  try {
    const res = await api('/admin/connectors/sessions?connector=' + encodeURIComponent(_sessionsModalConnector));
    const d = await res.json();
    const sessions = d.sessions || [];
    if (sessions.length === 0) { c.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3)">No active sessions.</div>'; return; }
    c.innerHTML = sessions.map(s => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:8px;background:var(--surface2);display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px">${esc(s.displayName)} <span style="color:var(--text3);font-weight:400">(${esc(s.chatId)})</span></div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">dialog: ${esc(s.dialogGroupUuid)} &middot; started ${new Date(s.createdAt).toLocaleString()} &middot; last activity ${new Date(s.lastActivityAt).toLocaleString()}</div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="closeConnectorChat('${esc(s.connector)}','${esc(s.chatId)}')">Close</button>
      </div>`).join('');
  } catch (e) { c.innerHTML = '<div style="padding:24px;text-align:center;color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

async function closeConnectorChat(connector, chatId) {
  if (!(await showConfirm({ title: 'Fechar sessão', message: 'Fechar a sessão de "' + chatId + '"? Será enviado LEAVE à GoContact.', confirmText: 'Fechar' }))) return;
  try {
    const res = await api('/admin/connectors/' + encodeURIComponent(connector) + '/sessions/' + encodeURIComponent(chatId), { method: 'DELETE' });
    if (res.ok) { toast('Session closed'); await refreshConnectorSessions(); }
    else toast((await res.json()).error || 'Failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
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

// ─── Pending Retry Modal ─────────────────────────────────────────────────────
let _prModalWebhook = null;
let _prEntries = [];
let _prSelected = new Set(); // ids selected for bulk cancel

async function openPendingRetryModal(webhookName) {
  _prModalWebhook = webhookName || null;
  document.getElementById('pendingRetryModalTitle').textContent = webhookName
    ? `Pending Retries — ${webhookName}`
    : 'Pending Retries';
  document.getElementById('pendingRetryModal').style.display = 'block';
  await refreshPendingRetryModal();
}

function closePendingRetryModal() {
  document.getElementById('pendingRetryModal').style.display = 'none';
  _prModalWebhook = null;
  _prEntries = [];
  _prSelected = new Set();
}

async function refreshPendingRetryModal() {
  try {
    const url = '/admin/webhooks/pending-retry' + (_prModalWebhook ? '?webhook=' + encodeURIComponent(_prModalWebhook) : '');
    const res = await api(url);
    const d = await res.json();
    _prEntries = d.queue || [];
    // Drop selected ids that no longer exist after the refresh.
    const live = new Set(_prEntries.map(e => e.id));
    _prSelected = new Set([..._prSelected].filter(id => live.has(id)));
    renderPendingRetryEntries();
  } catch (e) { toast('Error loading pending retries: ' + e.message, 'error'); }
}

function renderPendingRetryEntries() {
  const c = document.getElementById('pendingRetryList');
  const cancelAllBtn = document.getElementById('prCancelAllBtn');
  if (_prEntries.length === 0) {
    c.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3)">No pending retries.</div>';
    if (cancelAllBtn) cancelAllBtn.style.display = 'none';
    return;
  }
  if (cancelAllBtn) cancelAllBtn.style.display = '';

  // Group entries by destination (targetUrl) — each group is one "destinatário".
  const groups = new Map();
  for (const e of _prEntries) {
    if (!groups.has(e.targetUrl)) groups.set(e.targetUrl, []);
    groups.get(e.targetUrl).push(e);
  }

  const total = _prEntries.length;
  const selectableIds = _prEntries.filter(e => !e.running).map(e => e.id);
  const selectedCount = _prSelected.size;
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => _prSelected.has(id));

  const toolbar = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;margin-bottom:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface2)">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
        <input type="checkbox" ${allSelected ? 'checked' : ''} onclick="prToggleSelectAll(this.checked)">
        Selecionar tudo
      </label>
      <span style="flex:1"></span>
      <button class="btn btn-sm btn-danger" onclick="prCancelSelected()" ${selectedCount === 0 ? 'disabled' : ''}>
        Cancelar selecionados (${selectedCount})
      </button>
    </div>`;

  const groupsHtml = [...groups.entries()].map(([targetUrl, entries]) => {
    const groupSelectable = entries.filter(e => !e.running).map(e => e.id);
    const groupAllSelected = groupSelectable.length > 0 && groupSelectable.every(id => _prSelected.has(id));
    const header = `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 4px;margin-bottom:4px">
        <input type="checkbox" ${groupAllSelected ? 'checked' : ''} ${groupSelectable.length === 0 ? 'disabled' : ''}
          onclick="prToggleGroup('${esc(targetUrl)}', this.checked)" title="Selecionar todas deste destinatário">
        <span style="font-family:'SF Mono',Monaco,monospace;font-size:12px;color:var(--text2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(targetUrl)}">${esc(targetUrl)}</span>
        <span style="font-size:11px;color:var(--text3);white-space:nowrap">${entries.length} pendente(s)</span>
      </div>`;

    const items = entries.map(e => {
      const nextIn = Math.max(0, e.nextAttemptAt - Date.now());
      const nextLabel = e.running ? 'running…' : (nextIn < 1000 ? 'now' : `in ${Math.ceil(nextIn / 1000)}s`);
      const notifyBadge = e.notified ? '<span style="background:var(--orange-bg);color:var(--orange);padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px">notified</span>' : '';
      const checked = _prSelected.has(e.id) ? 'checked' : '';
      return `
      <div id="pr-${esc(e.id)}" style="display:flex;gap:10px;border:1px solid rgba(245,158,11,0.3);border-radius:6px;padding:10px 14px;margin-bottom:8px;background:rgba(245,158,11,0.06)">
        <input type="checkbox" ${checked} ${e.running ? 'disabled' : ''} style="margin-top:2px"
          onclick="prToggleOne('${esc(e.id)}', this.checked)">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-family:'SF Mono',Monaco,monospace;font-size:12px;color:var(--accent2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.targetUrl)}">${esc(e.method)} ${esc(e.targetUrl)}</span>
            <span style="font-size:11px;color:var(--text3);white-space:nowrap">next: ${nextLabel}</span>
          </div>
          <div style="margin-top:4px;font-size:11px;color:var(--red)">${esc(e.lastError || '')}</div>
          <div style="margin-top:2px;font-size:11px;color:var(--text3)">
            <strong style="color:var(--orange)">${e.attempts}</strong> attempts &middot; ${e.maxAttemptsPerMinute}/min &middot;
            notify @ ${esc(e.notifyEmail || 'no email')} ${notifyBadge} &middot;
            req: ${esc(e.requestId.slice(0,8))}…
          </div>
          <div style="margin-top:8px;display:flex;gap:6px">
            <button class="btn btn-sm" onclick="prRetryOne('${esc(e.id)}')" ${e.running ? 'disabled' : ''}>${e.running ? 'Running…' : 'Retry now'}</button>
            <button class="btn btn-sm btn-danger" onclick="prDismissOne('${esc(e.id)}')">Cancel</button>
          </div>
        </div>
      </div>`;
    }).join('');

    return `<div style="margin-bottom:14px">${header}${items}</div>`;
  }).join('');

  c.innerHTML = toolbar + groupsHtml;
}

function prToggleOne(id, checked) {
  if (checked) _prSelected.add(id); else _prSelected.delete(id);
  renderPendingRetryEntries();
}

function prToggleGroup(targetUrl, checked) {
  for (const e of _prEntries) {
    if (e.targetUrl !== targetUrl || e.running) continue;
    if (checked) _prSelected.add(e.id); else _prSelected.delete(e.id);
  }
  renderPendingRetryEntries();
}

function prToggleSelectAll(checked) {
  if (checked) {
    for (const e of _prEntries) if (!e.running) _prSelected.add(e.id);
  } else {
    _prSelected.clear();
  }
  renderPendingRetryEntries();
}

async function prRetryOne(id) {
  const entry = _prEntries.find(e => e.id === id);
  if (entry) entry.running = true;
  renderPendingRetryEntries();
  try {
    const res = await api(`/admin/webhooks/pending-retry/${encodeURIComponent(id)}/retry-now`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) toast('Delivered ✔');
    else toast('Still failing: ' + (d.error || res.status), 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  await refreshPendingRetryModal();
  await fetchWebhooks();
}

async function prDismissOne(id) {
  if (!(await showConfirm({ title: 'Cancelar nova tentativa', message: 'Cancelar esta nova tentativa pendente? A entrega será abandonada.', confirmText: 'Cancelar entrega' }))) return;
  try {
    const res = await api(`/admin/webhooks/pending-retry/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) { await refreshPendingRetryModal(); await fetchWebhooks(); }
    else toast('Cancel failed', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function prCancelSelected() {
  const ids = [..._prSelected];
  if (ids.length === 0) return;
  if (!(await showConfirm({
    title: 'Cancelar novas tentativas selecionadas',
    message: `Cancelar ${ids.length} nova(s) tentativa(s) selecionada(s)? As entregas serão abandonadas.`,
    confirmText: 'Cancelar selecionados',
  }))) return;
  try {
    const res = await api('/admin/webhooks/pending-retry/cancel-all', {
      method: 'POST',
      body: JSON.stringify({ webhook: _prModalWebhook || undefined, ids }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) toast(`${d.removed ?? 0} nova(s) tentativa(s) cancelada(s)`);
    else toast('Falha ao cancelar', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  await refreshPendingRetryModal();
  await fetchWebhooks();
}

async function prCancelAll() {
  const count = _prEntries.length;
  if (!count) return;
  if (!(await showConfirm({
    title: 'Cancelar todas as novas tentativas',
    message: `Cancelar todas as ${count} novas tentativas pendentes${_prModalWebhook ? ' de "' + _prModalWebhook + '"' : ''}? As entregas serão abandonadas. (As que estiverem a correr neste momento serão mantidas.)`,
    confirmText: 'Cancelar todas',
  }))) return;
  const btn = document.getElementById('prCancelAllBtn');
  if (btn) btn.disabled = true;
  try {
    const body = _prModalWebhook ? { webhook: _prModalWebhook } : {};
    const res = await api('/admin/webhooks/pending-retry/cancel-all', { method: 'POST', body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) toast(`${d.removed ?? 0} nova(s) tentativa(s) cancelada(s)`);
    else toast('Falha ao cancelar', 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  if (btn) btn.disabled = false;
  await refreshPendingRetryModal();
  await fetchWebhooks();
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
    const resolve = (path) => {
        let val = data;
        for (const k of path.split('.')) {
            if (val === undefined || val === null) return undefined;
            val = val[k];
        }
        return val;
    };
    return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, expr) => {
        const operands = String(expr).split(/\s*\|\|\s*/);
        for (const raw of operands) {
            const op = raw.trim();
            if (!op) continue;
            const lit = op.match(/^(['"])(.*)\1$/);
            if (lit) return lit[2];
            if (!/^[a-zA-Z0-9_.-]+$/.test(op)) continue;
            const val = resolve(op);
            if (val === undefined || val === null || val === '') continue;
            return typeof val === 'object' ? JSON.stringify(val) : String(val);
        }
        return '';
    });
}

function stripEmptyDeepJS(value) {
    if (Array.isArray(value)) {
        return value.map(stripEmptyDeepJS).filter(v => v !== undefined && v !== null && v !== '');
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const c = stripEmptyDeepJS(v);
            if (c === undefined || c === null || c === '') continue;
            if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
            if (Array.isArray(c) && c.length === 0) continue;
            out[k] = c;
        }
        return out;
    }
    return value;
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

function flattenPayloadPaths(obj, prefix = '', out = [], depth = 0) {
    if (depth > 5) return out;
    if (obj === null || obj === undefined) return out;
    if (Array.isArray(obj)) {
        // Expose array itself + first few indices
        if (prefix) out.push({ path: prefix, kind: 'array', sample: `[${obj.length} items]` });
        const limit = Math.min(obj.length, 5);
        for (let i = 0; i < limit; i++) {
            flattenPayloadPaths(obj[i], prefix ? `${prefix}.${i}` : `${i}`, out, depth + 1);
        }
        return out;
    }
    if (typeof obj === 'object') {
        if (prefix) out.push({ path: prefix, kind: 'object', sample: '{…}' });
        for (const k of Object.keys(obj)) {
            const next = prefix ? `${prefix}.${k}` : k;
            flattenPayloadPaths(obj[k], next, out, depth + 1);
        }
        return out;
    }
    // primitive
    let sample = String(obj);
    if (sample.length > 40) sample = sample.slice(0, 40) + '…';
    out.push({ path: prefix, kind: typeof obj, sample });
    return out;
}

function getCurrentTestPayloadObject() {
    const raw = (document.getElementById('wTestPayload')?.value || '').trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function renderBodyEditorFieldsPanel() {
    const list = document.getElementById('bodyEditorFieldsList');
    if (!list) return;
    const payload = getCurrentTestPayloadObject();
    if (!payload) {
        list.innerHTML = `<div style="padding:12px;color:var(--text3);font-size:11px;font-family:inherit">
            Cole um Test Payload (JSON) válido na seção anterior para ver os campos disponíveis aqui.
        </div>`;
        return;
    }
    const paths = flattenPayloadPaths(payload);
    if (paths.length === 0) {
        list.innerHTML = `<div style="padding:12px;color:var(--text3);font-size:11px;font-family:inherit">No fields detected.</div>`;
        return;
    }
    const colorFor = (kind) => {
        if (kind === 'string') return 'var(--green, #4ade80)';
        if (kind === 'number') return 'var(--accent, #3b82f6)';
        if (kind === 'boolean') return 'var(--orange, #fb923c)';
        if (kind === 'object' || kind === 'array') return 'var(--text3)';
        return 'var(--text2)';
    };
    const stats = mergedSchemaStats;
    list.innerHTML = paths.map(p => {
        const safePath = p.path.replace(/"/g, '&quot;');
        const safeSample = String(p.sample).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let freqBadge = '';
        if (stats && stats.total > 0) {
            // Normalise array-index segments to "0" since merged payload uses 0; counts were collected with 0.
            const key = p.path.replace(/\.\d+/g, m => m); // already uses .0 for arrays, so same shape
            const seen = stats.counts.get(key);
            if (seen !== undefined) {
                const pct = Math.round((seen / stats.total) * 100);
                const color = pct === 100 ? 'var(--green, #4ade80)' : (pct >= 50 ? 'var(--orange, #fb923c)' : 'var(--red, #f87171)');
                freqBadge = `<span title="Present in ${seen} of ${stats.total} sampled payloads" style="color:${color};font-size:10px;flex-shrink:0">${pct}%</span>`;
            } else {
                freqBadge = `<span title="Not seen in sampled payloads (synthesised)" style="color:var(--text3);font-size:10px;flex-shrink:0">—</span>`;
            }
        }
        return `<div class="bep-field" data-path="${safePath}" title="Click to insert {{${safePath}}}"
            style="padding:4px 12px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid rgba(255,255,255,0.03);align-items:center">
            <span style="color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${safePath}</span>
            ${freqBadge}
            <span style="color:${colorFor(p.kind)};opacity:.75;flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeSample}</span>
        </div>`;
    }).join('');
    list.querySelectorAll('.bep-field').forEach(el => {
        el.addEventListener('mouseenter', () => { el.style.background = 'rgba(255,255,255,0.05)'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
        el.addEventListener('click', () => {
            const path = el.getAttribute('data-path');
            insertTemplateAtCursor(`{{${path}}}`);
        });
    });
}

function insertTemplateAtCursor(text) {
    if (!fullEditor) return;
    fullEditor.insert(text);
    fullEditor.focus();
}

function buildBodyEditorCompleter() {
    return {
        getCompletions: function(editor, session, pos, prefix, callback) {
            // Only suggest when cursor is inside an unclosed {{ ... }}
            const line = session.getLine(pos.row).slice(0, pos.column);
            const openIdx = line.lastIndexOf('{{');
            const closeIdx = line.lastIndexOf('}}');
            if (openIdx === -1 || closeIdx > openIdx) {
                callback(null, []);
                return;
            }
            const payload = getCurrentTestPayloadObject();
            if (!payload) { callback(null, []); return; }
            const paths = flattenPayloadPaths(payload);
            const completions = paths.map(p => ({
                caption: p.path,
                value: p.path,
                meta: p.kind === 'object' || p.kind === 'array' ? p.kind : `${p.kind}: ${p.sample}`,
                score: 1000
            }));
            callback(null, completions);
        },
        identifierRegexps: [/[a-zA-Z_0-9.\-]/]
    };
}

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
            showGutter: true,
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: true,
            enableSnippets: false
        });
        try {
            const langTools = ace.require('ace/ext/language_tools');
            if (langTools) {
                langTools.setCompleters([buildBodyEditorCompleter()]);
            }
        } catch (e) { /* language_tools unavailable — sidebar still works */ }
    }

    fullEditor.setValue(content, -1);
    renderBodyEditorFieldsPanel();
    setBodyEditorStatus('', 'info');
    fullEditor.focus();
}

function closeBodyEditor() {
    document.getElementById('bodyEditorModal').style.display = 'none';
    currentFullEditorIndex = -1;
}

function setBodyEditorStatus(msg, kind) {
    const el = document.getElementById('bodyEditorStatus');
    if (!el) return;
    const colors = { ok: 'var(--green, #4ade80)', err: 'var(--red, #f87171)', info: 'var(--text3)' };
    el.style.color = colors[kind] || colors.info;
    el.textContent = msg || '';
}

function validateBodyTemplate(content) {
    // Empty is allowed (means: forward original body)
    if (!content.trim()) return { ok: true, empty: true };

    const payload = getCurrentTestPayloadObject();
    // If user has a test payload, validate the *interpolated* result.
    // Otherwise, replace {{...}} with null so we can still check JSON shape.
    let rendered;
    if (payload) {
        rendered = renderTemplateJS(content, payload);
    } else {
        rendered = content.replace(/\{\{\s*[^{}]+?\s*\}\}/g, 'null');
    }
    try {
        const parsed = JSON.parse(rendered);
        return { ok: true, rendered, parsed, usedPayload: !!payload };
    } catch (e) {
        return { ok: false, error: e.message, rendered, usedPayload: !!payload };
    }
}

function testBodyEditor() {
    if (!fullEditor) return;
    const content = fullEditor.getValue();
    const result = validateBodyTemplate(content);
    if (result.empty) {
        setBodyEditorStatus('Empty template — original payload will be forwarded.', 'info');
        return;
    }
    if (result.ok) {
        const suffix = result.usedPayload ? ' (with test payload)' : ' (no test payload — placeholders treated as null)';
        setBodyEditorStatus('Valid JSON' + suffix, 'ok');
    } else {
        const suffix = result.usedPayload ? ' after interpolation' : '';
        setBodyEditorStatus('Invalid JSON' + suffix + ': ' + result.error, 'err');
    }
}

function saveBodyEditor() {
    if (currentFullEditorIndex === -1) return;
    const content = fullEditor.getValue();
    const result = validateBodyTemplate(content);
    if (!result.ok) {
        const suffix = result.usedPayload ? ' after interpolation' : '';
        setBodyEditorStatus('Cannot apply — invalid JSON' + suffix + ': ' + result.error, 'err');
        return;
    }
    webhookTargetState[currentFullEditorIndex].bodyTemplate = content;

    // Sync back to small editor
    if (aceEditors[currentFullEditorIndex]) {
        aceEditors[currentFullEditorIndex].setValue(content, -1);
    }

    updateAllPreviews();
    closeBodyEditor();
}

function updateAllPreviews() {
  if (document.getElementById('bodyEditorModal')?.style.display === 'block') {
    renderBodyEditorFieldsPanel();
  }
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
                  let stripped = false;
                  try {
                      let parsed = JSON.parse(outBody);
                      if (t.dropEmpty) { parsed = stripEmptyDeepJS(parsed); stripped = true; }
                      outBody = JSON.stringify(parsed, null, 2);
                  } catch {}
                  pBody.textContent = (stripped ? 'Evaluates to (after drop empty):\n' : 'Evaluates to:\n') + outBody;
              }
              pBody.style.display = 'block';
          } else {
              pBody.style.display = 'none';
          }
      }
    }
  });
}

// Tracks how often each path appeared across the merged sample. Path -> { seen, total }.
let mergedSchemaStats = null;

function mergeShapes(a, b) {
    // Merge `b` into `a`, recursively. Both are JS values.
    if (a === undefined) return b;
    if (b === undefined || b === null) return a;
    if (a === null) return b;
    const ta = Array.isArray(a) ? 'array' : typeof a;
    const tb = Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb) return a; // first-seen type wins for primitives mismatch
    if (ta === 'object') {
        for (const k of Object.keys(b)) {
            a[k] = mergeShapes(a[k], b[k]);
        }
        return a;
    }
    if (ta === 'array') {
        // Merge all elements into a single representative element at index 0,
        // then keep the longest array seen (caps at 3 to stay readable).
        let rep = a[0];
        for (const item of b) rep = mergeShapes(rep, item);
        const desiredLen = Math.min(Math.max(a.length, b.length), 3);
        const out = [];
        for (let i = 0; i < desiredLen; i++) out.push(rep);
        return out;
    }
    return a; // primitives: keep first
}

function collectPathsFromObject(obj, prefix, set, depth = 0) {
    if (depth > 6 || obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
        if (prefix) set.add(prefix);
        if (obj.length > 0) collectPathsFromObject(obj[0], prefix ? `${prefix}.0` : '0', set, depth + 1);
        return;
    }
    if (typeof obj === 'object') {
        if (prefix) set.add(prefix);
        for (const k of Object.keys(obj)) {
            collectPathsFromObject(obj[k], prefix ? `${prefix}.${k}` : k, set, depth + 1);
        }
        return;
    }
    if (prefix) set.add(prefix);
}

async function fetchAndMergeWebhookPayloads() {
    try {
        let url = '/admin/requests?type=webhook&limit=50';
        if (editingWebhook && editingWebhook.name) {
            url += '&target=' + encodeURIComponent(editingWebhook.name);
        }
        const res = await api(url);
        if (!res.ok) return toast('Could not fetch payloads', 'error');
        const d = await res.json();
        const items = (d.requests || []).filter(r => r.reqBody);
        if (items.length === 0) return toast('No recent webhook payloads found', 'warning');

        let merged;
        const pathCounts = new Map();
        let parsed = 0;
        for (const r of items) {
            let obj;
            try { obj = JSON.parse(r.reqBody); } catch { continue; }
            parsed++;
            merged = merged === undefined ? obj : mergeShapes(merged, obj);
            const seen = new Set();
            collectPathsFromObject(obj, '', seen);
            for (const p of seen) pathCounts.set(p, (pathCounts.get(p) || 0) + 1);
        }
        if (parsed === 0 || merged === undefined) return toast('No JSON payloads to merge', 'warning');

        mergedSchemaStats = { total: parsed, counts: pathCounts };
        const pretty = JSON.stringify(merged, null, 2);
        document.getElementById('wTestPayload').value = pretty;
        if (!showTestPayload) toggleTestPayload();
        else updateAllPreviews();
        toast(`Merged ${parsed} payloads — ${pathCounts.size} unique fields`);
    } catch { toast('Error merging payloads', 'error'); }
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
    webhookTargetState.push({ type: 'basic', url: target, method: 'POST', bodyTemplate: '', customBody: false, dropEmpty: false, customHeaders: [], forwardHeaders: false, retry: null, retryOpen: false, persistentRetry: null, persistentRetryOpen: false });
  } else {
    const headersArr = [];
    if (target.customHeaders) {
        for (const [k, v] of Object.entries(target.customHeaders)) {
            headersArr.push({ key: k, value: v });
        }
    }
    // A destination is "basic" if it has no method override, no custom headers,
    // no body template, and no forwardHeaders — only retry/persistent fields.
    const isBasicShape = !target.method && headersArr.length === 0
        && !target.bodyTemplate && !target.dropEmpty && target.forwardHeaders !== true;
    webhookTargetState.push({
      type: isBasicShape ? 'basic' : 'custom',
      url: target.url || '',
      method: target.method || 'POST',
      bodyTemplate: target.bodyTemplate || '',
      customBody: !!target.bodyTemplate,
      dropEmpty: target.dropEmpty === true,
      customHeaders: headersArr,
      forwardHeaders: target.forwardHeaders === true,
      retry: target.retry || null,
      retryOpen: !!target.retry,
      persistentRetry: target.persistentRetry || null,
      persistentRetryOpen: !!(target.persistentRetry && target.persistentRetry.enabled),
    });
  }
  renderWebhookTargets();
}

function toggleTargetRetry(index) {
  const t = webhookTargetState[index];
  t.retryOpen = !t.retryOpen;
  if (t.retryOpen) {
    if (!t.retry) t.retry = { maxRetries: 3, retryDelayMs: 1000, backoff: 'exponential', retryUntilSuccess: false };
    // Mutually exclusive with persistent retry
    if (t.persistentRetryOpen) {
      t.persistentRetryOpen = false;
      if (t.persistentRetry) t.persistentRetry.enabled = false;
    }
  }
  renderWebhookTargets();
}

function updateTargetRetry(index, field, value) {
  if (!webhookTargetState[index].retry) return;
  webhookTargetState[index].retry[field] = value;
}

function toggleTargetPersistentRetry(index) {
  const t = webhookTargetState[index];
  t.persistentRetryOpen = !t.persistentRetryOpen;
  if (t.persistentRetryOpen) {
    if (!t.persistentRetry) t.persistentRetry = { enabled: true, maxAttemptsPerMinute: 10, notifyAfterAttempts: 10, notifyEmail: '' };
    else t.persistentRetry.enabled = true;
    // Mutually exclusive with the bounded retry override
    if (t.retryOpen) {
      t.retryOpen = false;
    }
  } else if (t.persistentRetry) {
    t.persistentRetry.enabled = false;
  }
  renderWebhookTargets();
}

function updateTargetPersistentRetry(index, field, value) {
  if (!webhookTargetState[index].persistentRetry) {
    webhookTargetState[index].persistentRetry = { enabled: true, maxAttemptsPerMinute: 10, notifyAfterAttempts: 10, notifyEmail: '' };
  }
  webhookTargetState[index].persistentRetry[field] = value;
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
              <div style="font-size:10px;color:var(--text3);margin-top:3px;margin-left:2px">Supports JSON + <code style="background:rgba(0,120,212,0.15);padding:1px 4px;border-radius:3px;color:var(--accent);font-size:10px">{{template.vars}}</code> + fallback <code style="background:rgba(0,120,212,0.15);padding:1px 4px;border-radius:3px;color:var(--accent);font-size:10px">{{a || b || "x"}}</code></div>
              <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;user-select:none;margin-top:6px">
                <input type="checkbox" ${t.dropEmpty ? 'checked' : ''} onchange="updateWebhookTargetField(${i}, 'dropEmpty', this.checked); updateAllPreviews()" style="cursor:pointer;accent-color:var(--accent)">
                <span>Drop null/empty fields on delivery</span>
                <span style="color:var(--text3);font-size:10px">— remove keys whose value renders to null or "" before sending</span>
              </label>
              <div id="previewBody_${i}" style="display:none;font-size:10px;color:var(--accent);margin-top:2px;margin-left:4px;white-space:pre-wrap;font-family:monospace"></div>
              ` : `<div id="aceBody_${i}" style="display:none"></div><div id="previewBody_${i}" style="display:none"></div>`}
            </div>
          </div>
        ` : ''}

        <!-- Per-destination retry override -->
        <div class="destination-retry-override" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:${t.persistentRetryOpen ? 'var(--text3)' : 'var(--text2)'};cursor:${t.persistentRetryOpen ? 'not-allowed' : 'pointer'}" onclick="${t.persistentRetryOpen ? 'return false' : `toggleTargetRetry(${i});return false`}" title="${t.persistentRetryOpen ? 'Disabled — Persistent retry is enabled below' : ''}">
            <input type="checkbox" ${t.retryOpen ? 'checked' : ''} ${t.persistentRetryOpen ? 'disabled' : ''} onclick="event.preventDefault()">
            Override retry for this destination${t.persistentRetryOpen ? ' <span style="color:var(--text3);font-size:10px">(disabled — using persistent retry)</span>' : ''}
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

        <!-- Per-destination PERSISTENT retry (never gives up) -->
        <div class="destination-persistent-retry" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:${t.retryOpen ? 'var(--text3)' : 'var(--text2)'};cursor:${t.retryOpen ? 'not-allowed' : 'pointer'}" onclick="${t.retryOpen ? 'return false' : `toggleTargetPersistentRetry(${i});return false`}" title="${t.retryOpen ? 'Disabled — Override retry is enabled above' : ''}">
            <input type="checkbox" ${t.persistentRetryOpen ? 'checked' : ''} ${t.retryOpen ? 'disabled' : ''} onclick="event.preventDefault()">
            <strong style="color:${t.retryOpen ? 'var(--text3)' : 'var(--orange)'}">Persistent retry</strong> — never give up (for payments, etc.)${t.retryOpen ? ' <span style="color:var(--text3);font-size:10px">(disabled — using bounded retry)</span>' : ''}
          </label>
          ${t.persistentRetryOpen ? `
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;padding:8px;background:rgba(245,158,11,0.06);border-radius:4px;border:1px solid rgba(245,158,11,0.3)">
            <div style="font-size:10px;color:var(--text3);line-height:1.5">
              Failures keep retrying forever at the rate below. Entries are persisted across restarts. Use the Pending Retries panel to inspect or cancel.
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
              <div>
                <label style="font-size:10px;color:var(--text3);display:block;margin-bottom:2px">Max attempts per minute</label>
                <input type="number" min="1" max="60" value="${t.persistentRetry?.maxAttemptsPerMinute ?? 10}" oninput="updateTargetPersistentRetry(${i},'maxAttemptsPerMinute',+this.value)" style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11px;outline:none">
              </div>
              <div>
                <label style="font-size:10px;color:var(--text3);display:block;margin-bottom:2px">Notify after N failures</label>
                <input type="number" min="1" max="10000" value="${t.persistentRetry?.notifyAfterAttempts ?? 10}" oninput="updateTargetPersistentRetry(${i},'notifyAfterAttempts',+this.value)" style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11px;outline:none">
              </div>
            </div>
            <div>
              <label style="font-size:10px;color:var(--text3);display:block;margin-bottom:2px">Legacy notify email <span style="opacity:.7">(optional — kept for back-compat)</span></label>
              <input type="email" value="${esc(t.persistentRetry?.notifyEmail || '')}" placeholder="alerts@example.com" oninput="updateTargetPersistentRetry(${i},'notifyEmail',this.value)" style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11px;outline:none">
              <p style="font-size:10.5px;color:var(--text3);margin:4px 0 0;line-height:1.5">Alerts are now routed centrally. Add a rule for <code style="background:var(--surface2);padding:1px 4px;border-radius:3px;font-size:10px">webhook.retry_exhausted</code> in <a href="#" onclick="navigate('notifications');return false" style="color:var(--accent);text-decoration:none">Notifications</a> to reach groups via email + SMS.</p>
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
  
  // The auth token is never sent back to the client. Leave the field empty and
  // signal that one is already configured via the placeholder; submitting an
  // empty field preserves the existing token server-side.
  const wAuthTokenEl = document.getElementById('wAuthToken');
  wAuthTokenEl.value = '';
  wAuthTokenEl.placeholder = (webhook && webhook.hasAuthToken)
    ? '•••••••• (configurado — deixe vazio para manter)'
    : '';
  IpTagInput.setValue('wAllowedIps', webhook?.allowedIps || []);
  // Private/internal destinations are allowed by default; checkbox reflects the
  // stored value (true unless explicitly disabled), checked for new webhooks.
  document.getElementById('wAllowPrivateTargets').checked = webhook ? (webhook.allowPrivateTargets !== false) : true;
  IpTagInput.setValue('wTargetAllowedCidrs', webhook?.targetAllowedCidrs || []);

  // Restore persisted test payload (used by the body template editor preview)
  const savedTp = webhook?.testPayload || '';
  document.getElementById('wTestPayload').value = savedTp;
  mergedSchemaStats = null;
  showTestPayload = !!savedTp;
  document.getElementById('wTestPayloadContainer').style.display = showTestPayload ? 'block' : 'none';

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

  // Populate silence alert config
  const sa = webhook?.silenceAlert;
  const saEnabled = !!(sa && sa.enabled);
  document.getElementById('wSilenceEnabled').checked = saEnabled;
  document.getElementById('wSilenceSection').style.display = saEnabled ? 'flex' : 'none';
  document.getElementById('wSilenceThreshold').value = sa?.thresholdMinutes ?? 15;
  document.getElementById('wSilenceEmail').value = sa?.notifyEmail ?? '';

  // Adopted-from-NPM banner
  const banner = document.getElementById('wAdoptedBanner');
  const info = document.getElementById('wAdoptedInfo');
  if (banner && info) {
    if (webhook && webhook.npmProxyHostId && webhook.npmOriginalForwardHost) {
      banner.style.display = 'flex';
      info.textContent = '#' + webhook.npmProxyHostId + ' — original forward ' + (webhook.npmOriginalForwardScheme || 'http') + '://' + webhook.npmOriginalForwardHost + ':' + webhook.npmOriginalForwardPort;
    } else {
      banner.style.display = 'none';
    }
  }

  document.getElementById('webhookModal').style.display = 'flex';
}

async function releaseWebhookFromNpm() {
  if (!editingWebhook || !editingWebhook.name) return;
  if (!(await showConfirm({ title: 'Libertar webhook', message: 'Libertar este webhook do host NPM? O NPM será restaurado para o destino de encaminhamento original.', confirmText: 'Libertar' }))) return;
  try {
    const res = await api('/admin/webhooks/' + encodeURIComponent(editingWebhook.name) + '/npm-release', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.ok === false) return toast(data.error || 'Release failed', 'error');
    toast('Released from NPM');
    document.getElementById('wAdoptedBanner').style.display = 'none';
    closeWebhookModal();
    await fetchWebhooks();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

function toggleSilenceSection() {
  const cb = document.getElementById('wSilenceEnabled');
  document.getElementById('wSilenceSection').style.display = cb.checked ? 'flex' : 'none';
}

function closeWebhookModal() { document.getElementById('webhookModal').style.display = 'none'; editingWebhook = null; }

async function saveWebhook() {
  const targetsRaw = [];
  for (const t of webhookTargetState) {
      if (!t.url.trim()) continue;
      const hasRetryOverride = t.retryOpen && t.retry;
      const hasPersistent = t.persistentRetryOpen && t.persistentRetry && t.persistentRetry.enabled;

      // Basic forward with no retry override stays as a plain URL string.
      if (t.type === 'basic' && !hasRetryOverride && !hasPersistent) {
          targetsRaw.push(t.url.trim());
          continue;
      }

      // Otherwise promote to a WebhookDestination object. Custom-action fields
      // are only emitted when this destination is actually in custom mode —
      // a basic destination with just a retry override stays clean.
      const dest = { url: t.url.trim() };
      if (t.type === 'custom') {
          let headersObj = undefined;
          if (t.customHeaders && t.customHeaders.length > 0) {
              headersObj = {};
              for (const h of t.customHeaders) {
                  if (h.key.trim()) headersObj[h.key.trim()] = h.value.trim();
              }
              if (Object.keys(headersObj).length === 0) headersObj = undefined;
          }
          dest.method = t.method || 'POST';
          dest.customHeaders = headersObj;
          dest.forwardHeaders = t.forwardHeaders;
          dest.bodyTemplate = (t.customBody && t.bodyTemplate.trim()) ? t.bodyTemplate.trim() : undefined;
          dest.dropEmpty = (t.customBody && t.dropEmpty) ? true : undefined;
      }
      if (hasRetryOverride) dest.retry = t.retry;
      if (hasPersistent) {
          dest.persistentRetry = {
              enabled: true,
              maxAttemptsPerMinute: t.persistentRetry.maxAttemptsPerMinute || 10,
              notifyAfterAttempts: t.persistentRetry.notifyAfterAttempts || 10,
              notifyEmail: (t.persistentRetry.notifyEmail || '').trim() || undefined,
          };
      }
      targetsRaw.push(dest);
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
  body.allowPrivateTargets = document.getElementById('wAllowPrivateTargets').checked;
  const wCidrs = IpTagInput.getValue('wTargetAllowedCidrs'); if (wCidrs.length) body.targetAllowedCidrs = wCidrs;

  const tp = (document.getElementById('wTestPayload').value || '').trim();
  if (tp) body.testPayload = tp;

  if (document.getElementById('wSilenceEnabled').checked) {
    const thr = parseInt(document.getElementById('wSilenceThreshold').value) || 0;
    const email = document.getElementById('wSilenceEmail').value.trim();
    if (!thr || thr < 1) return toast('Silence threshold must be at least 1 minute', 'error');
    // notifyEmail is now optional — when empty, the silence alert relies
    // entirely on the central notifications pipeline (rules → groups).
    body.silenceAlert = { enabled: true, thresholdMinutes: thr, notifyEmail: email };
  } else {
    body.silenceAlert = { enabled: false, thresholdMinutes: 15, notifyEmail: '' };
  }

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
  if (!(await showConfirm({ title: 'Apagar webhook', message: 'Apagar webhook "' + name + '"?', confirmText: 'Apagar' }))) return;
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
    if (search && document.getElementById('rlSearchBody')?.checked) params.set('searchBody', '1');
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
    const [fRes, dlqRes, prRes] = await Promise.all([
      api('/admin/requests?limit=100&type=webhook-fanout&search=' + reqId),
      api('/admin/webhooks/dlq'),
      api('/admin/webhooks/pending-retry?requestId=' + encodeURIComponent(reqId)),
    ]);
    if (!fRes.ok) throw new Error('Failed to load fanouts');
    const data = await fRes.json();
    const dlqByTarget = {};
    if (dlqRes.ok) {
      const dq = (await dlqRes.json()).queue || [];
      for (const e of dq) if (e.requestId === reqId) dlqByTarget[e.targetUrl] = e;
    }
    const pendingByTarget = {};
    if (prRes.ok) {
      const pq = (await prRes.json()).queue || [];
      for (const e of pq) pendingByTarget[e.targetUrl] = e;
    }
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
      const pending = pendingByTarget[f.targetUrl];
      const dlq = dlqByTarget[f.targetUrl];
      let retryBtn = '';
      let extraBadge = '';
      if (pending) {
        extraBadge = ` <span style="background:rgba(245,158,11,0.18);color:var(--orange);padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px" title="Persistent retry — ${pending.attempts} attempts so far">🔄 ${pending.attempts}</span>`;
        retryBtn = `<button class="btn btn-sm" onclick="fanoutRetryPending('${esc(pending.id)}',this,'${esc(reqId)}')" style="font-size:11px;padding:3px 8px;margin-right:4px" title="Force an immediate retry attempt">Retry now</button>`;
      } else if (dlq) {
        extraBadge = ` <span style="background:var(--red-bg);color:var(--red);padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:4px" title="In DLQ">DLQ</span>`;
        retryBtn = `<button class="btn btn-sm" onclick="fanoutRetryDlq('${esc(dlq.id)}',this,'${esc(reqId)}')" style="font-size:11px;padding:3px 8px;margin-right:4px" title="Retry from the dead-letter queue">Retry</button>`;
      }
      return `<tr style="border-bottom:1px solid var(--border);transition:background 0.15s" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
        <td style="padding:10px 16px;color:var(--text2)">${ts}</td>
        <td style="padding:10px 16px">${statusHtml}${attemptBadge}${extraBadge}</td>
        <td style="padding:10px 16px;font-family:monospace;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.targetUrl)}">${esc(f.targetUrl)}</td>
        <td style="padding:10px 16px;color:var(--text2)">${f.durationMs ? fmtMs(f.durationMs) : '-'}</td>
        <td style="padding:10px 16px;text-align:right">${retryBtn}<button class="btn btn-sm" onclick="openReqDetail(${f.id})" style="font-size:11px;padding:3px 8px">Details</button></td>
      </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('fanoutDeliveriesList').innerHTML = `<tr><td colspan="5" style="padding:20px;color:var(--red);text-align:center">Error: ${esc(e.message)}</td></tr>`;
  }
}

async function fanoutRetryPending(id, btn, reqId) {
  if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }
  try {
    const res = await api(`/admin/webhooks/pending-retry/${encodeURIComponent(id)}/retry-now`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) toast('Delivered ✔'); else toast('Retry failed: ' + (d.error || res.status), 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  await loadFanoutDeliveries(reqId);
}

async function fanoutRetryDlq(id, btn, reqId) {
  if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }
  try {
    const res = await api(`/admin/webhooks/dlq/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) toast('Delivered ✔'); else toast('Retry failed: ' + (d.error || res.status), 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  await loadFanoutDeliveries(reqId);
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
    const badge = document.getElementById('navTcpUdpBadge');
    if (badge) badge.textContent = String(_allTcpUdpProxies.length);
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
  populateSipCertDropdown(proxy && proxy.certId);
  toggleSipTlsSection();
  document.getElementById('sipLogConnections').checked = !!(proxy && proxy.logConnections);
  document.getElementById('sipLogMessages').checked = !!(proxy && proxy.logMessages);
  document.getElementById('sipLogMessageBody').checked = !!(proxy && proxy.logMessageBody);
  document.getElementById('sipLogNoise').checked = !!(proxy && proxy.logNoise);
  toggleSipLogOptions();
  document.getElementById('sipModal').classList.add('active');
  document.getElementById('sipName').focus();
}

function toggleSipLogOptions() {
  const on = document.getElementById('sipLogMessages').checked;
  const body = document.getElementById('sipLogMessageBody');
  const noise = document.getElementById('sipLogNoise');
  body.disabled = !on;
  noise.disabled = !on;
  if (!on) {
    body.checked = false;
    noise.checked = false;
  }
  body.parentElement.style.opacity = on ? '1' : '0.5';
  noise.parentElement.style.opacity = on ? '1' : '0.5';
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

async function populateSipCertDropdown(selectedId) {
  const sel = document.getElementById('sipCertId');
  if (!sel) return;
  try {
    const res = await api('/admin/certs');
    if (!res.ok) return;
    const data = await res.json();
    const opts = (data.certs || []).map(c => {
      const statusBadge = c.status === 'active' ? '' : ' [' + c.status + ']';
      return '<option value="' + c.id + '">' + esc(c.domain) + ' (' + c.source + ')' + statusBadge + '</option>';
    }).join('');
    sel.innerHTML = '<option value="">— select a certificate —</option>' + opts;
    if (selectedId) sel.value = String(selectedId);
  } catch {}
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
  const allowedIpsRaw = document.getElementById('sipAllowedIps').value;
  const certIdRaw = document.getElementById('sipCertId').value;
  const certId = certIdRaw ? parseInt(certIdRaw, 10) : undefined;
  if (hasTls && !certId) {
    errEl.textContent = 'TLS listener requires a certificate. Pick one or create one under Settings → Certificates.';
    errEl.style.display = 'block';
    return;
  }

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
    logMessages: document.getElementById('sipLogMessages').checked,
    logMessageBody: document.getElementById('sipLogMessageBody').checked,
    logNoise: document.getElementById('sipLogNoise').checked,
    logConnections: document.getElementById('sipLogConnections').checked,
    certId,
  };

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
  if (!(await showConfirm({ title: 'Apagar proxy TCP/UDP', message: 'Apagar proxy TCP/UDP "' + name + '"? O listener será parado imediatamente.', confirmText: 'Apagar' }))) return;
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
  if (!pkceRequired && !(await showConfirm({ title: 'Desativar PKCE', message: 'Desativar PKCE para este cliente?', detail: 'Isto remove uma defesa de segurança (proteção contra interceção de auth-code). Faz isto apenas para clientes legados que não conseguem enviar um code_challenge.', confirmText: 'Desativar PKCE' }))) return;
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
  if (urisChanged && !(await showConfirm({ title: 'Alterar redirect URIs', message: 'Alterar as redirect URIs irá revogar todos os refresh tokens deste cliente. Continuar?', confirmText: 'Alterar' }))) return;
  const consentEnabled = document.getElementById('oauthClientConsentEnabled').checked;
  const consentPageRaw = document.getElementById('oauthClientConsentPageId').value;
  const consentPageId = consentPageRaw ? Number(consentPageRaw) : null;
  if (consentEnabled && !consentPageId) {
    return toast('Choose a consent page or disable consent.', 'error');
  }
  const pkceRequired = document.getElementById('oauthClientPkceRequired').checked;
  if (!pkceRequired && !(await showConfirm({ title: 'Desativar PKCE', message: 'Desativar PKCE para este cliente?', detail: 'Isto remove uma defesa de segurança (proteção contra interceção de auth-code). Faz isto apenas para clientes legados que não conseguem enviar um code_challenge.', confirmText: 'Desativar PKCE' }))) return;
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
  if (!(await showConfirm({ title: 'Apagar cliente OAuth', message: 'Apagar cliente "' + name + '"? Todos os tokens emitidos serão revogados.', confirmText: 'Apagar' }))) return;
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
  if (!(await showConfirm({ title: 'Remover acesso', message: 'Remover "' + username + '" do acesso deste cliente?', confirmText: 'Remover' }))) return;
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
  if (!(await showConfirm({ title: 'Remover regra de grupo', message: 'Remover esta regra de grupo? Os utilizadores que dependiam dela perderão acesso no próximo login (ou sync).', confirmText: 'Remover' }))) return;
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
  if (!(await showConfirm({ title: 'Remover configuração SMTP', message: 'Remover toda a configuração SMTP?', confirmText: 'Remover' }))) return;
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
      const target = l.targetType === 'midleman'
        ? 'Midleman'
        : (l.targetType || '') + (l.targetId ? ' #' + l.targetId : '');
      const failed = l.action.endsWith('.failed') || l.action.indexOf('error') !== -1;
      const actionStyle = failed ? 'color:var(--err-text);font-weight:500' : '';
      return '<tr style="border-top:1px solid var(--border)">' +
        '<td style="padding:10px 12px;color:var(--text2);font-size:11.5px;white-space:nowrap">' + esc(when) + '</td>' +
        '<td style="padding:10px 8px;font-weight:500">' + esc(actor) + '</td>' +
        '<td style="padding:10px 8px;font-family:monospace;font-size:11.5px;' + actionStyle + '">' + esc(l.action) + '</td>' +
        '<td style="padding:10px 8px;color:var(--text2);font-size:11.5px">' + esc(target || '—') + '</td>' +
        '<td style="padding:10px 8px;color:var(--text3);font-size:11.5px;font-family:monospace">' + esc(l.ipAddress || '—') + '</td>' +
        '<td style="padding:10px 12px;text-align:right"><button class="btn btn-sm btn-ghost" onclick="showAuditDetail(' + idx + ')">Details</button></td>' +
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
      '<div><span style="color:var(--text3)">Target:</span> ' + (l.targetType === 'midleman' ? 'Midleman' : esc(l.targetType || '—') + (l.targetId ? ' #' + esc(l.targetId) : '')) + '</div>' +
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
    if (badge) {
      const n = _ldapConfigs.filter(c => c.enabled).length;
      badge.textContent = String(n);
      badge.title = n === 1 ? '1 enabled directory' : n + ' enabled directories';
    }
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
  if (!(await showConfirm({ title: 'Apagar diretório', message: 'Apagar diretório "' + name + '"?', detail: 'Os utilizadores LDAP já provisionados perderão a sua origem — não poderão iniciar sessão até reconfigurares o diretório.', confirmText: 'Apagar' }))) return;
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
  if (!(await showConfirm({ title: 'Confirmar adoção', message: 'Confirmar esta adoção? A conta local será permanentemente substituída pela identidade LDAP.', confirmText: 'Confirmar', danger: false }))) return;
  try {
    const res = await api('/admin/ldap/adoptions/' + encodeURIComponent(id) + '/confirm', { method: 'POST' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'Failed', 'error'); }
    toast('Adoption confirmed');
    fetchLdapAdoptions();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function revertLdapAdoption(id) {
  if (!(await showConfirm({ title: 'Reverter adoção', message: 'Reverter? A conta local volta ao estado anterior (utilizador, email e hash da palavra-passe originais).', detail: 'A identidade LDAP terá de ser registada manualmente noutro utilizador — as sessões e tokens serão revogados.', confirmText: 'Reverter' }))) return;
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
    if (badge) {
      const n = _consentPages.length;
      badge.textContent = String(n);
      badge.title = n === 1 ? '1 consent page' : n + ' consent pages';
    }
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
  if (!(await showConfirm({ title: 'Apagar página', message: 'Apagar página "' + name + '"?', confirmText: 'Apagar' }))) return;
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

// ─── SIP message logs ──────────────────────────────────────────────────────
let slPage = 1;
let slPageSize = 50;
let slTotal = 0;
let _slAutoRefreshTimer = null;

function buildSipLogQuery() {
  const params = new URLSearchParams();
  params.set('page', String(slPage));
  params.set('pageSize', String(slPageSize));
  const callId = document.getElementById('slCallId')?.value.trim();
  const profile = document.getElementById('slProfile')?.value;
  const direction = document.getElementById('slDirection')?.value;
  const transport = document.getElementById('slTransport')?.value;
  const method = document.getElementById('slMethod')?.value;
  if (callId) params.set('callId', callId);
  if (profile) params.set('profile', profile);
  if (direction) params.set('direction', direction);
  if (transport) params.set('transport', transport);
  if (method) params.set('method', method);
  return params.toString();
}

async function populateSipProfileFilter() {
  const sel = document.getElementById('slProfile');
  if (!sel || sel.dataset.loaded === '1') return;
  try {
    const res = await api('/admin/tcpudp');
    if (!res.ok) return;
    const data = await res.json();
    const cur = sel.value;
    const profiles = data.tcpUdpProxies || [];
    sel.innerHTML = '<option value="">All profiles</option>' +
      profiles.map(p => '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>').join('');
    if (cur) sel.value = cur;
    sel.dataset.loaded = '1';
  } catch {}
}

async function fetchSipLogs() {
  const body = document.getElementById('sipLogBody');
  if (!body) return;
  try {
    const res = await api('/admin/sip-logs?' + buildSipLogQuery());
    if (!res.ok) {
      body.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center;color:var(--text3)">Failed to load.</td></tr>';
      return;
    }
    const data = await res.json();
    slTotal = data.total || 0;
    const rows = data.rows || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" style="padding:32px;text-align:center;color:var(--text3)">No SIP messages logged. Enable <strong>Log SIP messages</strong> on a TCP/UDP profile to populate.</td></tr>';
    } else {
      body.innerHTML = rows.map(renderSipLogRow).join('');
    }
    const total = slTotal;
    const start = total === 0 ? 0 : (slPage - 1) * slPageSize + 1;
    const end = Math.min(start + rows.length - 1, total);
    document.getElementById('sipLogInfo').textContent = total ? (start + '-' + end + ' of ' + total) : '0';
    document.getElementById('slPrev').disabled = slPage <= 1;
    document.getElementById('slNext').disabled = end >= total;
    // Stats
    try {
      const sres = await api('/admin/sip-logs/stats');
      if (sres.ok) {
        const s = await sres.json();
        const kb = Math.round((s.sizeBytes || 0) / 1024);
        document.getElementById('sipLogStats').textContent =
          '· ' + (s.total || 0).toLocaleString() + ' rows · ' + kb.toLocaleString() + ' KB';
      }
    } catch {}
  } catch (e) {
    body.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center;color:var(--text3)">' + esc(e.message) + '</td></tr>';
  }
}

function renderSipLogRow(r) {
  const time = r.timestamp ? r.timestamp.replace('T', ' ').replace('Z', '') : '';
  const dirColor = r.direction === 'in' ? '#3b82f6' : '#10b981';
  const dirLabel = r.direction === 'in' ? '◀ IN' : 'OUT ▶';
  const methodOrStatus = r.is_request
    ? '<span style="font-weight:600">' + esc(r.method || '?') + '</span>'
    : '<span style="font-weight:600;color:' + statusColor(r.status_code) + '">' + (r.status_code || '?') + '</span> <span style="color:var(--text3);font-size:11px">' + esc(r.reason_phrase || '') + '</span>';
  const fromTo = (r.from_uri ? esc(truncStr(r.from_uri, 28)) : '?') + ' <span style="color:var(--text3)">→</span> ' + (r.to_uri ? esc(truncStr(r.to_uri, 28)) : '?');
  const callIdShort = r.call_id ? esc(truncStr(r.call_id, 24)) : '';
  return '<tr style="border-top:1px solid var(--border);cursor:pointer" onclick="openSipDetail(' + r.id + ')">'
    + '<td style="padding:8px 12px;font-family:monospace;font-size:12px;white-space:nowrap">' + esc(time) + '</td>'
    + '<td style="padding:8px">' + esc(r.profile_name) + '</td>'
    + '<td style="padding:8px;color:' + dirColor + ';font-weight:600;font-size:11px">' + dirLabel + '</td>'
    + '<td style="padding:8px;font-size:11px;color:var(--text2)">' + esc((r.transport || '').toUpperCase()) + '</td>'
    + '<td style="padding:8px">' + methodOrStatus + '</td>'
    + '<td style="padding:8px;font-family:monospace;font-size:11px">' + fromTo + '</td>'
    + '<td style="padding:8px;font-family:monospace;font-size:11px">' + callIdShort + '</td>'
    + '<td style="padding:8px;font-family:monospace;font-size:11px;color:var(--text3)">' + esc(r.peer_addr || '') + '</td>'
    + '<td style="padding:8px 12px"><button class="btn btn-sm" onclick="event.stopPropagation();openSipDetail(' + r.id + ')">View</button></td>'
    + '</tr>';
}

function statusColor(s) {
  if (!s) return 'var(--text)';
  if (s >= 200 && s < 300) return '#10b981';
  if (s >= 300 && s < 400) return '#f59e0b';
  if (s >= 400) return '#ef4444';
  return 'var(--text)';
}

function truncStr(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function sipLogPrevPage() { if (slPage > 1) { slPage--; fetchSipLogs(); } }
function sipLogNextPage() {
  const maxPage = Math.max(1, Math.ceil(slTotal / slPageSize));
  if (slPage < maxPage) { slPage++; fetchSipLogs(); }
}

// Auto-refresh: poll every 5s while on the SIP logs page with the checkbox on
function ensureSipAutoRefreshTimer() {
  if (_slAutoRefreshTimer) return;
  _slAutoRefreshTimer = setInterval(() => {
    if (currentPage !== 'tcpudp' || _tcpUdpOuterTab !== 'logs') return;
    const cb = document.getElementById('slAutoRefresh');
    if (!cb || !cb.checked) return;
    // Skip if a detail modal is open (avoid disrupting reads)
    if (document.getElementById('sipDetailModal')?.style.display === 'block') return;
    refreshTcpUdpLogTab();
  }, 5000);
}
// Kick off once the script loads
if (typeof window !== 'undefined') ensureSipAutoRefreshTimer();

async function openSipDetail(id) {
  try {
    const res = await api('/admin/sip-logs/' + id);
    if (!res.ok) return toast('Failed to load message', 'error');
    const r = await res.json();
    const titleParts = [r.is_request ? r.method : (r.status_code + ' ' + (r.reason_phrase || '')), r.direction === 'in' ? 'inbound' : 'outbound', (r.transport || '').toUpperCase()];
    document.getElementById('sipDetailTitle').textContent = titleParts.filter(Boolean).join(' · ');
    const rows = [
      ['Timestamp', r.timestamp],
      ['Profile', r.profile_name],
      ['Direction', r.direction === 'in' ? 'Inbound (client → upstream)' : 'Outbound (upstream → client)'],
      ['Transport', (r.transport || '').toUpperCase()],
      ['Peer', r.peer_addr || ''],
      ['Type', r.is_request ? 'Request' : 'Response'],
      ['Method', r.method || ''],
      ['Status', r.is_request ? '' : (r.status_code + ' ' + (r.reason_phrase || ''))],
      ['Call-ID', r.call_id || ''],
      ['CSeq', r.cseq || ''],
      ['From', r.from_uri || ''],
      ['To', r.to_uri || ''],
      ['Branch', r.branch || ''],
      ['Body size', (r.body_size || 0) + ' bytes'],
    ];
    const html =
      '<div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;margin-bottom:16px">' +
      rows.filter(([_, v]) => v !== '').map(([k, v]) => '<div style="color:var(--text3)">' + esc(k) + '</div><div style="font-family:monospace;word-break:break-all">' + esc(String(v)) + '</div>').join('') +
      '</div>' +
      (r.body
        ? '<div style="color:var(--text3);font-size:11px;text-transform:uppercase;margin-bottom:6px">Body</div><pre style="background:var(--surface2);padding:12px;border-radius:6px;font-size:12px;overflow:auto;max-height:420px">' + esc(r.body) + '</pre>'
        : '<div style="color:var(--text3);font-style:italic;font-size:12px">Body not captured (enable <em>Include message body</em> on the profile).</div>');
    document.getElementById('sipDetailContent').innerHTML = html;
    document.getElementById('sipDetailModal').style.display = 'block';
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function closeSipDetail() {
  document.getElementById('sipDetailModal').style.display = 'none';
}

// ─── TCP/UDP: outer tabs (Proxies / Logs) ──────────────────────────────────
let _tcpUdpOuterTab = 'proxies';

function switchTcpUdpTab(tab) {
  _tcpUdpOuterTab = tab;
  const btns = {
    proxies: document.getElementById('tabBtnTcpProxies'),
    logs:    document.getElementById('tabBtnTcpLogs'),
    certs:   document.getElementById('tabBtnTcpCerts'),
  };
  const panes = {
    proxies: document.getElementById('tabPaneTcpProxies'),
    logs:    document.getElementById('tabPaneTcpLogs'),
    certs:   document.getElementById('tabPaneTcpCerts'),
  };
  if (!btns.proxies || !btns.logs || !btns.certs) return;
  const setActive = (btn, on) => {
    btn.style.borderBottomColor = on ? 'var(--accent)' : 'transparent';
    btn.style.color = on ? 'var(--text)' : 'var(--text3)';
  };
  for (const k of Object.keys(panes)) {
    if (panes[k]) panes[k].style.display = (k === tab) ? '' : 'none';
    setActive(btns[k], k === tab);
  }
  if (tab === 'logs') {
    slPage = 1;
    populateSipProfileFilter();
    if (_tcpUdpLogTab === 'messages') fetchSipLogs();
    else { populateConnProfileFilter(); fetchConnLogs(); }
  } else if (tab === 'certs') {
    fetchCerts();
  } else {
    fetchSipProxies();
  }
}

// ─── TCP/UDP Logs: tabs (Messages / Connections) ───────────────────────────
let _tcpUdpLogTab = 'messages';

function switchTcpUdpLogTab(tab) {
  _tcpUdpLogTab = tab;
  const msgBtn = document.getElementById('tabBtnSipMessages');
  const conBtn = document.getElementById('tabBtnSipConns');
  const msgPane = document.getElementById('tabPaneSipMessages');
  const conPane = document.getElementById('tabPaneSipConns');
  if (tab === 'messages') {
    msgPane.style.display = '';
    conPane.style.display = 'none';
    msgBtn.style.borderBottomColor = 'var(--accent)';
    msgBtn.style.color = 'var(--text)';
    conBtn.style.borderBottomColor = 'transparent';
    conBtn.style.color = 'var(--text3)';
    fetchSipLogs();
  } else {
    msgPane.style.display = 'none';
    conPane.style.display = '';
    msgBtn.style.borderBottomColor = 'transparent';
    msgBtn.style.color = 'var(--text3)';
    conBtn.style.borderBottomColor = 'var(--accent)';
    conBtn.style.color = 'var(--text)';
    populateConnProfileFilter();
    fetchConnLogs();
  }
}

function refreshTcpUdpLogTab() {
  if (_tcpUdpLogTab === 'messages') fetchSipLogs();
  else fetchConnLogs();
}

// ─── TCP/UDP raw connection logs ───────────────────────────────────────────
let clPage = 1;
const clPageSize = 50;
let clTotal = 0;

async function populateConnProfileFilter() {
  const sel = document.getElementById('clProfile');
  if (!sel || sel.dataset.loaded === '1') return;
  try {
    const res = await api('/admin/tcpudp');
    if (!res.ok) return;
    const data = await res.json();
    const cur = sel.value;
    const profiles = data.tcpUdpProxies || [];
    sel.innerHTML = '<option value="">All profiles</option>' +
      profiles.map(p => '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>').join('');
    if (cur) sel.value = cur;
    sel.dataset.loaded = '1';
  } catch {}
}

async function fetchConnLogs() {
  const body = document.getElementById('connLogBody');
  if (!body) return;
  const params = new URLSearchParams();
  params.set('page', String(clPage));
  params.set('pageSize', String(clPageSize));
  const profile = document.getElementById('clProfile')?.value;
  const transport = document.getElementById('clTransport')?.value;
  if (profile) params.set('profile', profile);
  if (transport) params.set('transport', transport);
  try {
    const res = await api('/admin/tcpudp-conns?' + params.toString());
    if (!res.ok) {
      body.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--text3)">Failed to load.</td></tr>';
      return;
    }
    const data = await res.json();
    clTotal = data.total || 0;
    const rows = data.rows || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" style="padding:32px;text-align:center;color:var(--text3)">No connections logged. Enable <strong>Log connections</strong> on a TCP/UDP profile to populate.</td></tr>';
    } else {
      body.innerHTML = rows.map(renderConnLogRow).join('');
    }
    const start = clTotal === 0 ? 0 : (clPage - 1) * clPageSize + 1;
    const end = Math.min(start + rows.length - 1, clTotal);
    document.getElementById('connLogInfo').textContent = clTotal ? (start + '-' + end + ' of ' + clTotal) : '0';
    document.getElementById('clPrev').disabled = clPage <= 1;
    document.getElementById('clNext').disabled = end >= clTotal;
  } catch (e) {
    body.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--text3)">' + esc(e.message) + '</td></tr>';
  }
}

function renderConnLogRow(r) {
  const opened = r.opened_at ? r.opened_at.replace('T', ' ').replace('Z', '') : '';
  const closeColor = (r.close_reason || '').startsWith('error:') ? '#ef4444'
    : r.close_reason === 'rejected' ? '#f59e0b' : 'var(--text3)';
  const dur = r.duration_ms != null ? humanDuration(r.duration_ms) : '';
  return '<tr style="border-top:1px solid var(--border)">'
    + '<td style="padding:8px 12px;font-family:monospace;font-size:12px;white-space:nowrap">' + esc(opened) + '</td>'
    + '<td style="padding:8px">' + esc(r.profile_name) + '</td>'
    + '<td style="padding:8px;font-size:11px;color:var(--text2)">' + esc((r.transport || '').toUpperCase()) + '</td>'
    + '<td style="padding:8px;font-family:monospace;font-size:12px">' + esc(r.peer_addr || '') + '</td>'
    + '<td style="padding:8px;font-family:monospace;font-size:12px">' + humanBytes(r.bytes_in || 0) + '</td>'
    + '<td style="padding:8px;font-family:monospace;font-size:12px">' + humanBytes(r.bytes_out || 0) + '</td>'
    + '<td style="padding:8px;font-family:monospace;font-size:12px">' + esc(dur) + '</td>'
    + '<td style="padding:8px;font-size:11px;color:' + closeColor + '">' + esc(r.close_reason || '') + '</td>'
    + '</tr>';
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function humanDuration(ms) {
  if (ms < 1000) return ms + ' ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + ' s';
  return Math.floor(ms / 60_000) + 'm ' + Math.floor((ms % 60_000) / 1000) + 's';
}

function connLogPrevPage() { if (clPage > 1) { clPage--; fetchConnLogs(); } }
function connLogNextPage() {
  const maxPage = Math.max(1, Math.ceil(clTotal / clPageSize));
  if (clPage < maxPage) { clPage++; fetchConnLogs(); }
}

// ─── Certificates ──────────────────────────────────────────────────────────
let _certSource = 'upload'; // upload | acme | self-signed

async function fetchCerts() {
  const body = document.getElementById('certsListBody');
  if (!body) return;
  try {
    const res = await api('/admin/certs');
    if (!res.ok) {
      body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3)">Failed to load.</td></tr>';
      return;
    }
    const data = await res.json();
    const certs = data.certs || [];
    const badge = document.getElementById('tabTcpCertsBadge');
    if (badge) badge.textContent = String(certs.length);
    if (!certs.length) {
      body.innerHTML = '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--text3)">No certificates yet. Click <strong>+ New Certificate</strong> to add one.</td></tr>';
      return;
    }
    body.innerHTML = certs.map(renderCertRow).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3)">' + esc(e.message) + '</td></tr>';
  }
}

function renderCertRow(c) {
  const statusColors = { active: '#10b981', pending: '#f59e0b', expired: '#ef4444', error: '#ef4444' };
  const statusDot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (statusColors[c.status] || 'var(--text3)') + ';margin-right:6px;vertical-align:middle"></span>';
  const expiry = c.notAfter ? new Date(c.notAfter).toISOString().slice(0, 10) : '—';
  const daysLeft = c.notAfter ? Math.floor((new Date(c.notAfter).getTime() - Date.now()) / (24 * 3600 * 1000)) : null;
  const expiryLabel = daysLeft !== null
    ? expiry + ' <span style="color:var(--text3);font-size:11px">(' + (daysLeft >= 0 ? daysLeft + 'd left' : Math.abs(daysLeft) + 'd ago') + ')</span>'
    : expiry;
  const usedBy = (c.usedBy || []).length
    ? (c.usedBy || []).map(u => '<span style="background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:1px 6px;font-size:11px;margin-right:3px">' + esc(u) + '</span>').join('')
    : '<span style="color:var(--text3);font-size:11px;font-style:italic">unused</span>';
  const renewBtn = c.source === 'acme'
    ? '<button onclick="renewCert(' + c.id + ')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--text2);font-size:11px;margin-right:4px">Renew</button>'
    : '';
  const errorBadge = c.lastError
    ? ' <span title="' + esc(c.lastError) + '" style="color:#ef4444;cursor:help">⚠</span>'
    : '';
  return '<tr style="border-bottom:1px solid var(--border)">'
    + '<td style="padding:10px 12px;font-weight:600;font-family:monospace">' + esc(c.domain) + '</td>'
    + '<td style="padding:10px 8px"><span style="background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:1px 6px;font-size:11px">' + esc(c.source) + '</span></td>'
    + '<td style="padding:10px 8px;font-size:12px;text-transform:capitalize">' + statusDot + esc(c.status) + errorBadge + '</td>'
    + '<td style="padding:10px 8px;font-family:monospace;font-size:12px">' + expiryLabel + '</td>'
    + '<td style="padding:10px 8px">' + usedBy + '</td>'
    + '<td style="padding:10px 12px;text-align:right">'
    + renewBtn
    + '<button onclick="deleteCertificate(' + c.id + ')" style="background:none;border:1px solid rgba(239,68,68,0.4);border-radius:4px;padding:2px 8px;cursor:pointer;color:#fca5a5;font-size:11px">Delete</button>'
    + '</td></tr>';
}

// Reads the selected PEM file and pastes it into the matching textarea.
// If the file is a bundle (cert + key + chain in one), auto-splits the
// blocks into the three fields. `kind` ∈ 'cert' | 'key' | 'chain' tells us
// which field the upload was triggered from — affects the auto-split policy.
function onCertFileSelected(ev, targetId, kind) {
  const input = ev.target;
  const file = input.files && input.files[0];
  if (!file) return;
  // Reject obvious binary formats early — these need openssl pre-processing
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.p12') || name.endsWith('.pfx') || name.endsWith('.der')) {
    toast('Binary cert format detected. Convert to PEM first: openssl pkcs12 -in ' + file.name + ' -out cert.pem -nodes', 'error');
    input.value = '';
    return;
  }
  // Soft size cap — a PEM bundle is text and rarely exceeds 64 KB
  if (file.size > 256 * 1024) {
    toast('File too large (' + Math.round(file.size / 1024) + ' KB). PEM files are usually under 64 KB.', 'error');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    if (!text.includes('-----BEGIN')) {
      toast('File does not look like PEM (no -----BEGIN- header). Convert binary formats with openssl first.', 'error');
      input.value = '';
      return;
    }
    distributePemBundle(text, targetId, kind);
    toast('Loaded ' + esc(file.name));
  };
  reader.onerror = () => toast('Failed to read file: ' + reader.error?.message, 'error');
  reader.readAsText(file);
  input.value = ''; // reset so re-selecting same file fires change again
}

// Split a PEM bundle into cert / key / chain blocks. Heuristic: first
// CERTIFICATE block → main cert; remaining CERTIFICATE blocks → chain;
// any PRIVATE KEY block → key. If the user uploaded specifically to the
// key or chain field, route the whole content there instead of splitting.
function distributePemBundle(text, targetId, kind) {
  const re = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) blocks.push({ type: m[1], pem: m[0] });

  if (blocks.length === 0) {
    document.getElementById(targetId).value = text.trim();
    return;
  }

  // If targeting key or chain specifically, just paste the whole content
  if (kind === 'key' || kind === 'chain') {
    document.getElementById(targetId).value = text.trim();
    return;
  }

  // kind === 'cert' — auto-split bundle
  const certs = blocks.filter(b => b.type.includes('CERTIFICATE'));
  const keys = blocks.filter(b => b.type.includes('PRIVATE KEY') || b.type === 'RSA PRIVATE KEY' || b.type === 'EC PRIVATE KEY');

  if (certs.length > 0) {
    document.getElementById('certPemInput').value = certs[0].pem + '\n';
    if (certs.length > 1) {
      document.getElementById('certChainInput').value = certs.slice(1).map(b => b.pem).join('\n') + '\n';
    }
  }
  if (keys.length > 0 && !document.getElementById('certKeyInput').value.trim()) {
    document.getElementById('certKeyInput').value = keys[0].pem + '\n';
  }
}

function openCertModal() {
  document.getElementById('certModalTitle').textContent = 'New Certificate';
  document.getElementById('certModalError').style.display = 'none';
  document.getElementById('certDomain').value = '';
  document.getElementById('certPemInput').value = '';
  document.getElementById('certKeyInput').value = '';
  document.getElementById('certChainInput').value = '';
  document.getElementById('certAcmeEmail').value = '';
  document.getElementById('certAcmeStaging').checked = false;
  switchCertTab('upload');
  document.getElementById('certModal').classList.add('active');
  document.getElementById('certDomain').focus();
}

function closeCertModal() {
  document.getElementById('certModal').classList.remove('active');
}

function switchCertTab(source) {
  _certSource = source;
  const tabs = { upload: 'certTabUpload', acme: 'certTabAcme', 'self-signed': 'certTabSelfSigned' };
  const panes = { upload: 'certPaneUpload', acme: 'certPaneAcme', 'self-signed': 'certPaneSelfSigned' };
  for (const [k, btnId] of Object.entries(tabs)) {
    const btn = document.getElementById(btnId);
    const pane = document.getElementById(panes[k]);
    if (k === source) {
      btn.style.borderBottomColor = 'var(--accent)';
      btn.style.color = 'var(--text)';
      pane.style.display = '';
    } else {
      btn.style.borderBottomColor = 'transparent';
      btn.style.color = 'var(--text3)';
      pane.style.display = 'none';
    }
  }
}

async function saveCert() {
  const errEl = document.getElementById('certModalError');
  errEl.style.display = 'none';
  const domain = document.getElementById('certDomain').value.trim().toLowerCase();
  if (!domain) { errEl.textContent = 'Domain is required.'; errEl.style.display = 'block'; return; }

  const body = { domain };
  if (_certSource === 'upload') {
    body.source = 'manual';
    body.certPem = document.getElementById('certPemInput').value.trim();
    body.keyPem = document.getElementById('certKeyInput').value.trim();
    body.chainPem = document.getElementById('certChainInput').value.trim() || null;
    if (!body.certPem || !body.keyPem) {
      errEl.textContent = 'Both certificate and key PEM are required.'; errEl.style.display = 'block'; return;
    }
  } else if (_certSource === 'acme') {
    body.source = 'acme';
    body.acmeEmail = document.getElementById('certAcmeEmail').value.trim();
    body.acmeStaging = document.getElementById('certAcmeStaging').checked;
    if (!body.acmeEmail) {
      errEl.textContent = 'Email is required for Let\'s Encrypt.'; errEl.style.display = 'block'; return;
    }
  } else {
    body.source = 'self-signed';
  }

  try {
    const res = await api('/admin/certs', { method: 'POST', body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) { errEl.textContent = d.error || 'Error saving'; errEl.style.display = 'block'; return; }
    toast('Certificate saved' + (d.cert?.status === 'pending' ? ' (ACME issuing in background)' : ''));
    closeCertModal();
    await fetchCerts();
  } catch (e) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = 'block'; }
}

async function renewCert(id) {
  if (!(await showConfirm({ title: 'Forçar renovação ACME', message: 'Forçar renovação ACME agora? Será feito um pedido à Let\'s Encrypt.', confirmText: 'Renovar', danger: false }))) return;
  try {
    const res = await api('/admin/certs/' + id + '/renew', { method: 'POST' });
    const d = await res.json();
    if (!res.ok) return toast(d.error || 'Renewal failed', 'error');
    toast('Certificate renewed — listeners will hot-reload');
    await fetchCerts();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteCertificate(id) {
  if (!(await showConfirm({ title: 'Apagar certificado', message: 'Apagar este certificado? Os perfis que o usam perderão TLS até serem reatribuídos.', confirmText: 'Apagar' }))) return;
  try {
    const res = await api('/admin/certs/' + id, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) return toast(d.error || 'Delete failed', 'error');
    toast('Certificate deleted');
    await fetchCerts();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ─── Nginx Proxy Manager (NPM) integration ────────────────────────────────────

let _npmHasPassword = false;

function setNpmStatus(elId, msg, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!msg) { el.textContent = ''; el.style.color = ''; return; }
  const colorMap = { ok: 'var(--ok-text)', err: 'var(--err-text)', info: 'var(--text2)' };
  el.style.color = colorMap[kind] || colorMap.info;
  el.textContent = msg;
}

function _updateNpmPageVisibility(cfg, certVolumeMounted) {
  const empty = document.getElementById('npmEmptyState');
  const hostsCard = document.getElementById('npmHostsCard');
  const certsCard = document.getElementById('npmCertsCard');
  const subTabs = document.getElementById('npmSubTabs');
  const addBtn = document.getElementById('npmAddHostBtn');
  const addCertBtn = document.getElementById('npmAddCertBtn');
  const addCustomCertBtn = document.getElementById('npmAddCustomCertBtn');
  const refreshBtn = document.getElementById('npmRefreshBtn');
  const pill = document.getElementById('npmConnPill');
  const isReady = !!(cfg && cfg.enabled && cfg.url && cfg.email);
  if (empty) empty.style.display = isReady ? 'none' : '';
  if (hostsCard) hostsCard.style.display = isReady ? '' : 'none';
  if (certsCard) certsCard.style.display = isReady ? '' : 'none';
  if (subTabs) subTabs.style.display = isReady ? 'flex' : 'none';
  // Show "+ Add" buttons based on current sub-page when ready
  const sub = isReady ? (_npmCurrentSubpage || 'proxy-hosts') : null;
  if (addBtn) addBtn.style.display = (isReady && sub === 'proxy-hosts') ? '' : 'none';
  if (addCertBtn) addCertBtn.style.display = (isReady && sub === 'certificates') ? '' : 'none';
  if (addCustomCertBtn) addCustomCertBtn.style.display = (isReady && sub === 'certificates') ? '' : 'none';
  if (refreshBtn) refreshBtn.style.display = isReady ? '' : 'none';
  if (pill) {
    if (!cfg || !cfg.url) {
      pill.style.display = 'none';
    } else if (cfg.enabled && cfg.tokenValid) {
      pill.style.display = '';
      pill.textContent = '● Connected';
      pill.style.background = 'rgba(34,197,94,0.15)';
      pill.style.color = '#22c55e';
    } else if (cfg.enabled) {
      pill.style.display = '';
      pill.textContent = '● Pending';
      pill.style.background = 'rgba(234,179,8,0.15)';
      pill.style.color = '#eab308';
    } else {
      pill.style.display = '';
      pill.textContent = '○ Disabled';
      pill.style.background = 'var(--surface2)';
      pill.style.color = 'var(--text2)';
    }
  }
}

async function fetchNpmConfig() {
  try {
    const res = await api('/admin/npm');
    if (!res.ok) return;
    const data = await res.json();
    const cfg = data.npm;
    _updateNpmPageVisibility(cfg, data.certVolumeMounted);
    // If integration is enabled and we're on the NPM page, refresh the current sub-page.
    if (cfg && cfg.enabled) refreshNpmCurrentSubpage();
    const urlEl = document.getElementById('npmUrl');
    const emailEl = document.getElementById('npmEmail');
    const pwEl = document.getElementById('npmPassword');
    const hostEl = document.getElementById('npmMidlemanHost');
    const enabledEl = document.getElementById('npmEnabled');
    const volEl = document.getElementById('npmVolumeStatus');
    if (cfg) {
      urlEl.value = cfg.url || '';
      emailEl.value = cfg.email || '';
      pwEl.value = '';
      hostEl.value = cfg.midlemanPublicHost || '';
      enabledEl.checked = !!cfg.enabled;
      _npmHasPassword = !!cfg.hasPassword;
      pwEl.placeholder = _npmHasPassword ? '(unchanged)' : '';
      const clearBtn = document.getElementById('npmClearBtn');
      if (clearBtn) clearBtn.style.display = (cfg.url || cfg.email) ? '' : 'none';
      if (cfg.enabled && cfg.tokenValid) setNpmStatus('npmStatus', 'Integration active — token valid.', 'ok');
      else if (cfg.enabled) setNpmStatus('npmStatus', 'Integration enabled — token will be acquired on next sync.', 'info');
      else setNpmStatus('npmStatus', 'Integration is disabled.', 'info');
      if (cfg.lastError) setNpmStatus('npmStatus', 'Last error: ' + cfg.lastError, 'err');
    } else {
      urlEl.value = '';
      emailEl.value = '';
      pwEl.value = '';
      hostEl.value = '';
      enabledEl.checked = false;
      _npmHasPassword = false;
      const clearBtn = document.getElementById('npmClearBtn');
      if (clearBtn) clearBtn.style.display = 'none';
      setNpmStatus('npmStatus', 'No NPM configuration active.', 'info');
    }
    if (volEl) {
      volEl.textContent = data.certVolumeMounted
        ? '✔ Shared Let\'s Encrypt volume mounted (NPM_LETSENCRYPT_DIR). Internal ACME is disabled.'
        : 'Shared volume not detected. Set NPM_LETSENCRYPT_DIR and mount /etc/letsencrypt:ro in docker-compose to share certs.';
      volEl.style.color = data.certVolumeMounted ? 'var(--ok-text)' : 'var(--text2)';
    }
  } catch (e) {
    setNpmStatus('npmStatus', 'Failed to load: ' + e.message, 'err');
  }
}

// ───────────────────── NPM sub-page tabs ─────────────────────
let _npmCurrentSubpage = (typeof localStorage !== 'undefined' && localStorage.getItem('npm.subpage')) || 'proxy-hosts';

function switchNpmSubpage(sub) {
  if (sub !== 'proxy-hosts' && sub !== 'certificates') sub = 'proxy-hosts';
  _npmCurrentSubpage = sub;
  try { localStorage.setItem('npm.subpage', sub); } catch (_) {}
  // Update tab buttons
  document.querySelectorAll('.npm-subpage-tab').forEach(b => {
    const active = b.getAttribute('data-subpage') === sub;
    b.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    b.style.color = active ? 'var(--text)' : 'var(--text2)';
    b.style.fontWeight = active ? '500' : '';
  });
  // Update sub-page panels
  document.querySelectorAll('.npm-subpage').forEach(p => {
    p.style.display = (p.getAttribute('data-subpage') === sub) ? '' : 'none';
  });
  // Update header buttons
  const addHost = document.getElementById('npmAddHostBtn');
  const addCert = document.getElementById('npmAddCertBtn');
  const addCustomCert = document.getElementById('npmAddCustomCertBtn');
  // Only show if integration is ready (pill visible means ready-ish, but use the same gating as visibility)
  const ready = !!document.getElementById('npmRefreshBtn') && document.getElementById('npmRefreshBtn').style.display !== 'none';
  if (addHost) addHost.style.display = (ready && sub === 'proxy-hosts') ? '' : 'none';
  if (addCert) addCert.style.display = (ready && sub === 'certificates') ? '' : 'none';
  if (addCustomCert) addCustomCert.style.display = (ready && sub === 'certificates') ? '' : 'none';
  // Lazy-load data for the chosen sub-page
  refreshNpmCurrentSubpage();
}

function refreshNpmCurrentSubpage() {
  if (_npmCurrentSubpage === 'certificates') {
    if (document.getElementById('npmCertsTableBody')) fetchNpmCertsTable();
  } else {
    if (document.getElementById('npmHostsTableBody')) fetchNpmHostsTable();
  }
}

// ───────────────────── NPM certificates ─────────────────────
let _npmCertsAll = [];
let _npmCertsHostUsage = {}; // certId → array of domain_names lists using it (best-effort)

function _certExpiryInfo(expiresOn) {
  if (!expiresOn) return { text: '—', color: 'var(--text3)', sortKey: Number.POSITIVE_INFINITY };
  const t = Date.parse(expiresOn);
  if (isNaN(t)) return { text: String(expiresOn), color: 'var(--text3)', sortKey: Number.POSITIVE_INFINITY };
  const now = Date.now();
  const diffMs = t - now;
  const dayMs = 86400000;
  const d = new Date(t);
  const pad = n => String(n).padStart(2, '0');
  const text = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let color, suffix = '';
  if (diffMs < 0) { color = 'var(--err-text)'; suffix = ' (expired)'; }
  else if (diffMs < 30 * dayMs) { color = '#f59e0b'; suffix = ` (in ${Math.ceil(diffMs / dayMs)}d)`; }
  else { color = '#22c55e'; }
  return { text: text + suffix, color, sortKey: t };
}

async function fetchNpmCertsTable() {
  const body = document.getElementById('npmCertsTableBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3)">Loading…</td></tr>';
  try {
    const res = await api('/admin/npm/certificates');
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--err-text)">' + _esc(d.error || 'Failed to load') + '</td></tr>';
      return;
    }
    const data = await res.json();
    _npmCertsAll = data.certificates || [];
    // Best-effort cert-in-use lookup using already-loaded hosts (no extra fetch).
    _npmCertsHostUsage = {};
    (_npmHostsAll || []).forEach(h => {
      const cid = Number(h.certificate_id);
      if (cid > 0) {
        if (!_npmCertsHostUsage[cid]) _npmCertsHostUsage[cid] = [];
        _npmCertsHostUsage[cid].push((h.domain_names || []).join(', '));
      }
    });
    renderNpmCertsTable();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--err-text)">' + _esc(e.message) + '</td></tr>';
  }
}

function _filterNpmCerts() {
  const q = (document.getElementById('npmCertsSearch')?.value || '').trim().toLowerCase();
  const f = document.getElementById('npmCertsFilter')?.value || 'all';
  const now = Date.now();
  const dayMs = 86400000;
  return _npmCertsAll.filter(c => {
    if (q) {
      const hay = ((c.domain_names || []).join(' ') + ' ' + (c.nice_name || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const t = c.expires_on ? Date.parse(c.expires_on) : NaN;
    switch (f) {
      case 'letsencrypt': return c.provider === 'letsencrypt';
      case 'other': return c.provider === 'other';
      case 'expiring': return !isNaN(t) && (t - now) > 0 && (t - now) < 30 * dayMs;
      case 'expired': return !isNaN(t) && (t - now) < 0;
      default: return true;
    }
  });
}

function renderNpmCertsTable() {
  const body = document.getElementById('npmCertsTableBody');
  if (!body) return;
  const filtered = _filterNpmCerts();
  // Sort by expiry ascending (soonest first)
  filtered.sort((a, b) => _certExpiryInfo(a.expires_on).sortKey - _certExpiryInfo(b.expires_on).sortKey);
  const total = filtered.length;
  const cnt = document.getElementById('npmCertsCount');
  if (cnt) cnt.textContent = total
    ? (total + ' certificate' + (total === 1 ? '' : 's'))
    : (_npmCertsAll.length ? '0 of ' + _npmCertsAll.length + ' (filtered)' : '');
  if (!total) {
    body.innerHTML = '<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text3)">'
      + (_npmCertsAll.length ? 'No certificates match the current filter.' : 'No certificates yet. Click <strong>+ Let\'s Encrypt</strong> to add one.')
      + '</td></tr>';
    return;
  }
  body.innerHTML = filtered.map(c => {
    const exp = _certExpiryInfo(c.expires_on);
    const providerLabel = c.provider === 'letsencrypt' ? "Let's Encrypt" : (c.provider === 'other' ? 'Custom' : (c.provider || '—'));
    const domains = (c.domain_names || []).join(', ') || '—';
    const usedBy = _npmCertsHostUsage[c.id] || [];
    const usedTag = usedBy.length
      ? ' <span style="background:rgba(0,120,212,0.12);color:var(--accent);padding:2px 7px;border-radius:10px;font-size:11px" title="' + _esc(usedBy.join(' | ')) + '">In use × ' + usedBy.length + '</span>'
      : '';
    const renewBtn = c.provider === 'letsencrypt'
      ? '<button type="button" class="btn btn-sm" onclick="renewNpmCert(' + c.id + ')" title="Renew certificate">Renew</button> '
      : '';
    const dlBtn = '<button type="button" class="btn btn-sm" onclick="downloadNpmCert(' + c.id + ')" title="Download certificate (zip)">Download</button> ';
    return '<tr>'
      + '<td style="padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text2)">' + c.id + '</td>'
      + '<td style="padding:10px 14px;border-bottom:1px solid var(--border)">' + _esc(c.nice_name || '—') + usedTag + '</td>'
      + '<td style="padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text2)">' + _esc(providerLabel) + '</td>'
      + '<td style="padding:10px 14px;border-bottom:1px solid var(--border);max-width:280px;word-break:break-all">' + _esc(domains) + '</td>'
      + '<td style="padding:10px 14px;border-bottom:1px solid var(--border);color:' + exp.color + ';white-space:nowrap">' + _esc(exp.text) + '</td>'
      + '<td style="padding:10px 14px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap">'
        + dlBtn
        + renewBtn
        + '<button type="button" class="btn btn-sm" onclick="deleteNpmCert(' + c.id + ')" title="Delete" style="color:var(--err-text)">Delete</button>'
      + '</td>'
      + '</tr>';
  }).join('');
}

function openNpmCertLEModal() {
  document.getElementById('leDomains').value = '';
  document.getElementById('leEmail').value = '';
  document.getElementById('leDnsChallenge').checked = false;
  document.getElementById('leAgree').checked = false;
  setNpmStatus('leStatus', '', '');
  document.getElementById('npmCertLEModal').classList.add('active');
}
function closeNpmCertLEModal() {
  document.getElementById('npmCertLEModal').classList.remove('active');
}

async function saveNpmCertLE() {
  const domains = document.getElementById('leDomains').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const email = document.getElementById('leEmail').value.trim();
  const dns = document.getElementById('leDnsChallenge').checked;
  const agree = document.getElementById('leAgree').checked;
  if (!domains.length) { setNpmStatus('leStatus', 'At least one domain is required.', 'err'); return; }
  if (!email) { setNpmStatus('leStatus', 'Email is required.', 'err'); return; }
  if (!agree) { setNpmStatus('leStatus', 'You must agree to the Let\'s Encrypt Terms of Service.', 'err'); return; }
  const btn = document.getElementById('leSaveBtn');
  btn.disabled = true;
  setNpmStatus('leStatus', 'Requesting certificate…', 'info');
  try {
    const payload = {
      provider: 'letsencrypt',
      nice_name: 'letsencrypt:' + domains[0],
      domain_names: domains,
      meta: {
        letsencrypt_agree: true,
        letsencrypt_email: email,
        ...(dns ? { dns_challenge: true } : {}),
      },
    };
    const res = await api('/admin/npm/certificates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNpmStatus('leStatus', data.error || ('Failed (' + res.status + ')'), 'err');
      return;
    }
    setNpmStatus('leStatus', 'Certificate created.', 'ok');
    closeNpmCertLEModal();
    fetchNpmCertsTable();
  } catch (e) {
    setNpmStatus('leStatus', e.message || 'Request failed.', 'err');
  } finally {
    btn.disabled = false;
  }
}

async function renewNpmCert(id) {
  if (!confirm('Renew certificate #' + id + '?\n\nLet\'s Encrypt will be asked to issue a fresh certificate.')) return;
  try {
    const res = await api('/admin/npm/certificates/' + id + '/renew', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || ('Renew failed (' + res.status + ')')); return; }
    fetchNpmCertsTable();
  } catch (e) {
    alert(e.message || 'Renew failed');
  }
}

function openNpmCertCustomModal() {
  document.getElementById('ccName').value = '';
  document.getElementById('ccKey').value = '';
  document.getElementById('ccCert').value = '';
  document.getElementById('ccIntermediate').value = '';
  setNpmStatus('ccStatus', '', '');
  document.getElementById('npmCertCustomModal').classList.add('active');
}
function closeNpmCertCustomModal() {
  document.getElementById('npmCertCustomModal').classList.remove('active');
}

async function _readFileTextHead(file, bytes) {
  if (!file) return '';
  const slice = file.slice(0, bytes);
  try { return await slice.text(); } catch { return ''; }
}

async function saveNpmCertCustom() {
  const name = document.getElementById('ccName').value.trim();
  const keyFile = document.getElementById('ccKey').files[0];
  const certFile = document.getElementById('ccCert').files[0];
  const intFile = document.getElementById('ccIntermediate').files[0];
  if (!name) { setNpmStatus('ccStatus', 'Name is required.', 'err'); return; }
  if (!keyFile) { setNpmStatus('ccStatus', 'Certificate key file is required.', 'err'); return; }
  if (!certFile) { setNpmStatus('ccStatus', 'Certificate file is required.', 'err'); return; }
  const MAX = 256 * 1024;
  if (keyFile.size > MAX) { setNpmStatus('ccStatus', 'Key file exceeds 256 KB.', 'err'); return; }
  if (certFile.size > MAX) { setNpmStatus('ccStatus', 'Certificate file exceeds 256 KB.', 'err'); return; }
  if (intFile && intFile.size > MAX) { setNpmStatus('ccStatus', 'Intermediate file exceeds 256 KB.', 'err'); return; }
  // Best-effort: detect passphrase-protected keys client-side before upload.
  const head = await _readFileTextHead(keyFile, 4096);
  if (/ENCRYPTED/.test(head)) {
    setNpmStatus('ccStatus', 'This key looks passphrase-protected. Decrypt it first (openssl rsa -in enc.key -out plain.key).', 'err');
    return;
  }
  const btn = document.getElementById('ccSaveBtn');
  btn.disabled = true;
  setNpmStatus('ccStatus', 'Uploading…', 'info');
  try {
    const form = new FormData();
    form.append('nice_name', name);
    form.append('certificate', certFile);
    form.append('certificate_key', keyFile);
    if (intFile) form.append('intermediate_certificate', intFile);
    // Bypass api() so the browser sets multipart Content-Type with boundary.
    const res = await fetch('/admin/npm/certificates/custom', { method: 'POST', body: form, credentials: 'same-origin' });
    if (res.status === 401) { window.location.reload(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNpmStatus('ccStatus', data.error || ('Failed (' + res.status + ')'), 'err');
      return;
    }
    setNpmStatus('ccStatus', 'Certificate uploaded.', 'ok');
    closeNpmCertCustomModal();
    fetchNpmCertsTable();
  } catch (e) {
    setNpmStatus('ccStatus', e.message || 'Upload failed.', 'err');
  } finally {
    btn.disabled = false;
  }
}

async function downloadNpmCert(id) {
  try {
    const res = await api('/admin/npm/certificates/' + id + '/download');
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || ('Download failed (' + res.status + ')'));
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename="?([^";]+)"?/i);
    const fname = (m && m[1]) || ('npm-cert-' + id + '.zip');
    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  } catch (e) {
    alert(e.message || 'Download failed');
  }
}

async function deleteNpmCert(id) {
  const usedBy = _npmCertsHostUsage[id] || [];
  const usedWarn = usedBy.length
    ? '\n\nWARNING: this certificate is used by ' + usedBy.length + ' proxy host(s):\n  • ' + usedBy.join('\n  • ') + '\n\nNPM will block deletion until those hosts are reassigned.'
    : '';
  if (!confirm('Delete certificate #' + id + '?' + usedWarn)) return;
  try {
    const res = await api('/admin/npm/certificates/' + id, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || ('Delete failed (' + res.status + ')')); return; }
    fetchNpmCertsTable();
  } catch (e) {
    alert(e.message || 'Delete failed');
  }
}

function _readNpmForm(passwordOnlyIfFilled) {
  const pw = document.getElementById('npmPassword').value;
  const body = {
    url: document.getElementById('npmUrl').value.trim(),
    email: document.getElementById('npmEmail').value.trim(),
    midlemanPublicHost: document.getElementById('npmMidlemanHost').value.trim(),
    enabled: document.getElementById('npmEnabled').checked,
  };
  if (!passwordOnlyIfFilled || pw) body.password = pw;
  return body;
}

function openNpmConfigModal() {
  // Refresh form fields from server state before showing
  fetchNpmConfig().finally(() => {
    document.getElementById('npmConfigModal').classList.add('active');
  });
}
function closeNpmConfigModal() {
  document.getElementById('npmConfigModal').classList.remove('active');
}

async function saveNpmConfig(closeModalOnSuccess) {
  const body = _readNpmForm(true);
  if (!body.url) { setNpmStatus('npmStatus', 'URL is required.', 'err'); return; }
  if (!body.email) { setNpmStatus('npmStatus', 'Email is required.', 'err'); return; }
  if (body.enabled && !_npmHasPassword && !body.password) {
    setNpmStatus('npmStatus', 'Password is required to enable the integration.', 'err');
    return;
  }
  setNpmStatus('npmStatus', 'Saving…', 'info');
  try {
    const res = await api('/admin/npm', { method: 'PUT', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setNpmStatus('npmStatus', data.error || 'Failed to save.', 'err'); return; }
    toast('NPM configuration saved');
    await fetchNpmConfig();
    // Re-evaluate the "Import from NPM" button visibility on the Profiles page
    // and refresh the linked-host badges, even if the user isn't on that page.
    try { await fetchProfiles(); } catch { /* ignore */ }
    if (closeModalOnSuccess) closeNpmConfigModal();
  } catch (e) {
    setNpmStatus('npmStatus', 'Network error: ' + e.message, 'err');
  }
}

async function testNpmConnectionUi() {
  const url = document.getElementById('npmUrl').value.trim();
  const email = document.getElementById('npmEmail').value.trim();
  const password = document.getElementById('npmPassword').value;
  if (!url || !email) { setNpmStatus('npmStatus', 'URL and email are required.', 'err'); return; }
  setNpmStatus('npmStatus', 'Testing connection…', 'info');
  try {
    const body = (password) ? { url, email, password } : {};
    const res = await fetch('/admin/npm/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { window.location.reload(); return; }
    const data = await res.json();
    if (data.ok) setNpmStatus('npmStatus', 'Connection OK ✔' + (data.version ? ' — NPM ' + data.version : ''), 'ok');
    else setNpmStatus('npmStatus', 'Failed: ' + (data.error || 'unknown error'), 'err');
  } catch (e) {
    setNpmStatus('npmStatus', 'Network error: ' + e.message, 'err');
  }
}

async function clearNpmConfig() {
  if (!(await showConfirm({ title: 'Remover integração NPM', message: 'Remover a configuração de integração NPM?', confirmText: 'Remover' }))) return;
  try {
    const res = await api('/admin/npm', { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return setNpmStatus('npmStatus', d.error || 'Error', 'err'); }
    toast('NPM configuration removed');
    await fetchNpmConfig();
    try { await fetchProfiles(); } catch { /* ignore */ }
    _npmHostsAll = [];
  } catch (e) {
    setNpmStatus('npmStatus', 'Network error: ' + e.message, 'err');
  }
}

function _npmLocationRowHtml(loc, idx) {
  const path = (loc && loc.path) || '';
  const scheme = (loc && loc.forwardScheme) || 'http';
  const host = (loc && loc.forwardHost) || '';
  const port = (loc && (loc.forwardPort ?? '')) || '';
  const adv = (loc && loc.advancedConfig) || '';
  const optHttp = scheme === 'http' ? ' selected' : '';
  const optHttps = scheme === 'https' ? ' selected' : '';
  return '<div class="npm-loc-row" data-idx="' + idx + '" style="display:grid;grid-template-columns:1fr 90px 1.4fr 90px auto;gap:6px;align-items:start">' +
    '<input type="text" class="npm-loc-path" value="' + _esc(path) + '" placeholder="/api" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px">' +
    '<select class="npm-loc-scheme" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px"><option value="http"' + optHttp + '>http</option><option value="https"' + optHttps + '>https</option></select>' +
    '<input type="text" class="npm-loc-host" value="' + _esc(host) + '" placeholder="upstream.host" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px">' +
    '<input type="number" class="npm-loc-port" min="1" max="65535" value="' + _esc(String(port)) + '" placeholder="8080" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px">' +
    '<button type="button" class="btn btn-sm" onclick="removeNpmLocation(' + idx + ')" style="color:var(--err-text);padding:6px 10px" title="Remove location">&times;</button>' +
    '<textarea class="npm-loc-adv" rows="1" placeholder="# location-specific nginx directives" style="grid-column:1 / -1;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 9px;color:var(--text);font-size:12px;font-family:monospace">' + _esc(adv) + '</textarea>' +
    '</div>';
}

function _esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderNpmLocations(locations) {
  const container = document.getElementById('pNpmLocations');
  if (!container) return;
  container.innerHTML = '';
  (locations || []).forEach((loc, idx) => {
    container.insertAdjacentHTML('beforeend', _npmLocationRowHtml(loc, idx));
  });
}

function addNpmLocation() {
  const container = document.getElementById('pNpmLocations');
  if (!container) return;
  const idx = container.querySelectorAll('.npm-loc-row').length;
  container.insertAdjacentHTML('beforeend', _npmLocationRowHtml({}, idx));
}

function removeNpmLocation(idx) {
  const container = document.getElementById('pNpmLocations');
  if (!container) return;
  const row = container.querySelector('.npm-loc-row[data-idx="' + idx + '"]');
  if (row) row.remove();
}

function readNpmLocations() {
  const out = [];
  document.querySelectorAll('#pNpmLocations .npm-loc-row').forEach(row => {
    const path = row.querySelector('.npm-loc-path').value.trim();
    const host = row.querySelector('.npm-loc-host').value.trim();
    const port = parseInt(row.querySelector('.npm-loc-port').value, 10);
    if (!path || !host || !port) return;
    const loc = {
      path: path.startsWith('/') ? path : '/' + path,
      forwardScheme: row.querySelector('.npm-loc-scheme').value === 'https' ? 'https' : 'http',
      forwardHost: host,
      forwardPort: port,
    };
    const adv = row.querySelector('.npm-loc-adv').value.trim();
    if (adv) loc.advancedConfig = adv;
    out.push(loc);
  });
  return out;
}

// ─── NPM proxy host import (adopt) ────────────────────────────────────────────

let _npmImportPreviewData = null; // payload from /preview-adopt awaiting profile save

function openNpmImportModal() {
  document.getElementById('npmImportModal').classList.add('active');
  fetchNpmProxyHosts();
}
function closeNpmImportModal() {
  document.getElementById('npmImportModal').classList.remove('active');
}

let _npmImportHostsAll = [];

async function fetchNpmProxyHosts() {
  const body = document.getElementById('npmImportBody');
  const status = document.getElementById('npmImportStatus');
  body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3)">Loading…</td></tr>';
  status.textContent = '';
  document.getElementById('npmSelectAll').checked = false;
  try {
    const res = await api('/admin/npm/proxy-hosts');
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--err-text)">' + _esc(d.error || 'Failed to load') + '</td></tr>';
      return;
    }
    const data = await res.json();
    _npmImportHostsAll = data.hosts || [];
    renderNpmImportTable();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--err-text)">' + _esc(e.message) + '</td></tr>';
  }
}

function renderNpmImportTable() {
  const body = document.getElementById('npmImportBody');
  if (!body) return;
  const q = (document.getElementById('npmImportSearch')?.value || '').trim().toLowerCase();
  const f = document.getElementById('npmImportFilter')?.value || 'available';
  const all = _npmImportHostsAll;
  if (!all.length) {
    body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3)">No proxy hosts in NPM yet.</td></tr>';
    updateNpmSelectionCount();
    return;
  }
  const hosts = all.filter(h => {
    if (q) {
      const hay = ((h.domain_names || []).join(' ') + ' ' + (h.forward_host || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const linked = !!(h.adopted && (h.linkedProfile || h.linkedWebhook));
    if (f === 'available') return !linked;
    if (f === 'linked') return linked;
    return true;
  });
  if (!hosts.length) {
    body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3)">No hosts match the current filter.</td></tr>';
    updateNpmSelectionCount();
    return;
  }
  body.innerHTML = hosts.map(h => {
    const isHttps = !!(h.certificate_id && Number(h.certificate_id) > 0);
    const domainsHtml = (h.domain_names || []).length
      ? (h.domain_names || []).map(d => {
          const href = (isHttps ? 'https://' : 'http://') + String(d).replace(/^\*\./, 'www.');
          return '<a href="' + _esc(href) + '" target="_blank" rel="noopener noreferrer" '
            + 'style="color:var(--accent);text-decoration:none" '
            + 'onmouseover="this.style.textDecoration=\'underline\'" '
            + 'onmouseout="this.style.textDecoration=\'none\'" '
            + 'onclick="event.stopPropagation()" '
            + 'title="Open ' + _esc(href) + '">' + _esc(d) + '</a>';
        }).join(', ')
      : '(no domains)';
    const fwd = (h.forward_scheme || 'http') + '://' + (h.forward_host || '?') + ':' + (h.forward_port || '?');
    const isLinked = h.adopted && (h.linkedProfile || h.linkedWebhook);
    const checkbox = isLinked
      ? '<input type="checkbox" disabled>'
      : '<input type="checkbox" class="npm-import-cb" data-host-id="' + h.id + '" onchange="updateNpmSelectionCount()">';
    let badge, action;
    if (h.linkedProfile) {
      badge = '<span style="background:var(--surface2);color:var(--text2);padding:2px 8px;border-radius:10px;font-size:11px">Linked → profile "' + _esc(h.linkedProfile) + '"</span>';
      action = '<a href="javascript:void(0)" onclick="openLinkedProfile(\'' + _esc(h.linkedProfile) + '\')" style="color:var(--accent);font-size:12px">Open</a>';
    } else if (h.linkedWebhook) {
      badge = '<span style="background:var(--surface2);color:var(--text2);padding:2px 8px;border-radius:10px;font-size:11px">Linked → webhook "' + _esc(h.linkedWebhook) + '"</span>';
      action = '<a href="javascript:void(0)" onclick="openLinkedWebhook(\'' + _esc(h.linkedWebhook) + '\')" style="color:var(--accent);font-size:12px">Open</a>';
    } else {
      badge = '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:10px;font-size:11px">Available</span>';
      action = '<div style="display:inline-flex;gap:6px">'
        + '<button class="btn btn-sm" onclick="adoptNpmHost(' + h.id + ', event)" title="Adopt as proxy with custom settings">Customize…</button>'
        + '<button class="btn btn-sm" onclick="closeNpmImportModal();openLinkProfileToHostModal(' + h.id + ')" title="Link to an existing Midleman profile">Link…</button>'
        + '</div>';
    }
    return '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:8px 12px">' + checkbox + '</td>' +
      '<td style="padding:8px 12px;color:var(--text3)">#' + h.id + '</td>' +
      '<td style="padding:8px 12px">' + domainsHtml + '</td>' +
      '<td style="padding:8px 12px;color:var(--text2);font-family:monospace;font-size:11.5px">' + _esc(fwd) + '</td>' +
      '<td style="padding:8px 12px">' + badge + '</td>' +
      '<td style="padding:8px 12px;text-align:right">' + action + '</td>' +
      '</tr>';
  }).join('');
  updateNpmSelectionCount();
}

function toggleNpmSelectAll(checked) {
  document.querySelectorAll('#npmImportBody .npm-import-cb').forEach(cb => { cb.checked = checked; });
  updateNpmSelectionCount();
}

function updateNpmSelectionCount() {
  const checked = document.querySelectorAll('#npmImportBody .npm-import-cb:checked');
  const count = checked.length;
  const countEl = document.getElementById('npmSelectionCount');
  const btn = document.getElementById('npmBulkImportBtn');
  if (countEl) countEl.textContent = count ? (count + ' host' + (count === 1 ? '' : 's') + ' selected') : '';
  if (btn) btn.disabled = count === 0;
  // Sync the master "select all" indeterminate / checked state
  const total = document.querySelectorAll('#npmImportBody .npm-import-cb').length;
  const master = document.getElementById('npmSelectAll');
  if (master) {
    master.checked = count > 0 && count === total;
    master.indeterminate = count > 0 && count < total;
  }
}

function toggleNpmBulkAuthOpts() {
  const mode = document.getElementById('npmBulkAuthMode').value;
  document.getElementById('npmBulkAccessKeyGroup').style.display = mode === 'accessKey' ? '' : 'none';
  document.getElementById('npmBulkLoginGroup').style.display = mode === 'login' ? '' : 'none';
}

function toggleNpmBulkImportAs() {
  const as = document.getElementById('npmBulkImportAs').value;
  const isProxy = as === 'proxy';
  document.getElementById('npmBulkAuthModeGroup').style.display = isProxy ? '' : 'none';
  document.getElementById('npmBulkWebhookAuthGroup').style.display = isProxy ? 'none' : '';
  // Hide proxy-specific sub-groups when switching to webhook.
  if (!isProxy) {
    document.getElementById('npmBulkAccessKeyGroup').style.display = 'none';
    document.getElementById('npmBulkLoginGroup').style.display = 'none';
  } else {
    toggleNpmBulkAuthOpts();
  }
}

function openLinkedWebhook(name) {
  closeNpmImportModal();
  if (typeof navigate === 'function') navigate('webhooks');
  if (typeof editWebhook === 'function') {
    setTimeout(() => { try { editWebhook(name); } catch { /* ignore */ } }, 30);
  }
}

async function bulkAdoptNpmHosts() {
  const ids = Array.from(document.querySelectorAll('#npmImportBody .npm-import-cb:checked'))
    .map(cb => Number(cb.getAttribute('data-host-id')))
    .filter(n => n > 0);
  if (!ids.length) return;
  const importAs = document.getElementById('npmBulkImportAs').value === 'webhook' ? 'webhook' : 'proxy';
  const body = { hostIds: ids, importAs };
  if (importAs === 'proxy') {
    const authMode = document.getElementById('npmBulkAuthMode').value;
    body.authMode = authMode;
    if (authMode === 'accessKey') {
      const k = document.getElementById('npmBulkAccessKey').value.trim();
      if (k) body.accessKey = k;
    } else if (authMode === 'login') {
      body.require2fa = document.getElementById('npmBulkRequire2fa').checked;
      body.isWebApp = document.getElementById('npmBulkIsWebApp').checked;
    }
  } else {
    const tok = document.getElementById('npmBulkWebhookAuthToken').value.trim();
    if (tok) body.authToken = tok;
  }
  const btn = document.getElementById('npmBulkImportBtn');
  const status = document.getElementById('npmImportStatus');
  status.style.color = 'var(--text2)';
  status.textContent = 'Importing ' + ids.length + ' host' + (ids.length === 1 ? '' : 's') + '…';
  await withBusy(btn, 'A importar…', async () => {
    try {
      const res = await api('/admin/npm/proxy-hosts/bulk-adopt', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        status.style.color = 'var(--err-text)';
        status.textContent = data.error || 'Bulk import failed';
        return;
      }
      const okCount = data.ok || 0;
      const failCount = data.failed || 0;
      toast(okCount + ' imported' + (failCount ? ', ' + failCount + ' failed' : ''));
      if (failCount > 0) {
        status.style.color = 'var(--err-text)';
        status.innerHTML = (data.results || []).filter(r => !r.ok).map(r => '#' + r.hostId + ': ' + _esc(r.error || 'unknown')).join('<br>');
      } else {
        status.style.color = 'var(--ok-text)';
        status.textContent = 'Done.';
      }
      if (importAs === 'webhook' && typeof fetchWebhooks === 'function') {
        await fetchWebhooks();
      } else {
        await fetchProfiles();
      }
      await fetchNpmProxyHosts();
    } catch (e) {
      status.style.color = 'var(--err-text)';
      status.textContent = 'Network error: ' + e.message;
    }
  });
}

async function adoptNpmHost(id, event) {
  return withBusy(event, 'A carregar…', async () => {
  try {
    const res = await api('/admin/npm/proxy-hosts/' + id + '/preview-adopt');
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Cannot adopt', 'error');
    _npmImportPreviewData = data.preview;
    closeNpmImportModal();
    // Open profile modal pre-filled with the host data; user picks a name and saves.
    await openProfileModal(null);
    const p = _npmImportPreviewData;
    document.getElementById('pTargetUrl').value = p.targetUrl || '';
    document.getElementById('pPublicHostnames').value = (p.publicHostnames || []).join(', ');
    document.getElementById('pTlsMode').value = p.certificateId ? 'manual' : 'none';
    document.getElementById('pHttp2').value = String(!!p.http2);
    document.getElementById('pHstsEnabled').value = String(!!p.hstsEnabled);
    document.getElementById('pSslForced').value = String(!!p.sslForced);
    document.getElementById('pAllowWebsocketUpgrade').value = String(p.allowWebsocketUpgrade !== false);
    document.getElementById('pAdvancedConfig').value = p.advancedConfig || '';
    const banner = document.getElementById('pAdoptedBanner');
    const info = document.getElementById('pAdoptedInfo');
    banner.style.display = 'flex';
    info.textContent = '#' + p.npmProxyHostId + ' — original forward ' + (p.npmOriginalForwardScheme || 'http') + '://' + p.npmOriginalForwardHost + ':' + p.npmOriginalForwardPort;
    document.getElementById('pName').focus();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
  });
}

function openLinkedProfile(name) {
  closeNpmImportModal();
  editProfile(name);
}

async function releaseProfileFromNpm(event) {
  if (!editingProfile || !editingProfile.name) return;
  if (!(await showConfirm({ title: 'Libertar perfil do NPM', message: 'Libertar este perfil do host NPM? O NPM será restaurado para o destino de encaminhamento original.', confirmText: 'Libertar' }))) return;
  await withBusy(event, 'A libertar…', async () => {
    try {
      const res = await api('/admin/profiles/' + encodeURIComponent(editingProfile.name) + '/npm-release', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.ok === false) return toast(data.error || 'Release failed', 'error');
      toast('Released from NPM');
      document.getElementById('pAdoptedBanner').style.display = 'none';
      closeProfileModal();
      await fetchProfiles();
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  });
}

// ─── NPM Proxy Host management (direct CRUD on NPM) ──────────────────────────

let _nhEditingId = null;
let _nhCertCache = [];
let _npmHostsAll = [];          // last full list from server
let _npmHostsPage = 1;
let _npmHostsPageSize = 25;

async function fetchNpmHostsTable() {
  const body = document.getElementById('npmHostsTableBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3)">Loading…</td></tr>';
  try {
    const res = await api('/admin/npm/proxy-hosts');
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--err-text)">' + _esc(d.error || 'Failed to load') + '</td></tr>';
      return;
    }
    const data = await res.json();
    _npmHostsAll = data.hosts || [];
    _npmHostsPage = 1;
    renderNpmHostsTable();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--err-text)">' + _esc(e.message) + '</td></tr>';
  }
}

function _filterNpmHosts() {
  const q = (document.getElementById('npmHostsSearch')?.value || '').trim().toLowerCase();
  const f = document.getElementById('npmHostsFilter')?.value || 'all';
  return _npmHostsAll.filter(h => {
    if (q) {
      const hay = ((h.domain_names || []).join(' ') + ' ' + (h.forward_host || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    switch (f) {
      case 'enabled': return !!h.enabled;
      case 'disabled': return !h.enabled;
      case 'ssl': return h.certificate_id && Number(h.certificate_id) > 0;
      case 'nossl': return !h.certificate_id || Number(h.certificate_id) <= 0;
      case 'linked': return !!h.linkedProfile;
      case 'unlinked': return !h.linkedProfile;
      default: return true;
    }
  });
}

function renderNpmHostsTable() {
  const body = document.getElementById('npmHostsTableBody');
  if (!body) return;
  const filtered = _filterNpmHosts();
  const total = filtered.length;
  const pageSize = _npmHostsPageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (_npmHostsPage > totalPages) _npmHostsPage = totalPages;
  const start = (_npmHostsPage - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  document.getElementById('npmHostsCount').textContent = total
    ? (total + ' host' + (total === 1 ? '' : 's'))
    : (_npmHostsAll.length ? '0 of ' + _npmHostsAll.length + ' (filtered)' : '');

  const info = document.getElementById('npmHostsPageInfo');
  if (info) info.textContent = total ? ('Page ' + _npmHostsPage + ' of ' + totalPages) : 'No results';
  const prev = document.getElementById('npmHostsPrev');
  const next = document.getElementById('npmHostsNext');
  if (prev) prev.disabled = _npmHostsPage <= 1;
  if (next) next.disabled = _npmHostsPage >= totalPages;

  if (!total) {
    body.innerHTML = '<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text3)">'
      + (_npmHostsAll.length ? 'No hosts match the current filter.' : 'No proxy hosts yet. Click <strong>+ Proxy Host</strong> to add one.')
      + '</td></tr>';
    return;
  }

  body.innerHTML = slice.map(h => {
    const isHttps = !!(h.certificate_id && Number(h.certificate_id) > 0);
    const domainsHtml = (h.domain_names || []).length
      ? (h.domain_names || []).map(d => {
          const href = (isHttps ? 'https://' : 'http://') + String(d).replace(/^\*\./, 'www.');
          return '<a href="' + _esc(href) + '" target="_blank" rel="noopener noreferrer" '
            + 'style="color:var(--accent);text-decoration:none" '
            + 'onmouseover="this.style.textDecoration=\'underline\'" '
            + 'onmouseout="this.style.textDecoration=\'none\'" '
            + 'title="Open ' + _esc(href) + '">' + _esc(d) + '</a>';
        }).join(', ')
      : '(no domains)';
    const fwd = (h.forward_scheme || 'http') + '://' + (h.forward_host || '?') + ':' + (h.forward_port || '?');
    const sslBadge = (h.certificate_id && Number(h.certificate_id) > 0)
      ? '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 7px;border-radius:10px;font-size:11px">SSL</span>'
      : '<span style="color:var(--text3);font-size:11px">—</span>';
    const enabledBadge = h.enabled
      ? '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 7px;border-radius:10px;font-size:11px">Enabled</span>'
      : '<span style="background:var(--surface2);color:var(--text2);padding:2px 7px;border-radius:10px;font-size:11px">Disabled</span>';
    const linkedTag = h.linkedProfile
      ? ' <span style="background:rgba(0,120,212,0.12);color:var(--accent);padding:2px 7px;border-radius:10px;font-size:11px">Linked → ' + _esc(h.linkedProfile) + '</span>'
      : '';
    const isLinked = !!h.linkedProfile;
    const toggleAction = h.enabled
      ? '<button type="button" class="btn btn-sm" onclick="toggleNpmHost(' + h.id + ', false, event)" title="Disable">Disable</button>'
      : '<button type="button" class="btn btn-sm" onclick="toggleNpmHost(' + h.id + ', true, event)" title="Enable">Enable</button>';
    const editBtn = isLinked
      ? '<button type="button" class="btn btn-sm" onclick="openLinkedProfile(\'' + _esc(h.linkedProfile) + '\')" title="Open linked profile">Open profile</button>'
      : '<button type="button" class="btn btn-sm" onclick="openNpmHostModal(' + h.id + ')">Edit</button>';
    const linkBtn = isLinked
      ? ''
      : '<button type="button" class="btn btn-sm" onclick="openLinkProfileToHostModal(' + h.id + ')" title="Link this host to an existing Midleman profile">Link…</button>';
    const delBtn = isLinked
      ? '<button type="button" class="btn btn-sm" disabled title="Release the linked profile first">Delete</button>'
      : '<button type="button" class="btn btn-sm" onclick="deleteNpmHost(' + h.id + ', event)" style="color:var(--err-text)">Delete</button>';
    return '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:10px 14px;color:var(--text3)">#' + h.id + '</td>' +
      '<td style="padding:10px 14px">' + domainsHtml + linkedTag + '</td>' +
      '<td style="padding:10px 14px;color:var(--text2);font-family:monospace;font-size:11.5px">' + _esc(fwd) + '</td>' +
      '<td style="padding:10px 14px">' + sslBadge + '</td>' +
      '<td style="padding:10px 14px">' + enabledBadge + '</td>' +
      '<td style="padding:10px 14px;text-align:right;white-space:nowrap"><div style="display:inline-flex;gap:6px">' + toggleAction + editBtn + linkBtn + delBtn + '</div></td>' +
      '</tr>';
  }).join('');
}

function changeNpmPage(delta) {
  const total = _filterNpmHosts().length;
  const totalPages = Math.max(1, Math.ceil(total / _npmHostsPageSize));
  _npmHostsPage = Math.min(totalPages, Math.max(1, _npmHostsPage + delta));
  renderNpmHostsTable();
}

function onNpmPageSizeChange() {
  _npmHostsPageSize = parseInt(document.getElementById('npmHostsPageSize').value, 10) || 25;
  _npmHostsPage = 1;
  renderNpmHostsTable();
}

async function toggleNpmHost(id, enable, event) {
  if (!enable && !(await showConfirm({ title: 'Desativar proxy host', message: 'Desativar proxy host #' + id + '? Deixará de servir pedidos até ser reativado.', confirmText: 'Desativar' }))) return;
  await withBusy(event, enable ? 'A activar…' : 'A desactivar…', async () => {
    try {
      const path = '/admin/npm/proxy-hosts/' + id + '/' + (enable ? 'enable' : 'disable');
      const res = await api(path, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) return toast(d.error || 'Failed', 'error');
      toast('Host ' + (enable ? 'enabled' : 'disabled'));
      await fetchNpmHostsTable();
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });
}

async function deleteNpmHost(id, event) {
  const host = _npmHostsAll.find(h => h.id === id);
  const domains = host ? (host.domain_names || []).join(', ') : '#' + id;
  if (!(await showConfirm({ title: 'Apagar proxy host', message: 'Apagar proxy host "' + domains + '"?', detail: 'Isto remove-o do NPM permanentemente. O certificado associado (se existir) não é apagado.', confirmText: 'Apagar' }))) return;
  await withBusy(event, 'A apagar…', async () => {
    try {
      const res = await api('/admin/npm/proxy-hosts/' + id, { method: 'DELETE' });
      const d = await res.json();
      if (!res.ok) return toast(d.error || 'Delete failed', 'error');
      toast('Host deleted');
      await fetchNpmHostsTable();
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });
}

// Modal
function switchNpmHostTab(tab) {
  document.querySelectorAll('.npm-host-tab').forEach(btn => {
    const active = btn.getAttribute('data-tab') === tab;
    btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    btn.style.color = active ? 'var(--text)' : 'var(--text2)';
    btn.style.fontWeight = active ? '500' : '400';
  });
  document.querySelectorAll('.npm-host-pane').forEach(p => {
    p.style.display = p.getAttribute('data-pane') === tab ? '' : 'none';
  });
}

async function openNpmHostModal(id) {
  _nhEditingId = id;
  document.getElementById('npmHostModalTitle').textContent = id ? ('Edit Proxy Host #' + id) : 'Add Proxy Host';
  setNpmStatus('nhStatus', '', 'info');
  switchNpmHostTab('details');
  // Reset form
  document.getElementById('nhDomains').value = '';
  document.getElementById('nhScheme').value = 'http';
  document.getElementById('nhForwardHost').value = '';
  document.getElementById('nhForwardPort').value = '';
  document.getElementById('nhCacheAssets').checked = false;
  document.getElementById('nhBlockExploits').checked = true;
  document.getElementById('nhWebsocket').checked = false;
  document.getElementById('nhSslForced').checked = false;
  document.getElementById('nhHttp2').checked = false;
  document.getElementById('nhHsts').checked = false;
  document.getElementById('nhHstsSub').checked = false;
  document.getElementById('nhLocations').innerHTML = '';

  // Load certificates for the SSL dropdown
  await reloadNhCerts(null);

  if (id) {
    try {
      const res = await api('/admin/npm/proxy-hosts/' + id);
      const data = await res.json();
      if (!res.ok) { setNpmStatus('nhStatus', data.error || 'Failed to load', 'err'); return; }
      const h = data.host;
      document.getElementById('nhDomains').value = (h.domain_names || []).join(', ');
      document.getElementById('nhScheme').value = h.forward_scheme || 'http';
      document.getElementById('nhForwardHost').value = h.forward_host || '';
      document.getElementById('nhForwardPort').value = h.forward_port || '';
      document.getElementById('nhCacheAssets').checked = !!h.caching_enabled;
      document.getElementById('nhBlockExploits').checked = !!h.block_exploits;
      document.getElementById('nhWebsocket').checked = !!h.allow_websocket_upgrade;
      document.getElementById('nhSslForced').checked = !!h.ssl_forced;
      document.getElementById('nhHttp2').checked = !!h.http2_support;
      document.getElementById('nhHsts').checked = !!h.hsts_enabled;
      document.getElementById('nhHstsSub').checked = !!h.hsts_subdomains;
      const certSel = document.getElementById('nhCertId');
      const certIdStr = (typeof h.certificate_id === 'number' && h.certificate_id > 0) ? String(h.certificate_id) : '';
      certSel.value = certIdStr;
      onNhCertChange();
      // Locations
      const locs = (h.locations || []);
      const cont = document.getElementById('nhLocations');
      cont.innerHTML = '';
      locs.forEach(l => cont.insertAdjacentHTML('beforeend', _nhLocRowHtml({
        path: l.path || '',
        forward_scheme: l.forward_scheme || 'http',
        forward_host: l.forward_host || '',
        forward_port: l.forward_port || '',
        advanced_config: l.advanced_config || '',
      }, cont.querySelectorAll('.nh-loc-row').length)));
    } catch (e) {
      setNpmStatus('nhStatus', 'Error: ' + e.message, 'err');
      return;
    }
  }
  document.getElementById('npmHostModal').classList.add('active');
}

function closeNpmHostModal() {
  document.getElementById('npmHostModal').classList.remove('active');
  _nhEditingId = null;
}

async function reloadNhCerts(selectedId) {
  try {
    const res = await api('/admin/npm/certificates');
    if (!res.ok) return;
    const data = await res.json();
    _nhCertCache = data.certificates || [];
    const sel = document.getElementById('nhCertId');
    const cur = selectedId != null ? String(selectedId) : sel.value;
    sel.innerHTML = '<option value="">None</option><option value="new">Request a new SSL Certificate</option>' +
      _nhCertCache.map(c => '<option value="' + c.id + '">#' + c.id + ' — ' + _esc((c.domain_names || []).join(', ') || c.nice_name || 'cert') + '</option>').join('');
    sel.value = cur;
    onNhCertChange();
  } catch { /* ignore */ }
}

function onNhCertChange() {
  const v = document.getElementById('nhCertId').value;
  document.getElementById('nhCertNewGroup').style.display = v === 'new' ? '' : 'none';
  // Toggle SSL-related options visibility-wise: leave them all visible but they're only meaningful with a cert.
}

function _nhLocRowHtml(loc, idx) {
  loc = loc || {};
  return '<div class="nh-loc-row" data-idx="' + idx + '" style="display:grid;grid-template-columns:1fr 90px 1.4fr 90px auto;gap:6px;align-items:start;padding:8px;background:var(--surface2);border-radius:6px">' +
    '<input type="text" class="nh-loc-path" value="' + _esc(loc.path || '') + '" placeholder="/path" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px">' +
    '<select class="nh-loc-scheme" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px"><option value="http"' + (loc.forward_scheme === 'http' ? ' selected' : '') + '>http</option><option value="https"' + (loc.forward_scheme === 'https' ? ' selected' : '') + '>https</option></select>' +
    '<input type="text" class="nh-loc-host" value="' + _esc(loc.forward_host || '') + '" placeholder="eg: 10.0.0.1" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px">' +
    '<input type="number" class="nh-loc-port" min="1" max="65535" value="' + _esc(String(loc.forward_port ?? '')) + '" placeholder="80" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 9px;color:var(--text);font-size:12.5px">' +
    '<button type="button" class="btn btn-sm" onclick="removeNhLocation(' + idx + ')" style="color:var(--err-text);padding:6px 10px" title="Delete">&times;</button>' +
    '<textarea class="nh-loc-adv" rows="1" placeholder="# advanced config (optional)" style="grid-column:1 / -1;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 9px;color:var(--text);font-size:12px;font-family:monospace">' + _esc(loc.advanced_config || '') + '</textarea>' +
    '</div>';
}

function addNhLocation() {
  const cont = document.getElementById('nhLocations');
  const idx = cont.querySelectorAll('.nh-loc-row').length;
  cont.insertAdjacentHTML('beforeend', _nhLocRowHtml({ forward_scheme: 'http', forward_port: 80 }, idx));
}

function removeNhLocation(idx) {
  const cont = document.getElementById('nhLocations');
  const row = cont.querySelector('.nh-loc-row[data-idx="' + idx + '"]');
  if (row) row.remove();
}

function readNhLocations() {
  const out = [];
  document.querySelectorAll('#nhLocations .nh-loc-row').forEach(row => {
    const path = row.querySelector('.nh-loc-path').value.trim();
    const host = row.querySelector('.nh-loc-host').value.trim();
    const port = parseInt(row.querySelector('.nh-loc-port').value, 10);
    if (!path || !host || !port) return;
    out.push({
      path,
      forward_scheme: row.querySelector('.nh-loc-scheme').value === 'https' ? 'https' : 'http',
      forward_host: host,
      forward_port: port,
      advanced_config: row.querySelector('.nh-loc-adv').value || '',
    });
  });
  return out;
}

async function saveNpmHost() {
  const domains = document.getElementById('nhDomains').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const forwardHost = document.getElementById('nhForwardHost').value.trim();
  const forwardPort = parseInt(document.getElementById('nhForwardPort').value, 10);
  if (!domains.length) { setNpmStatus('nhStatus', 'At least one domain is required.', 'err'); return; }
  if (!forwardHost) { setNpmStatus('nhStatus', 'Forward host is required.', 'err'); return; }
  if (!forwardPort) { setNpmStatus('nhStatus', 'Forward port is required.', 'err'); return; }

  const certSelVal = document.getElementById('nhCertId').value;
  let certificateId = null;
  if (certSelVal && certSelVal !== 'new') certificateId = Number(certSelVal);

  const btn = document.getElementById('nhSaveBtn');
  btn.disabled = true;
  setNpmStatus('nhStatus', 'Saving…', 'info');

  try {
    // Step 1: if user picked "Request new cert", create it first.
    if (certSelVal === 'new') {
      const email = document.getElementById('nhCertEmail').value.trim();
      const agree = document.getElementById('nhCertAgree').checked;
      const dns = document.getElementById('nhCertDns').checked;
      if (!email) { setNpmStatus('nhStatus', 'Email is required to request a Let\'s Encrypt certificate.', 'err'); btn.disabled = false; return; }
      if (!agree) { setNpmStatus('nhStatus', 'You must agree to the Let\'s Encrypt Terms of Service.', 'err'); btn.disabled = false; return; }
      setNpmStatus('nhStatus', 'Requesting Let\'s Encrypt certificate…', 'info');
      const certRes = await api('/admin/npm/certificates', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'letsencrypt',
          domain_names: domains,
          meta: { letsencrypt_agree: true, letsencrypt_email: email, dns_challenge: dns },
        }),
      });
      const certData = await certRes.json();
      if (!certRes.ok) { setNpmStatus('nhStatus', 'Cert request failed: ' + (certData.error || 'unknown'), 'err'); btn.disabled = false; return; }
      certificateId = certData.certificate.id;
    }

    const payload = {
      domain_names: domains,
      forward_scheme: document.getElementById('nhScheme').value,
      forward_host: forwardHost,
      forward_port: forwardPort,
      certificate_id: certificateId,
      ssl_forced: document.getElementById('nhSslForced').checked && !!certificateId,
      http2_support: document.getElementById('nhHttp2').checked && !!certificateId,
      hsts_enabled: document.getElementById('nhHsts').checked && !!certificateId,
      hsts_subdomains: document.getElementById('nhHstsSub').checked && !!certificateId,
      caching_enabled: document.getElementById('nhCacheAssets').checked,
      block_exploits: document.getElementById('nhBlockExploits').checked,
      allow_websocket_upgrade: document.getElementById('nhWebsocket').checked,
      locations: readNhLocations(),
    };

    const path = _nhEditingId ? ('/admin/npm/proxy-hosts/' + _nhEditingId) : '/admin/npm/proxy-hosts';
    const method = _nhEditingId ? 'PUT' : 'POST';
    const res = await api(path, { method, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) { setNpmStatus('nhStatus', data.error || 'Save failed', 'err'); btn.disabled = false; return; }
    toast(_nhEditingId ? 'Proxy host updated' : 'Proxy host created');
    closeNpmHostModal();
    await fetchNpmHostsTable();
  } catch (e) {
    setNpmStatus('nhStatus', 'Error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function syncProfileToNpm(profileName) {
  if (!profileName) return;
  try {
    const res = await api('/admin/npm/sync/' + encodeURIComponent(profileName), { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) toast('Synced "' + profileName + '" to NPM (' + (data.action || 'ok') + ')');
    else toast('Sync failed: ' + (data.error || 'unknown error'), 'error');
  } catch (e) {
    toast('Sync error: ' + e.message, 'error');
  }
}

// ─── SMS (WeSender / Twilio) ─────────────────────────────────────────────────

let _smsHasWeKey = false;
let _smsHasTwToken = false;
let _smsCurrentPrefixRules = [];

function setSmsStatus(elId, msg, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!msg) { el.textContent = ''; el.style.color = ''; return; }
  const colorMap = { ok: 'var(--ok-text)', err: 'var(--err-text)', info: 'var(--text2)' };
  el.style.color = colorMap[kind] || colorMap.info;
  el.textContent = msg;
}

function updateSmsRoutingVisibility() {
  const mode = document.getElementById('smsRouting').value;
  document.getElementById('smsSecondaryWrap').style.display = (mode === 'failover') ? '' : 'none';
  document.getElementById('smsPrefixCard').style.display = (mode === 'by-prefix') ? '' : 'none';
  document.getElementById('smsPrimaryWrap').style.display = (mode === 'by-prefix') ? 'none' : '';
  const hint = document.getElementById('smsRoutingHint');
  if (hint) {
    if (mode === 'single') hint.textContent = 'All messages go through the primary provider.';
    else if (mode === 'failover') hint.textContent = 'Try the primary provider first; on failure, automatically retry with the fallback.';
    else hint.textContent = 'Match each destination against the rules below in order. Use "*" as catch-all.';
  }
  _renderSmsProviderBadges();
}

function _setStatusPill(el, label, kind) {
  if (!el) return;
  if (!label) { el.style.display = 'none'; return; }
  const palette = {
    ok:   { bg: 'rgba(34,197,94,0.15)',  fg: 'var(--ok-text)' },
    warn: { bg: 'rgba(234,179,8,0.18)',  fg: 'var(--warn-text, #ca8a04)' },
    err:  { bg: 'rgba(239,68,68,0.15)',  fg: 'var(--err-text)' },
    mute: { bg: 'var(--surface2)',       fg: 'var(--text3)' },
  };
  const p = palette[kind] || palette.mute;
  el.style.display = 'inline-block';
  el.style.background = p.bg;
  el.style.color = p.fg;
  el.textContent = label;
}

function _badgeHtml(label, kind) {
  const palette = {
    ok:   'background:rgba(34,197,94,0.15);color:var(--ok-text)',
    warn: 'background:rgba(234,179,8,0.18);color:#ca8a04',
    err:  'background:rgba(239,68,68,0.15);color:var(--err-text)',
    mute: 'background:var(--surface2);color:var(--text3)',
  };
  return '<span style="font-size:10.5px;padding:3px 8px;border-radius:8px;font-weight:500;letter-spacing:.3px;' + (palette[kind] || palette.mute) + '">' + label + '</span>';
}

function _renderSmsProviderBadges() {
  const enabled = document.getElementById('smsEnabled');
  const routing = document.getElementById('smsRouting');
  const primary = document.getElementById('smsPrimary');
  const secondary = document.getElementById('smsSecondary');
  if (!enabled || !routing) return;
  const isEnabled = enabled.checked;
  const mode = routing.value;
  const usedByPrefix = new Set();
  if (mode === 'by-prefix') {
    _smsCurrentPrefixRules.forEach(r => { if (r && r.provider) usedByPrefix.add(r.provider); });
  }

  function badgesFor(providerId, hasSecret, missingPieces) {
    const parts = [];
    if (isEnabled) {
      if (mode === 'single' && primary.value === providerId) parts.push(_badgeHtml('Active', 'ok'));
      else if (mode === 'failover' && primary.value === providerId) parts.push(_badgeHtml('Primary', 'ok'));
      else if (mode === 'failover' && secondary.value === providerId) parts.push(_badgeHtml('Fallback', 'ok'));
      else if (mode === 'by-prefix' && usedByPrefix.has(providerId)) parts.push(_badgeHtml('In routing', 'ok'));
      else parts.push(_badgeHtml('Idle', 'mute'));
    } else {
      parts.push(_badgeHtml('Disabled', 'mute'));
    }
    if (missingPieces.length === 0) {
      parts.push(_badgeHtml(hasSecret ? 'Configured' : 'Missing key', hasSecret ? 'ok' : 'warn'));
    } else {
      parts.push(_badgeHtml('Needs: ' + missingPieces.join(', '), 'warn'));
    }
    return parts.join('');
  }

  const weBadgesEl = document.getElementById('smsWeBadges');
  const twBadgesEl = document.getElementById('smsTwBadges');
  if (weBadgesEl) {
    const missing = [];
    if (!_smsHasWeKey && !document.getElementById('smsWeApiKey').value) missing.push('ApiKey');
    weBadgesEl.innerHTML = badgesFor('wesender', _smsHasWeKey || !!document.getElementById('smsWeApiKey').value, missing);
  }
  if (twBadgesEl) {
    const missing = [];
    const sid = document.getElementById('smsTwSid').value.trim();
    const from = document.getElementById('smsTwFrom').value.trim();
    const tokenPresent = _smsHasTwToken || !!document.getElementById('smsTwToken').value;
    if (!sid) missing.push('SID');
    if (!tokenPresent) missing.push('Token');
    if (!from) missing.push('From');
    twBadgesEl.innerHTML = badgesFor('twilio', sid && tokenPresent && from, missing);
  }
}

function _updateSmsStatusPill(cfg) {
  const pill = document.getElementById('smsStatusPill');
  if (!pill) return;
  if (!cfg) return _setStatusPill(pill, 'Not configured', 'mute');
  if (!cfg.enabled) return _setStatusPill(pill, 'Disabled', 'mute');
  const haveWe = cfg.wesender && cfg.wesender.hasApiKey;
  const haveTw = cfg.twilio && cfg.twilio.hasAuthToken && cfg.twilio.accountSid && cfg.twilio.fromNumber;
  if (!haveWe && !haveTw) return _setStatusPill(pill, 'Incomplete', 'warn');
  _setStatusPill(pill, 'Active', 'ok');
}

function renderSmsPrefixRules() {
  const wrap = document.getElementById('smsPrefixRules');
  if (!wrap) return;
  wrap.innerHTML = '';
  _smsCurrentPrefixRules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center';
    row.innerHTML =
      '<input type="text" value="' + (rule.prefix || '').replace(/"/g, '&quot;') + '" placeholder="+244 or *" data-idx="' + idx + '" data-field="prefix" style="flex:0 0 160px;padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">' +
      '<select data-idx="' + idx + '" data-field="provider" style="flex:0 0 160px;padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">' +
        '<option value="wesender"' + (rule.provider === 'wesender' ? ' selected' : '') + '>WeSender</option>' +
        '<option value="twilio"' + (rule.provider === 'twilio' ? ' selected' : '') + '>Twilio</option>' +
      '</select>' +
      '<button class="btn btn-sm" data-idx="' + idx + '" data-action="del" style="color:var(--err-text)">Remove</button>';
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('input,select').forEach(el => {
    el.addEventListener('change', e => {
      const i = parseInt(e.target.getAttribute('data-idx'), 10);
      const f = e.target.getAttribute('data-field');
      _smsCurrentPrefixRules[i][f] = e.target.value.trim();
      _renderSmsProviderBadges();
    });
  });
  wrap.querySelectorAll('button[data-action="del"]').forEach(b => {
    b.addEventListener('click', e => {
      const i = parseInt(e.target.getAttribute('data-idx'), 10);
      _smsCurrentPrefixRules.splice(i, 1);
      renderSmsPrefixRules();
      _renderSmsProviderBadges();
    });
  });
}

function addSmsPrefixRule() {
  _smsCurrentPrefixRules.push({ prefix: '', provider: 'wesender' });
  renderSmsPrefixRules();
  _renderSmsProviderBadges();
}

async function fetchSmsConfig() {
  try {
    const res = await api('/admin/sms');
    if (!res.ok) return;
    const data = await res.json();
    const cfg = data.sms;
    const enabledEl = document.getElementById('smsEnabled');
    const routingEl = document.getElementById('smsRouting');
    const primaryEl = document.getElementById('smsPrimary');
    const secondaryEl = document.getElementById('smsSecondary');
    const ccEl = document.getElementById('smsDefaultCC');
    const weKeyEl = document.getElementById('smsWeApiKey');
    const weCEspEl = document.getElementById('smsWeCEspeciais');
    const weHint = document.getElementById('smsWeKeyHint');
    const twSidEl = document.getElementById('smsTwSid');
    const twTokenEl = document.getElementById('smsTwToken');
    const twTokenHint = document.getElementById('smsTwTokenHint');
    const twFromEl = document.getElementById('smsTwFrom');
    const clearBtn = document.getElementById('smsClearBtn');
    if (cfg) {
      enabledEl.checked = !!cfg.enabled;
      routingEl.value = cfg.routing || 'single';
      primaryEl.value = cfg.primary || 'wesender';
      secondaryEl.value = cfg.secondary || 'twilio';
      ccEl.value = cfg.defaultCountryCode || '';
      weKeyEl.value = '';
      weCEspEl.checked = !!(cfg.wesender && cfg.wesender.defaultCEspeciais);
      _smsHasWeKey = !!(cfg.wesender && cfg.wesender.hasApiKey);
      weHint.textContent = _smsHasWeKey ? 'Leave empty to keep the current key.' : 'No ApiKey set.';
      twSidEl.value = (cfg.twilio && cfg.twilio.accountSid) || '';
      twTokenEl.value = '';
      _smsHasTwToken = !!(cfg.twilio && cfg.twilio.hasAuthToken);
      twTokenHint.textContent = _smsHasTwToken ? 'Leave empty to keep the current token.' : 'No token set.';
      twFromEl.value = (cfg.twilio && cfg.twilio.fromNumber) || '';
      _smsCurrentPrefixRules = Array.isArray(cfg.prefixRules) ? cfg.prefixRules.map(r => ({ prefix: r.prefix || '', provider: r.provider || 'wesender' })) : [];
      clearBtn.style.display = '';
      setSmsStatus('smsStatus', cfg.enabled ? 'SMS active (routing: ' + cfg.routing + ').' : 'SMS configuration saved but disabled.', cfg.enabled ? 'ok' : 'info');
    } else {
      enabledEl.checked = false;
      routingEl.value = 'single';
      primaryEl.value = 'wesender';
      secondaryEl.value = 'twilio';
      ccEl.value = '';
      weKeyEl.value = '';
      weCEspEl.checked = false;
      _smsHasWeKey = false;
      weHint.textContent = 'No ApiKey set.';
      twSidEl.value = '';
      twTokenEl.value = '';
      _smsHasTwToken = false;
      twTokenHint.textContent = 'No token set.';
      twFromEl.value = '';
      _smsCurrentPrefixRules = [];
      clearBtn.style.display = 'none';
      setSmsStatus('smsStatus', 'No SMS configuration active.', 'info');
    }
    updateSmsRoutingVisibility();
    renderSmsPrefixRules();
    _updateSmsStatusPill(cfg);
    _renderSmsProviderBadges();
    _bindSmsLiveBadges();
  } catch (e) {
    setSmsStatus('smsStatus', 'Failed to load: ' + e.message, 'err');
  }
}

let _smsLiveBound = false;
function _bindSmsLiveBadges() {
  if (_smsLiveBound) return;
  _smsLiveBound = true;
  ['smsEnabled','smsPrimary','smsSecondary','smsWeApiKey','smsTwSid','smsTwToken','smsTwFrom'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, _renderSmsProviderBadges);
  });
}

function _readSmsForm() {
  const routing = document.getElementById('smsRouting').value;
  const body = {
    enabled: document.getElementById('smsEnabled').checked,
    routing,
    primary: document.getElementById('smsPrimary').value,
    secondary: document.getElementById('smsSecondary').value,
    defaultCountryCode: document.getElementById('smsDefaultCC').value.trim(),
    prefixRules: _smsCurrentPrefixRules.filter(r => r.prefix !== '' || r.provider).map(r => ({ prefix: (r.prefix || '').trim(), provider: r.provider })),
    wesender: {
      defaultCEspeciais: document.getElementById('smsWeCEspeciais').checked,
    },
    twilio: {
      accountSid: document.getElementById('smsTwSid').value.trim(),
      fromNumber: document.getElementById('smsTwFrom').value.trim(),
    },
  };
  const weKey = document.getElementById('smsWeApiKey').value;
  if (weKey) body.wesender.apiKey = weKey;
  const twToken = document.getElementById('smsTwToken').value;
  if (twToken) body.twilio.authToken = twToken;
  return body;
}

async function saveSmsConfig() {
  const body = _readSmsForm();
  if (body.routing === 'failover' && body.primary === body.secondary) {
    setSmsStatus('smsStatus', 'Fallback provider must differ from primary.', 'err');
    return;
  }
  if (body.routing === 'by-prefix' && (!body.prefixRules || body.prefixRules.length === 0)) {
    setSmsStatus('smsStatus', 'Add at least one prefix rule (or switch routing mode).', 'err');
    return;
  }
  setSmsStatus('smsStatus', 'Saving…', 'info');
  try {
    const res = await api('/admin/sms', { method: 'PUT', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setSmsStatus('smsStatus', data.error || 'Failed to save.', 'err'); return; }
    toast('SMS configuration saved');
    await fetchSmsConfig();
  } catch (e) {
    setSmsStatus('smsStatus', 'Network error: ' + e.message, 'err');
  }
}

async function clearSmsConfig() {
  if (!(await showConfirm({ title: 'Remover configuração SMS', message: 'Remover toda a configuração SMS?', confirmText: 'Remover' }))) return;
  try {
    const res = await api('/admin/sms', { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return setSmsStatus('smsStatus', d.error || 'Error', 'err'); }
    toast('SMS configuration removed');
    await fetchSmsConfig();
  } catch (e) {
    setSmsStatus('smsStatus', 'Network error: ' + e.message, 'err');
  }
}

function openSmsSendTestModal() {
  document.getElementById('smsTestTo').value = '';
  document.getElementById('smsTestProvider').value = '';
  setSmsStatus('smsTestStatus', '', 'info');
  document.getElementById('smsSendTestModal').style.display = 'flex';
}
function closeSmsSendTestModal() {
  document.getElementById('smsSendTestModal').style.display = 'none';
}

async function sendSmsTestUi() {
  const to = document.getElementById('smsTestTo').value.trim();
  const provider = document.getElementById('smsTestProvider').value;
  if (!to) { setSmsStatus('smsTestStatus', 'Enter a phone number.', 'err'); return; }
  setSmsStatus('smsTestStatus', 'Sending…', 'info');
  const btn = document.getElementById('smsTestSendBtn');
  btn.disabled = true;
  try {
    const payload = { to };
    if (provider) payload.provider = provider;
    const res = await api('/admin/sms/send-test', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.ok) {
      const used = data.providerUsed ? ' via ' + data.providerUsed : '';
      setSmsStatus('smsTestStatus', 'Sent' + used + ' ✔', 'ok');
    } else {
      const attempts = Array.isArray(data.attempts) && data.attempts.length
        ? ' — attempts: ' + data.attempts.map(a => a.provider + (a.ok ? ' OK' : ' FAIL: ' + (a.error || ''))).join(' | ')
        : '';
      setSmsStatus('smsTestStatus', 'Failed: ' + (data.error || 'unknown error') + attempts, 'err');
    }
  } catch (e) {
    setSmsStatus('smsTestStatus', 'Network error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ─── Notifications (groups + rules) ──────────────────────────────────────────

let _notifGroups = [];
let _notifRules = [];
let _notifEditingGroupId = null;
let _notifEditingRuleId = null;
let _notifAddingMemberGroupId = null;
let _notifCurrentTab = 'groups';

function switchNotifTab(tab) {
  _notifCurrentTab = tab;
  document.querySelectorAll('.notif-tab').forEach(b => {
    const active = b.getAttribute('data-tab') === tab;
    b.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    b.style.color = active ? 'var(--text)' : 'var(--text2)';
    b.style.fontWeight = active ? '500' : '400';
  });
  document.querySelectorAll('.notif-tabpane').forEach(p => {
    p.style.display = p.getAttribute('data-tab') === tab ? '' : 'none';
  });
}

function _setNotifStatus(elId, msg, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!msg) { el.textContent = ''; el.style.color = ''; return; }
  const c = { ok: 'var(--ok-text)', err: 'var(--err-text)', info: 'var(--text2)' };
  el.style.color = c[kind] || c.info;
  el.textContent = msg;
}

async function fetchNotifGroups() {
  try {
    const res = await api('/admin/notification-groups');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _notifGroups = data.groups || [];
    renderNotifGroups();
    const badge = document.getElementById('navNotifBadge');
    if (badge) {
      const n = _notifGroups.length;
      if (n > 0) { badge.style.display = ''; badge.textContent = String(n); badge.title = n === 1 ? '1 notification group' : n + ' notification groups'; }
      else badge.style.display = 'none';
    }
  } catch (e) {
    const list = document.getElementById('notifGroupsList');
    if (list) list.innerHTML = '<div class="card" style="padding:24px;text-align:center;color:var(--err-text)">Error loading groups: ' + esc(e.message) + '</div>';
  }
}

function renderNotifGroups() {
  const empty = document.getElementById('notifGroupsEmpty');
  const list = document.getElementById('notifGroupsList');
  if (!list) return;
  if (_notifGroups.length === 0) {
    empty.style.display = '';
    list.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = _notifGroups.map(g => {
    const memberRows = g.members.map(m => {
      const linkedBadge = m.proxyUserId
        ? '<span style="font-size:10.5px;padding:2px 6px;border-radius:8px;background:var(--surface2);color:var(--text2);margin-right:6px" title="System user">USER</span>'
        : '<span style="font-size:10.5px;padding:2px 6px;border-radius:8px;background:var(--surface2);color:var(--text3);margin-right:6px" title="External recipient">EXT</span>';
      const stale = m.stale ? '<span style="font-size:10.5px;padding:2px 6px;border-radius:8px;background:rgba(234,179,8,0.18);color:#ca8a04;margin-right:6px">stale</span>' : '';
      const name = m.effectiveDisplayName || m.proxyUsername || '<span style="color:var(--text3)">(no name)</span>';
      const nameHtml = (typeof name === 'string' && name.startsWith('<')) ? name : esc(name);
      const subtitle = m.proxyUsername && m.effectiveDisplayName && m.proxyUsername !== m.effectiveDisplayName
        ? '<div style="font-size:11px;color:var(--text3);margin-top:2px">@' + esc(m.proxyUsername) + '</div>'
        : '';
      const emailLine = m.effectiveEmail ? '<div style="color:var(--text2)">' + esc(m.effectiveEmail) + '</div>' : '';
      const phoneLine = m.effectivePhone ? '<div style="color:var(--text2);font-family:ui-monospace,Menlo,monospace;font-size:12px">' + esc(m.effectivePhone) + '</div>' : '';
      const channels = (emailLine || phoneLine) ? (emailLine + phoneLine) : '<span style="color:var(--text3)">no contact</span>';
      return '<tr><td style="padding:8px 12px;border-top:1px solid var(--border)">' + linkedBadge + stale + nameHtml + subtitle + '</td>'
        + '<td style="padding:8px 12px;border-top:1px solid var(--border);font-size:12.5px">' + channels + '</td>'
        + '<td style="padding:8px 12px;border-top:1px solid var(--border);text-align:right">'
        + '<button class="btn btn-sm" onclick="removeNotifMember(' + g.id + ',' + m.id + ')" style="color:var(--err-text);font-size:11.5px">Remove</button>'
        + '</td></tr>';
    }).join('');
    const staleNote = g.staleCount > 0
      ? '<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:rgba(234,179,8,0.18);color:#ca8a04">' + g.staleCount + ' stale</span>'
      : '';
    const empty = g.members.length === 0
      ? '<tr><td colspan="3" style="padding:18px;text-align:center;color:var(--text3);font-size:12.5px">No recipients yet.</td></tr>'
      : '';
    return '<div class="card">'
      + '<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">'
        + '<div style="min-width:0">'
          + '<h3 style="margin:0;font-size:14.5px">' + esc(g.name) + '</h3>'
          + (g.description ? '<p style="margin:2px 0 0;font-size:11.5px;color:var(--text3)">' + esc(g.description) + '</p>' : '')
        + '</div>'
        + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
          + staleNote
          + '<span style="font-size:11px;color:var(--text3)">' + g.resolved.length + ' reachable</span>'
          + '<button class="btn btn-sm" onclick="openNotifMemberModal(' + g.id + ')">+ Recipient</button>'
          + '<button class="btn btn-sm" onclick="testNotifGroup(' + g.id + ')">Send test</button>'
          + '<button class="btn btn-sm" onclick="editNotifGroup(' + g.id + ')">Edit</button>'
          + '<button class="btn btn-sm" onclick="deleteNotifGroup(' + g.id + ')" style="color:var(--err-text)">Delete</button>'
        + '</div>'
      + '</div>'
      + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">'
      + '<tbody>' + memberRows + empty + '</tbody></table></div>'
    + '</div>';
  }).join('');
}

async function fetchNotifRules() {
  try {
    const res = await api('/admin/notification-rules');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _notifRules = data.rules || [];
    renderNotifRules();
  } catch (e) {
    const body = document.getElementById('notifRulesBody');
    if (body) body.innerHTML = '<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--err-text)">Error: ' + esc(e.message) + '</td></tr>';
  }
}

function _channelsLabel(rule) {
  if (!rule.channelsOverride) {
    return '<span style="font-size:11px;color:var(--text3)" title="info/warning → email; critical → email + SMS">by severity</span>';
  }
  return rule.channelsOverride.map(c => '<span style="font-size:10.5px;padding:2px 6px;border-radius:8px;background:var(--surface2);color:var(--text2);margin-right:4px">' + c + '</span>').join('');
}

function _severityPillHtml(sev) {
  const palette = {
    info:     'background:var(--surface2);color:var(--text2)',
    warning:  'background:rgba(234,179,8,0.18);color:#ca8a04',
    critical: 'background:rgba(239,68,68,0.15);color:var(--err-text)',
  };
  return '<span style="font-size:10.5px;padding:3px 8px;border-radius:8px;font-weight:500;letter-spacing:.3px;' + (palette[sev] || palette.info) + '">' + sev + '</span>';
}

function renderNotifRules() {
  const empty = document.getElementById('notifRulesEmpty');
  const card = document.getElementById('notifRulesCard');
  const body = document.getElementById('notifRulesBody');
  if (!body) return;
  if (_notifRules.length === 0) {
    empty.style.display = '';
    card.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  card.style.display = '';
  body.innerHTML = _notifRules.map(r => {
    const group = _notifGroups.find(g => g.id === r.groupId);
    const groupLabel = group ? esc(group.name) : '<span style="color:var(--err-text)">missing</span>';
    return '<tr>'
      + '<td style="padding:10px 14px;border-top:1px solid var(--border);font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--text2)">' + r.priority + '</td>'
      + '<td style="padding:10px 14px;border-top:1px solid var(--border);font-family:ui-monospace,Menlo,monospace;font-size:12.5px">' + esc(r.categoryPattern) + (r.name ? '<div style="font-family:inherit;font-size:11px;color:var(--text3);margin-top:2px">' + esc(r.name) + '</div>' : '') + '</td>'
      + '<td style="padding:10px 14px;border-top:1px solid var(--border)">' + _severityPillHtml(r.minSeverity) + '</td>'
      + '<td style="padding:10px 14px;border-top:1px solid var(--border)">' + groupLabel + '</td>'
      + '<td style="padding:10px 14px;border-top:1px solid var(--border)">' + _channelsLabel(r) + '</td>'
      + '<td style="padding:10px 14px;border-top:1px solid var(--border)">' + (r.enabled
          ? '<span style="font-size:10.5px;padding:3px 8px;border-radius:8px;background:rgba(34,197,94,0.15);color:var(--ok-text)">enabled</span>'
          : '<span style="font-size:10.5px;padding:3px 8px;border-radius:8px;background:var(--surface2);color:var(--text3)">disabled</span>') + '</td>'
      + '<td style="padding:10px 14px;border-top:1px solid var(--border);text-align:right">'
        + '<button class="btn btn-sm" onclick="editNotifRule(' + r.id + ')">Edit</button> '
        + '<button class="btn btn-sm" onclick="deleteNotifRule(' + r.id + ')" style="color:var(--err-text)">Delete</button>'
      + '</td></tr>';
  }).join('');
}

// ── Group modal ──────────────────────────────────────────────────────────────

function openNotifGroupModal() {
  _notifEditingGroupId = null;
  document.getElementById('notifGroupModalTitle').textContent = 'New group';
  document.getElementById('notifGroupName').value = '';
  document.getElementById('notifGroupDesc').value = '';
  _setNotifStatus('notifGroupStatus', '', 'info');
  document.getElementById('notifGroupModal').style.display = 'flex';
}
function editNotifGroup(id) {
  const g = _notifGroups.find(x => x.id === id);
  if (!g) return;
  _notifEditingGroupId = id;
  document.getElementById('notifGroupModalTitle').textContent = 'Edit group';
  document.getElementById('notifGroupName').value = g.name;
  document.getElementById('notifGroupDesc').value = g.description || '';
  _setNotifStatus('notifGroupStatus', '', 'info');
  document.getElementById('notifGroupModal').style.display = 'flex';
}
function closeNotifGroupModal() { document.getElementById('notifGroupModal').style.display = 'none'; }

async function saveNotifGroup() {
  const name = document.getElementById('notifGroupName').value.trim();
  const description = document.getElementById('notifGroupDesc').value.trim();
  if (!name) { _setNotifStatus('notifGroupStatus', 'Name is required.', 'err'); return; }
  const btn = document.getElementById('notifGroupSaveBtn');
  btn.disabled = true;
  try {
    const url = _notifEditingGroupId ? '/admin/notification-groups/' + _notifEditingGroupId : '/admin/notification-groups';
    const method = _notifEditingGroupId ? 'PUT' : 'POST';
    const res = await api(url, { method, body: JSON.stringify({ name, description }) });
    const data = await res.json();
    if (!res.ok) { _setNotifStatus('notifGroupStatus', data.error || 'Failed.', 'err'); return; }
    toast(_notifEditingGroupId ? 'Group updated' : 'Group created');
    closeNotifGroupModal();
    await fetchNotifGroups();
    await fetchNotifRules();
  } catch (e) {
    _setNotifStatus('notifGroupStatus', 'Network error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function deleteNotifGroup(id) {
  const g = _notifGroups.find(x => x.id === id);
  if (!g) return;
  if (!(await showConfirm({ title: 'Delete group', message: 'Delete "' + g.name + '"? Rules pointing to this group will be removed too.', confirmText: 'Delete' }))) return;
  try {
    const res = await api('/admin/notification-groups/' + id, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast(d.error || 'Failed', 'error'); return; }
    toast('Group deleted');
    await fetchNotifGroups();
    await fetchNotifRules();
  } catch (e) { toast('Network error: ' + e.message, 'error'); }
}

async function testNotifGroup(id) {
  try {
    const res = await api('/admin/notification-groups/' + id + '/test', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Test failed', 'error'); return; }
    const total = data.recipientsTotal || 0;
    const ok = data.recipientsOk || 0;
    const failed = data.recipientsFailed || 0;
    if (failed === 0) toast('Test sent to ' + ok + '/' + total + ' channel(s)');
    else toast('Test: ' + ok + ' OK, ' + failed + ' failed (see audit log)', 'error');
  } catch (e) { toast('Network error: ' + e.message, 'error'); }
}

// ── Member modal ─────────────────────────────────────────────────────────────

let _notifMemberAllUsers = [];
let _notifMemberSelectedIds = new Set();
let _notifMemberCurrentTab = 'users';

function switchNotifMemberTab(tab) {
  _notifMemberCurrentTab = tab;
  document.querySelectorAll('.notif-member-tab').forEach(b => {
    const active = b.getAttribute('data-tab') === tab;
    b.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    b.style.color = active ? 'var(--text)' : 'var(--text2)';
    b.style.fontWeight = active ? '500' : '400';
  });
  document.querySelectorAll('.notif-member-tabpane').forEach(p => {
    p.style.display = p.getAttribute('data-tab') === tab ? (tab === 'external' ? 'flex' : 'flex') : 'none';
  });
  const btn = document.getElementById('notifMemberSaveBtn');
  if (btn) btn.textContent = tab === 'users' ? 'Add selected' : 'Add';
}

function _notifMemberAlreadyInGroup(userId) {
  const g = _notifGroups.find(x => x.id === _notifAddingMemberGroupId);
  if (!g) return false;
  return g.members.some(m => m.proxyUserId === userId);
}

function renderNotifMemberUserList() {
  const wrap = document.getElementById('notifMemberUserList');
  if (!wrap) return;
  const q = (document.getElementById('notifMemberFilter').value || '').trim().toLowerCase();
  const clearBtn = document.getElementById('notifMemberFilterClearBtn');
  if (clearBtn) clearBtn.style.display = q ? '' : 'none';

  const matches = _notifMemberAllUsers.filter(u => {
    if (!q) return true;
    return (
      (u.username || '').toLowerCase().includes(q) ||
      (u.fullName || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.phoneNumber || '').toLowerCase().includes(q)
    );
  });

  if (matches.length === 0) {
    wrap.innerHTML = '<div style="padding:36px;text-align:center;color:var(--text3);font-size:12.5px">' + (q ? 'No users match the filter.' : 'No system users available.') + '</div>';
    _updateNotifMemberSelectedCount();
    return;
  }

  wrap.innerHTML = matches.map(u => {
    const inGroup = _notifMemberAlreadyInGroup(u.id);
    const selected = _notifMemberSelectedIds.has(u.id);
    const contactParts = [];
    if (u.email) contactParts.push('<span>' + esc(u.email) + '</span>');
    if (u.phoneNumber) contactParts.push('<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">' + esc(u.phoneNumber) + '</span>');
    if (contactParts.length === 0) contactParts.push('<span style="color:var(--text3)">no contact data</span>');
    const adminBadge = u.isAdmin ? '<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:var(--surface2);color:var(--text2);margin-left:6px">admin</span>' : '';
    const inGroupBadge = inGroup ? '<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(34,197,94,0.15);color:var(--ok-text);margin-left:6px">in group</span>' : '';
    const rowStyle = inGroup
      ? 'opacity:0.5;cursor:not-allowed'
      : 'cursor:pointer';
    const onClick = inGroup ? '' : 'onclick="toggleNotifMemberSelect(' + u.id + ')"';
    return '<div data-uid="' + u.id + '" ' + onClick + ' style="display:flex;align-items:center;gap:12px;padding:10px 22px;border-bottom:1px solid var(--border);' + rowStyle + '">'
      + '<input type="checkbox" ' + (selected ? 'checked' : '') + ' ' + (inGroup ? 'disabled' : '') + ' style="margin:0;flex-shrink:0;pointer-events:none">'
      + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:13px;color:var(--text);font-weight:500">' + esc(u.fullName || u.username) + adminBadge + inGroupBadge + '</div>'
        + '<div style="font-size:12px;color:var(--text2);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap">' + contactParts.join('<span style="color:var(--text3)">·</span>') + '</div>'
      + '</div>'
    + '</div>';
  }).join('');
  _updateNotifMemberSelectedCount();
}

function toggleNotifMemberSelect(userId) {
  if (_notifMemberAlreadyInGroup(userId)) return;
  if (_notifMemberSelectedIds.has(userId)) _notifMemberSelectedIds.delete(userId);
  else _notifMemberSelectedIds.add(userId);
  renderNotifMemberUserList();
}

function toggleNotifMemberSelectAll() {
  const q = (document.getElementById('notifMemberFilter').value || '').trim().toLowerCase();
  const visible = _notifMemberAllUsers.filter(u => {
    if (_notifMemberAlreadyInGroup(u.id)) return false;
    if (!q) return true;
    return (
      (u.username || '').toLowerCase().includes(q) ||
      (u.fullName || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.phoneNumber || '').toLowerCase().includes(q)
    );
  });
  const allSelected = visible.length > 0 && visible.every(u => _notifMemberSelectedIds.has(u.id));
  if (allSelected) visible.forEach(u => _notifMemberSelectedIds.delete(u.id));
  else visible.forEach(u => _notifMemberSelectedIds.add(u.id));
  renderNotifMemberUserList();
}

function _updateNotifMemberSelectedCount() {
  const n = _notifMemberSelectedIds.size;
  const el = document.getElementById('notifMemberSelectedCount');
  if (el) el.textContent = n === 1 ? '1 selected' : n + ' selected';
  const btn = document.getElementById('notifMemberSelectAllBtn');
  if (btn) {
    const q = (document.getElementById('notifMemberFilter').value || '').trim().toLowerCase();
    const visible = _notifMemberAllUsers.filter(u => {
      if (_notifMemberAlreadyInGroup(u.id)) return false;
      if (!q) return true;
      return (
        (u.username || '').toLowerCase().includes(q) ||
        (u.fullName || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.phoneNumber || '').toLowerCase().includes(q)
      );
    });
    const allSelected = visible.length > 0 && visible.every(u => _notifMemberSelectedIds.has(u.id));
    btn.textContent = allSelected ? 'Unselect all' : 'Select all';
    btn.disabled = visible.length === 0;
  }
}

async function openNotifMemberModal(groupId) {
  _notifAddingMemberGroupId = groupId;
  _notifMemberSelectedIds = new Set();
  document.getElementById('notifMemberName').value = '';
  document.getElementById('notifMemberEmail').value = '';
  document.getElementById('notifMemberPhone').value = '';
  document.getElementById('notifMemberFilter').value = '';
  _setNotifStatus('notifMemberStatus', '', 'info');
  switchNotifMemberTab('users');
  // Load users
  _notifMemberAllUsers = [];
  document.getElementById('notifMemberUserList').innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3);font-size:12.5px">Loading users…</div>';
  try {
    const res = await api('/admin/proxy-users');
    if (res.ok) {
      const data = await res.json();
      _notifMemberAllUsers = (data.users || []).slice().sort((a, b) => {
        const an = (a.fullName || a.username || '').toLowerCase();
        const bn = (b.fullName || b.username || '').toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    }
  } catch {}
  renderNotifMemberUserList();
  document.getElementById('notifMemberModal').style.display = 'flex';
}
function closeNotifMemberModal() { document.getElementById('notifMemberModal').style.display = 'none'; }

async function saveNotifMember() {
  if (!_notifAddingMemberGroupId) return;
  const btn = document.getElementById('notifMemberSaveBtn');
  btn.disabled = true;
  try {
    if (_notifMemberCurrentTab === 'users') {
      const ids = Array.from(_notifMemberSelectedIds);
      if (ids.length === 0) {
        _setNotifStatus('notifMemberStatus', 'Select at least one user.', 'err');
        return;
      }
      _setNotifStatus('notifMemberStatus', 'Adding ' + ids.length + ' recipient(s)…', 'info');
      let ok = 0; let failed = 0;
      for (const id of ids) {
        try {
          const r = await api('/admin/notification-groups/' + _notifAddingMemberGroupId + '/members', {
            method: 'POST',
            body: JSON.stringify({ proxyUserId: id }),
          });
          if (r.ok) ok++; else failed++;
        } catch { failed++; }
      }
      if (failed === 0) toast(ok + ' recipient(s) added');
      else toast(ok + ' added, ' + failed + ' failed', 'error');
      closeNotifMemberModal();
      await fetchNotifGroups();
      return;
    }
    // External tab
    const displayName = document.getElementById('notifMemberName').value.trim();
    const email = document.getElementById('notifMemberEmail').value.trim();
    const phone = document.getElementById('notifMemberPhone').value.trim();
    if (!email && !phone) {
      _setNotifStatus('notifMemberStatus', 'Enter at least an email or phone.', 'err');
      return;
    }
    const body = { displayName };
    if (email) body.email = email;
    if (phone) body.phone = phone;
    const res = await api('/admin/notification-groups/' + _notifAddingMemberGroupId + '/members', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { _setNotifStatus('notifMemberStatus', data.error || 'Failed.', 'err'); return; }
    toast('Recipient added');
    closeNotifMemberModal();
    await fetchNotifGroups();
  } catch (e) {
    _setNotifStatus('notifMemberStatus', 'Network error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function removeNotifMember(groupId, memberId) {
  if (!(await showConfirm({ title: 'Remove recipient', message: 'Remove this recipient from the group?', confirmText: 'Remove' }))) return;
  try {
    const res = await api('/admin/notification-groups/' + groupId + '/members/' + memberId, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast(d.error || 'Failed', 'error'); return; }
    toast('Recipient removed');
    await fetchNotifGroups();
  } catch (e) { toast('Network error: ' + e.message, 'error'); }
}

// ── Rule modal ───────────────────────────────────────────────────────────────

function _populateNotifRuleGroupSelect() {
  const sel = document.getElementById('notifRuleGroup');
  if (!sel) return;
  sel.innerHTML = _notifGroups.length === 0
    ? '<option value="">— No groups defined yet —</option>'
    : _notifGroups.map(g => '<option value="' + g.id + '">' + esc(g.name) + '</option>').join('');
}

function openNotifRuleModal() {
  _notifEditingRuleId = null;
  document.getElementById('notifRuleModalTitle').textContent = 'New rule';
  document.getElementById('notifRuleName').value = '';
  document.getElementById('notifRuleCategory').value = '*';
  document.getElementById('notifRuleSeverity').value = 'info';
  document.getElementById('notifRulePriority').value = '100';
  document.getElementById('notifRuleEnabled').checked = true;
  document.querySelector('input[name="notifRuleChannelMode"][value="default"]').checked = true;
  _populateNotifRuleGroupSelect();
  _setNotifStatus('notifRuleStatus', '', 'info');
  document.getElementById('notifRuleModal').style.display = 'flex';
}
function editNotifRule(id) {
  const r = _notifRules.find(x => x.id === id);
  if (!r) return;
  _notifEditingRuleId = id;
  document.getElementById('notifRuleModalTitle').textContent = 'Edit rule';
  document.getElementById('notifRuleName').value = r.name || '';
  // If the rule's categoryPattern is not in the static options, add it.
  const catSel = document.getElementById('notifRuleCategory');
  if (![...catSel.options].some(o => o.value === r.categoryPattern)) {
    catSel.insertAdjacentHTML('beforeend', '<option value="' + esc(r.categoryPattern) + '">' + esc(r.categoryPattern) + ' (custom)</option>');
  }
  catSel.value = r.categoryPattern;
  document.getElementById('notifRuleSeverity').value = r.minSeverity;
  document.getElementById('notifRulePriority').value = String(r.priority);
  document.getElementById('notifRuleEnabled').checked = !!r.enabled;
  _populateNotifRuleGroupSelect();
  document.getElementById('notifRuleGroup').value = String(r.groupId);
  let mode = 'default';
  if (r.channelsOverride && r.channelsOverride.length) {
    const set = new Set(r.channelsOverride);
    if (set.has('email') && set.has('sms')) mode = 'both';
    else if (set.has('email')) mode = 'email';
    else if (set.has('sms')) mode = 'sms';
  }
  document.querySelector('input[name="notifRuleChannelMode"][value="' + mode + '"]').checked = true;
  _setNotifStatus('notifRuleStatus', '', 'info');
  document.getElementById('notifRuleModal').style.display = 'flex';
}
function closeNotifRuleModal() { document.getElementById('notifRuleModal').style.display = 'none'; }

async function saveNotifRule() {
  const categoryPattern = document.getElementById('notifRuleCategory').value.trim();
  const minSeverity = document.getElementById('notifRuleSeverity').value;
  const groupId = parseInt(document.getElementById('notifRuleGroup').value, 10);
  const priority = parseInt(document.getElementById('notifRulePriority').value, 10);
  const name = document.getElementById('notifRuleName').value.trim();
  const enabled = document.getElementById('notifRuleEnabled').checked;
  const mode = document.querySelector('input[name="notifRuleChannelMode"]:checked').value;
  let channelsOverride = null;
  if (mode === 'email') channelsOverride = ['email'];
  else if (mode === 'sms') channelsOverride = ['sms'];
  else if (mode === 'both') channelsOverride = ['email', 'sms'];
  if (!categoryPattern) { _setNotifStatus('notifRuleStatus', 'Category is required.', 'err'); return; }
  if (!groupId) { _setNotifStatus('notifRuleStatus', 'Pick a group.', 'err'); return; }
  const body = { name, categoryPattern, minSeverity, groupId, priority, enabled, channelsOverride };
  const btn = document.getElementById('notifRuleSaveBtn');
  btn.disabled = true;
  try {
    const url = _notifEditingRuleId ? '/admin/notification-rules/' + _notifEditingRuleId : '/admin/notification-rules';
    const method = _notifEditingRuleId ? 'PUT' : 'POST';
    const res = await api(url, { method, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { _setNotifStatus('notifRuleStatus', data.error || 'Failed.', 'err'); return; }
    toast(_notifEditingRuleId ? 'Rule updated' : 'Rule created');
    closeNotifRuleModal();
    await fetchNotifRules();
  } catch (e) {
    _setNotifStatus('notifRuleStatus', 'Network error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function deleteNotifRule(id) {
  if (!(await showConfirm({ title: 'Delete rule', message: 'Delete this rule?', confirmText: 'Delete' }))) return;
  try {
    const res = await api('/admin/notification-rules/' + id, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast(d.error || 'Failed', 'error'); return; }
    toast('Rule deleted');
    await fetchNotifRules();
  } catch (e) { toast('Network error: ' + e.message, 'error'); }
}
