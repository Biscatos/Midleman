// ─── Chart Rendering ──────────────────────────────────────────────────────────

function getThemeColors() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  return {
    accent: '#0078d4',
    accentFade: isDark ? 'rgba(0, 120, 212, 0.10)' : 'rgba(0, 120, 212, 0.06)',
    red: isDark ? '#e17055' : '#d35400',
    green: isDark ? '#00b894' : '#00a17d',
    blue: isDark ? '#74b9ff' : '#2e86de',
    orange: isDark ? '#fdcb6e' : '#c8980a',
    grid: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
    label: isDark ? '#5d6180' : '#9096a9',
    text: isDark ? '#8b8fa7' : '#6b7185',
  };
}

function drawTimelineChart(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width - 32; // account for chart-body padding
  const h = 160;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const colors = getThemeColors();
  const padLeft = 36;
  const padRight = 8;
  const padTop = 8;
  const padBot = 24;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBot;

  if (!data || data.length === 0) {
    ctx.fillStyle = colors.label;
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No traffic data yet', w / 2, h / 2);
    canvas._chartMeta = null;
    return;
  }

  const maxVal = Math.max(...data.map(d => d.count), 1);
  const barW = Math.max(2, (plotW / data.length) - 2);

  // Y-axis grid lines
  const ySteps = 4;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '10px JetBrains Mono, monospace';
  for (let i = 0; i <= ySteps; i++) {
    const y = padTop + (plotH / ySteps) * i;
    const val = Math.round(maxVal - (maxVal / ySteps) * i);
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(w - padRight, y);
    ctx.stroke();
    ctx.fillStyle = colors.label;
    ctx.fillText(val.toString(), padLeft - 6, y);
  }

  // Bars
  data.forEach((d, i) => {
    const x = padLeft + (plotW / data.length) * i + 1;
    const barH = (d.count / maxVal) * plotH;
    const y = padTop + plotH - barH;

    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
    ctx.fill();

    if (d.errors > 0) {
      const errH = (d.errors / maxVal) * plotH;
      ctx.fillStyle = colors.red;
      ctx.beginPath();
      ctx.roundRect(x, padTop + plotH - errH, barW, errH, [2, 2, 0, 0]);
      ctx.fill();
    }
  });

  // X-axis labels (show ~6 labels)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillStyle = colors.label;
  const labelStep = Math.max(1, Math.floor(data.length / 6));
  data.forEach((d, i) => {
    if (i % labelStep === 0 || i === data.length - 1) {
      const x = padLeft + (plotW / data.length) * i + barW / 2;
      const hour = d.bucket.substring(11, 16);
      ctx.fillText(hour, x, padTop + plotH + 6);
    }
  });

  // Store layout metadata for tooltip hit-testing
  canvas._chartMeta = { data, padLeft, padRight, padTop, padBot, plotW, plotH, barW, maxVal, w, h };
  setupTimelineTooltip(canvas);
}

function setupTimelineTooltip(canvas) {
  if (canvas._tooltipBound) return;
  canvas._tooltipBound = true;
  const tip = document.getElementById('chartTooltip');

  canvas.addEventListener('mousemove', (e) => {
    const meta = canvas._chartMeta;
    if (!meta) { tip.style.display = 'none'; return; }
    const { data, padLeft, padRight, plotW, padTop, plotH, barW, maxVal, w } = meta;
    const cr = canvas.getBoundingClientRect();
    const mx = e.clientX - cr.left;
    const my = e.clientY - cr.top;

    let found = null;
    data.forEach((d, i) => {
      const x = padLeft + (plotW / data.length) * i + 1;
      const barH = (d.count / maxVal) * plotH;
      const by = padTop + plotH - barH;
      // Expand hit area horizontally to full slot width for easier hover
      const slotW = plotW / data.length;
      const slotX = padLeft + slotW * i;
      if (mx >= slotX && mx < slotX + slotW && my >= padTop && my <= padTop + plotH) {
        found = d;
      }
    });

    if (!found) { tip.style.display = 'none'; return; }

    const label = found.bucket.length >= 16 ? found.bucket.substring(11, 16) : found.bucket;
    const errPct = found.count > 0 ? ((found.errors / found.count) * 100).toFixed(1) : '0.0';
    tip.innerHTML =
      `<div style="font-weight:600;margin-bottom:4px;color:var(--text)">${label}</div>` +
      `<div style="color:var(--text2)">Requests: <span style="color:var(--accent2);font-weight:600">${found.count}</span></div>` +
      (found.errors > 0
        ? `<div style="color:var(--text2)">Errors: <span style="color:var(--red);font-weight:600">${found.errors}</span> <span style="color:var(--text3)">(${errPct}%)</span></div>`
        : `<div style="color:var(--text3)">No errors</div>`);
    tip.style.display = 'block';
    // Position tooltip near cursor, keep inside viewport
    const tipW = 160;
    let tx = e.clientX + 14;
    if (tx + tipW > window.innerWidth - 8) tx = e.clientX - tipW - 14;
    tip.style.left = tx + 'px';
    tip.style.top = (e.clientY - 10) + 'px';
  });

  canvas.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
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

  const methodColors = { GET: colors.green, POST: colors.blue, PUT: colors.orange, PATCH: colors.orange, DELETE: colors.red };

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

  // Key metrics
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">';
  html += '<div style="text-align:center;padding:8px;background:var(--surface2);border-radius:8px">';
  html += '<div style="font-size:16px;font-weight:700;color:var(--text);font-family:JetBrains Mono,monospace">' + (avgDur < 1000 ? avgDur + 'ms' : (avgDur / 1000).toFixed(1) + 's') + '</div>';
  html += '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:2px">Avg latency</div></div>';
  html += '<div style="text-align:center;padding:8px;background:var(--surface2);border-radius:8px">';
  html += '<div style="font-size:16px;font-weight:700;font-family:JetBrains Mono,monospace;color:' + (errRate > 5 ? colors.red : colors.green) + '">' + errRate + '%</div>';
  html += '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:2px">Error rate</div></div>';
  html += '</div>';

  // Methods
  if (methods.length > 0) {
    html += '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;font-weight:500">Methods</div>';
    html += '<div class="bar-list">';
    methods.slice(0, 5).forEach(m => {
      const pct = (m.count / maxMethod) * 100;
      const c = methodColors[m.method] || colors.accent;
      html += '<div class="bar-item">';
      html += '<div class="bar-item-label">' + m.method + '</div>';
      html += '<div class="bar-item-track"><div class="bar-item-fill" style="width:' + pct + '%;background:' + c + '"></div></div>';
      html += '<div class="bar-item-count">' + m.count + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Status codes
  if (statuses.length > 0) {
    html += '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 8px;font-weight:500">Status</div>';
    html += '<div class="bar-list">';
    statuses.forEach(s => {
      const pct = (s.count / maxStatus) * 100;
      const c = statusColor(s.status);
      html += '<div class="bar-item">';
      html += '<div class="bar-item-label" style="font-family:JetBrains Mono,monospace;font-size:12px;color:' + c + '">' + statusLabel(s.status) + '</div>';
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

window.addEventListener('resize', () => {
  if (lastChartData) {
    const canvas = document.getElementById('chartTimeline');
    if (canvas) drawTimelineChart(canvas, lastChartData.timeline);
  }
});
