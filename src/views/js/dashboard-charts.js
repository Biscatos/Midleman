// ─── Chart Rendering ──────────────────────────────────────────────────────────

function getThemeColors() {
  // Read the live theme tokens (theme.css) so charts always match the UI and
  // follow the light/dark switch without a second palette to keep in sync.
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return {
    accent: v('--accent', '#41A5EE'),
    accentFade: v('--accent-bg', 'rgba(65,165,238,0.10)'),
    red: v('--red', '#FF6B6B'),
    green: v('--green', '#5DE3A8'),
    blue: v('--blue', '#7AA7FF'),
    orange: v('--orange', '#F2C14E'),
    grid: v('--border', '#1C2330'),
    label: v('--text3', '#7E889F'),
    text: v('--text2', '#9AA4B8'),
  };
}

// Colour helpers: theme tokens are hex (or rgb()); gradients need alpha.
function _chartRgba(color, alpha) {
  const c = (color || '').trim();
  let r, g, b;
  if (c[0] === '#') {
    const hex = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1, 7);
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  } else {
    const m = c.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (!m) return c;
    [r, g, b] = [m[1], m[2], m[3]].map(Number);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** A round axis maximum (1, 2, 2.5, 5 × 10^n) so the gridlines read cleanly. */
function _chartNiceMax(v) {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Smooth path through the points without overshooting (monotone cubic). */
function _chartSmoothPath(ctx, pts) {
  if (pts.length === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length < 3) { pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); return; }
  const n = pts.length;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1].x - pts[i].x; dy[i] = (pts[i + 1].y - pts[i].y) / dx[i]; }
  m[0] = dy[0]; m[n - 1] = dy[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = dy[i - 1] * dy[i] <= 0 ? 0 : (dy[i - 1] + dy[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (dy[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / dy[i], b = m[i + 1] / dy[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * dy[i]; m[i + 1] = t * b * dy[i]; }
  }
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    ctx.bezierCurveTo(pts[i].x + h, pts[i].y + m[i] * h, pts[i + 1].x - h, pts[i + 1].y - m[i + 1] * h, pts[i + 1].x, pts[i + 1].y);
  }
}

function drawTimelineChart(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.floor(rect.width - 32); // account for chart-body padding
  const h = 240;

  // The overview page may be hidden (display:none) when the poll fires or the
  // theme switches: the parent then reports a zero width, and sizing the
  // canvas against it produced a blank, broken chart. Bail out and let the
  // ResizeObserver (or the next poll) retry once the page is visible again.
  if (w < 60) { canvas._chartPending = true; return; }
  canvas._chartPending = false;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = getThemeColors();
  const padLeft = 40;
  const padRight = 12;
  const padTop = 12;
  const padBot = 24;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBot;

  if (!data || data.length === 0) {
    ctx.fillStyle = colors.label;
    ctx.font = '12px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No traffic data yet', w / 2, h / 2);
    canvas._chartMeta = null;
    canvas._chartBase = null;
    return;
  }

  // Defensive sort: render strictly in chronological order even if the
  // server returns buckets out of order.
  data = data.slice().sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  const maxVal = _chartNiceMax(Math.max(...data.map(d => d.count), 1));
  const slotW = plotW / data.length;
  const xAt = i => padLeft + slotW * i + slotW / 2;
  const yAt = v => padTop + plotH - (v / maxVal) * plotH;
  const baseY = padTop + plotH;

  // Grid: faint dotted horizontals only, labels in mono.
  const ySteps = 4;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= ySteps; i++) {
    const y = Math.round(padTop + (plotH / ySteps) * i) + 0.5;
    const val = maxVal - (maxVal / ySteps) * i;
    ctx.strokeStyle = i === ySteps ? colors.grid : _chartRgba(colors.label, 0.18);
    ctx.setLineDash(i === ySteps ? [] : [2, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(w - padRight, y);
    ctx.stroke();
    ctx.fillStyle = colors.label;
    ctx.fillText(val >= 1000 ? (val / 1000).toFixed(val % 1000 ? 1 : 0) + 'k' : String(Math.round(val * 10) / 10), padLeft - 8, y);
  }
  ctx.setLineDash([]);

  const reqPts = data.map((d, i) => ({ x: xAt(i), y: yAt(d.count) }));
  const errPts = data.map((d, i) => ({ x: xAt(i), y: yAt(d.errors || 0) }));
  const hasErrors = data.some(d => d.errors > 0);

  // Requests: gradient area + crisp line.
  const area = ctx.createLinearGradient(0, padTop, 0, baseY);
  area.addColorStop(0, _chartRgba(colors.accent, 0.30));
  area.addColorStop(0.6, _chartRgba(colors.accent, 0.08));
  area.addColorStop(1, _chartRgba(colors.accent, 0));
  ctx.beginPath();
  _chartSmoothPath(ctx, reqPts);
  ctx.lineTo(reqPts[reqPts.length - 1].x, baseY);
  ctx.lineTo(reqPts[0].x, baseY);
  ctx.closePath();
  ctx.fillStyle = area;
  ctx.fill();

  ctx.beginPath();
  _chartSmoothPath(ctx, reqPts);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Errors: thin dashed line with a faint wash, only when there are any.
  if (hasErrors) {
    const errArea = ctx.createLinearGradient(0, padTop, 0, baseY);
    errArea.addColorStop(0, _chartRgba(colors.orange, 0.16));
    errArea.addColorStop(1, _chartRgba(colors.orange, 0));
    ctx.beginPath();
    _chartSmoothPath(ctx, errPts);
    ctx.lineTo(errPts[errPts.length - 1].x, baseY);
    ctx.lineTo(errPts[0].x, baseY);
    ctx.closePath();
    ctx.fillStyle = errArea;
    ctx.fill();
    ctx.beginPath();
    _chartSmoothPath(ctx, errPts);
    ctx.strokeStyle = colors.orange;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // "Now" marker: the latest bucket gets a ringed point.
  const last = reqPts[reqPts.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = _chartRgba(colors.accent, 0.18);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(last.x, last.y, 2.75, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();

  // X-axis labels: enforce a minimum pixel gap between labels so they never
  // overlap, regardless of bucket count.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillStyle = colors.label;
  const minLabelGap = 52;
  let lastLabelX = -Infinity;
  data.forEach((d, i) => {
    const cx = xAt(i);
    if (cx - lastLabelX < minLabelGap) return;
    if (cx > w - padRight - 16) return; // avoid clipping at right edge
    ctx.fillText(d.bucket.substring(11, 16), cx, baseY + 7);
    lastLabelX = cx;
  });

  // Keep the finished frame so hover can draw the crosshair on top cheaply.
  canvas._chartBase = ctx.getImageData(0, 0, canvas.width, canvas.height);
  canvas._chartMeta = { data, padLeft, padRight, padTop, padBot, plotW, plotH, slotW, maxVal, w, h, dpr, reqPts, errPts, hasErrors, colors };
  setupTimelineTooltip(canvas);
}

function _chartDrawHover(canvas, idx) {
  const meta = canvas._chartMeta;
  if (!meta || !canvas._chartBase) return;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(canvas._chartBase, 0, 0);
  if (idx < 0) return;
  const { reqPts, errPts, hasErrors, padTop, plotH, colors, dpr, data } = meta;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = Math.round(reqPts[idx].x) + 0.5;
  ctx.strokeStyle = _chartRgba(colors.accent, 0.45);
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, padTop);
  ctx.lineTo(x, padTop + plotH);
  ctx.stroke();
  ctx.setLineDash([]);
  const dot = (p, color) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#000'; ctx.fill();
    ctx.lineWidth = 1.75; ctx.strokeStyle = color; ctx.stroke();
  };
  if (hasErrors && data[idx].errors > 0) dot(errPts[idx], colors.orange);
  dot(reqPts[idx], colors.accent);
}

function setupTimelineTooltip(canvas) {
  if (canvas._tooltipBound) return;
  canvas._tooltipBound = true;
  const tip = document.getElementById('chartTooltip');

  canvas.addEventListener('mousemove', (e) => {
    const meta = canvas._chartMeta;
    if (!meta) { tip.style.display = 'none'; return; }
    const { data, padLeft, padTop, plotH, slotW } = meta;
    const cr = canvas.getBoundingClientRect();
    const mx = e.clientX - cr.left;
    const my = e.clientY - cr.top;
    const idx = Math.floor((mx - padLeft) / slotW);
    if (idx < 0 || idx >= data.length || my < padTop - 8 || my > padTop + plotH + 8) {
      tip.style.display = 'none';
      if (canvas._hoverIdx !== -1) { canvas._hoverIdx = -1; _chartDrawHover(canvas, -1); }
      return;
    }
    if (canvas._hoverIdx !== idx) { canvas._hoverIdx = idx; _chartDrawHover(canvas, idx); }
    const found = data[idx];
    const label = found.bucket.length >= 16 ? found.bucket.substring(11, 16) : found.bucket;
    const errPct = found.count > 0 ? ((found.errors / found.count) * 100).toFixed(1) : '0.0';
    tip.innerHTML =
      `<div style="font-family:var(--font-mono);color:var(--text3);margin-bottom:4px">${label}</div>` +
      `<div style="color:var(--text2)">Requests <span style="color:var(--text);font-family:var(--font-mono);margin-left:6px">${found.count}</span></div>` +
      (found.errors > 0
        ? `<div style="color:var(--text2)">Errors <span style="color:var(--orange);font-family:var(--font-mono);margin-left:6px">${found.errors}</span> <span style="color:var(--text3)">(${errPct}%)</span></div>`
        : `<div style="color:var(--text3)">No errors</div>`);
    tip.style.display = 'block';
    const tipW = 160;
    let tx = e.clientX + 14;
    if (tx + tipW > window.innerWidth - 8) tx = e.clientX - tipW - 14;
    tip.style.left = tx + 'px';
    tip.style.top = (e.clientY - 10) + 'px';
  });

  canvas.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    canvas._hoverIdx = -1;
    _chartDrawHover(canvas, -1);
  });
}

function renderBreakdown(container, chartData) {
  const colors = getThemeColors();
  const methods = chartData.methods || [];
  const statuses = chartData.statuses || [];
  const avgDur = chartData.avgDuration || 0;
  const errRate = chartData.errorRate || 0;

  if (methods.length === 0 && statuses.length === 0) {
    container.innerHTML = '<div style="color:var(--text3);font-size:13px;text-align:center;padding:20px">No data yet</div>';
    return;
  }


  function statusLabel(code) {
    const labels = {
      200:'OK', 201:'Created', 202:'Accepted', 204:'No Content',
      301:'Moved', 302:'Found', 304:'Not Modified',
      400:'Bad Request', 401:'Unauthorized', 403:'Forbidden',
      404:'Not Found', 405:'Method Not Allowed', 409:'Conflict',
      422:'Unprocessable', 429:'Too Many Requests',
      500:'Internal Error', 502:'Bad Gateway', 503:'Unavailable', 504:'Timeout'
    };
    return labels[code] ? code + ' ' + labels[code] : String(code);
  }
  function statusColor(code) {
    if (code < 300) return colors.green;
    if (code < 400) return colors.blue;
    if (code < 500) return colors.orange;
    return colors.red;
  }

  const maxMethod = Math.max(...methods.map(m => m.count), 1);
  const maxStatus = Math.max(...statuses.map(s => s.count), 1);

  let html = '';

  // Key metrics — quiet numbers; colour only when something is wrong.
  const latency = avgDur < 1000 ? Math.round(avgDur) + ' ms' : (avgDur / 1000).toFixed(1) + ' s';
  html += '<div class="bd-metrics">';
  html += '<div class="bd-metric"><div class="bd-metric-value">' + latency + '</div><div class="bd-metric-label">Avg latency</div></div>';
  html += '<div class="bd-metric"><div class="bd-metric-value"' + (errRate > 5 ? ' style="color:' + colors.red + '"' : '') + '>' + errRate + '%</div><div class="bd-metric-label">Error rate</div></div>';
  html += '</div>';

  // Methods — one neutral accent; the bar length carries the meaning.
  if (methods.length > 0) {
    html += '<div class="bd-label">Methods</div>';
    html += '<div class="bar-list">';
    methods.slice(0, 5).forEach(m => {
      const pct = (m.count / maxMethod) * 100;
      html += '<div class="bar-item">';
      html += '<div class="bar-item-label">' + m.method + '</div>';
      html += '<div class="bar-item-track"><div class="bar-item-fill" style="width:' + pct + '%;background:var(--accent)"></div></div>';
      html += '<div class="bar-item-count">' + m.count + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Status codes — a small coloured dot per class, text stays neutral.
  if (statuses.length > 0) {
    html += '<div class="bd-label" style="margin-top:14px">Status</div>';
    html += '<div class="bar-list">';
    statuses.forEach(s => {
      const pct = (s.count / maxStatus) * 100;
      const c = statusColor(s.status);
      html += '<div class="bar-item">';
      html += '<div class="bar-item-label bd-status"><span class="bd-dot" style="background:' + c + '"></span>' + statusLabel(s.status) + '</div>';
      html += '<div class="bar-item-track"><div class="bar-item-fill" style="width:' + pct + '%;background:' + c + '"></div></div>';
      html += '<div class="bar-item-count">' + s.count + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  container.innerHTML = html;
}

let lastChartData = null;

async function fetchChartData() {
  try {
    const res = await api('/admin/requests/chart');
    if (!res.ok) return;
    const data = await res.json();
    lastChartData = data;

    const canvas = document.getElementById('chartTimeline');
    if (canvas) drawTimelineChart(canvas, data.timeline);

    const breakdown = document.getElementById('chartBreakdown');
    if (breakdown) renderBreakdown(breakdown, data);

    const label = document.getElementById('chartTrafficLabel');
    if (label) {
      const total = (data.timeline || []).reduce((s, d) => s + d.count, 0);
      label.textContent = total + ' requests \u00b7 last 24h';
    }
  } catch { }
}

function redrawOverviewCharts() {
  const canvas = document.getElementById('chartTimeline');
  if (canvas && lastChartData) drawTimelineChart(canvas, lastChartData.timeline);
}

// Window resize, sidebar collapse (a CSS grid transition — no resize event)
// and hidden→visible page switches all change the chart's width. Observe the
// container instead of guessing which event will fire.
(function () {
  const canvas = document.getElementById('chartTimeline');
  if (!canvas || !canvas.parentElement) return;
  if (typeof ResizeObserver === 'undefined') {
    window.addEventListener('resize', redrawOverviewCharts);
    return;
  }
  let raf = 0;
  const ro = new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; redrawOverviewCharts(); });
  });
  ro.observe(canvas.parentElement);
})();
