// Weekly monitoring report: availability per monitor, incidents, noisiest containers and
// traffic health for the last 7 days, emailed on a schedule (Africa/Luanda wall clock) or on demand.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { listMonitors, getStatus, listIncidents, errorDailyAll, type Monitor } from './monitors';
import { listTrafficResources, getTrafficWindow } from '../telemetry/request-log';
import { sendMail, isSmtpConfigured } from './smtp';
import { wallClockInTz } from './business-hours';

export interface ReportSettings {
    enabled: boolean;
    emails: string[];
    /** 0 = Sunday … 6 = Saturday */
    dayOfWeek: number;
    hour: number;
    lastSentWeek: string | null;
    lastSentAt: number | null;
    lastError: string | null;
}

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const FILE = resolve(DATA_DIR, 'monitor-report.json');
const TZ = 'Africa/Luanda';
let settings: ReportSettings | null = null;

export function getReportSettings(): ReportSettings {
    if (settings) return settings;
    const def: ReportSettings = { enabled: false, emails: [], dayOfWeek: 1, hour: 8, lastSentWeek: null, lastSentAt: null, lastError: null };
    try { settings = existsSync(FILE) ? { ...def, ...JSON.parse(readFileSync(FILE, 'utf-8')) } : def; } catch { settings = def; }
    return settings!;
}
export function saveReportSettings(patch: Partial<ReportSettings>): ReportSettings {
    settings = { ...getReportSettings(), ...patch };
    try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(settings, null, 2), 'utf-8'); }
    catch (e) { console.warn('⚠️  Could not persist report settings:', e instanceof Error ? e.message : e); }
    return settings;
}

const esc = (s: unknown) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
const pct = (n: number) => (Math.round(n * 100) / 100).toFixed(2) + '%';
const dur = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`; };
const fmtDate = (ts: number) => new Date(ts).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const target = (m: Monitor) => m.type === 'http' ? m.url : m.type === 'redis' ? `${m.host}:${m.port}` : m.type === 'server' ? 'docker host' : m.type === 'database' ? `${m.engine} ${m.host}/${m.database}` : m.type === 'traffic' ? `${m.source} ${m.resource}` : m.queue;

export function buildWeeklyReport(now = Date.now()): { subject: string; html: string; text: string } {
    const from = now - 7 * 86_400_000;
    const monitors = listMonitors();
    const incidents = listIncidents({ since: from, limit: 5000 }).filter(i => i.startedAt < now);
    const episodes = incidents.filter(i => i.kind === 'episode'), events = incidents.filter(i => i.kind === 'event');

    // availability = 1 − alert time within the window
    const rows = monitors.map(m => {
        const mine = episodes.filter(i => i.monitor === m.name);
        const down = mine.reduce((a, i) => a + Math.max(0, Math.min(i.endedAt ?? now, now) - Math.max(i.startedAt, from)), 0);
        const st = getStatus(m.name);
        return { m, down, avail: 100 - 100 * down / (now - from), episodes: mine.length, events: events.filter(i => i.monitor === m.name).length, state: st.state };
    }).sort((a, b) => a.avail - b.avail || a.m.name.localeCompare(b.m.name));

    const totalDown = rows.reduce((a, r) => a + r.down, 0);
    const worst = rows.filter(r => r.avail < 100).slice(0, 5);
    const openNow = rows.filter(r => r.state === 'alert').length;

    // noisiest containers (last 7 days)
    const byContainer = new Map<string, number>();
    for (const e of errorDailyAll()) if (now - Date.parse(e.day) <= 8 * 86_400_000) byContainer.set(`${e.monitor} / ${e.container}`, (byContainer.get(`${e.monitor} / ${e.container}`) || 0) + e.count);
    const topErrors = [...byContainer].sort((a, b) => b[1] - a[1]).slice(0, 10);

    // traffic health
    const traffic = listTrafficResources().map(r => ({ ...r, w: getTrafficWindow(r.type as 'webhook' | 'proxy', r.resource, 7 * 1440) })).filter(r => r.w.total > 0)
        .map(r => ({ ...r, errPct: 100 * r.w.errors / r.w.total })).sort((a, b) => b.errPct - a.errPct || b.w.total - a.w.total).slice(0, 15);

    const color = (a: number) => a >= 99.9 ? '#1D9E75' : a >= 99 ? '#B7791F' : '#C9372C';
    const stateChip = (s: string) => `<span style="font:600 10px/1 ui-monospace,monospace;letter-spacing:.4px;color:${s === 'ok' ? '#1D9E75' : s === 'alert' ? '#C9372C' : '#6B7280'}">${s.toUpperCase()}</span>`;
    const th = (t: string, right = false) => `<th style="text-align:${right ? 'right' : 'left'};font:600 11px/1.4 -apple-system,Segoe UI,sans-serif;letter-spacing:.3px;text-transform:uppercase;color:#6B7280;padding:8px 10px;border-bottom:1px solid #E5E7EB">${t}</th>`;
    const td = (t: string, right = false, mono = false) => `<td style="text-align:${right ? 'right' : 'left'};font:${mono ? '400 12px ui-monospace,Menlo,monospace' : '400 13px -apple-system,Segoe UI,sans-serif'};padding:8px 10px;border-bottom:1px solid #F1F3F5;color:#111827;vertical-align:top">${t}</td>`;
    const h2 = (t: string) => `<h2 style="font:600 14px -apple-system,Segoe UI,sans-serif;color:#111827;margin:28px 0 8px">${t}</h2>`;
    const kpi = (l: string, v: string, sub = '') => `<td style="padding:0 18px 0 0"><div style="font:400 11px -apple-system,Segoe UI,sans-serif;color:#6B7280">${l}</div><div style="font:600 22px -apple-system,Segoe UI,sans-serif;color:#111827;margin-top:2px">${v}</div>${sub ? `<div style="font:400 11px -apple-system,Segoe UI,sans-serif;color:#6B7280">${sub}</div>` : ''}</td>`;

    const period = `${new Date(from).toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short' })} – ${new Date(now).toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' })}`;
    const subject = `Midleman weekly report — ${period}: ${openNow ? `${openNow} alerting` : 'all clear'}, ${episodes.length} incident(s)`;

    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F6F7F9"><div style="max-width:760px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;padding:28px 32px">
<div style="font:600 18px -apple-system,Segoe UI,sans-serif;color:#111827">Weekly monitoring report</div>
<div style="font:400 12.5px -apple-system,Segoe UI,sans-serif;color:#6B7280;margin-top:2px">${esc(period)} · ${monitors.length} monitor(s) · times in Africa/Luanda</div>
<table style="border-collapse:collapse;margin-top:22px"><tr>
${kpi('Overall availability', pct(rows.length ? rows.reduce((a, r) => a + r.avail, 0) / rows.length : 100), 'mean of all monitors')}
${kpi('Incidents', String(episodes.length), `${events.length} one-off event(s)`)}
${kpi('Time in alert', totalDown ? dur(totalDown) : '0 min', 'summed over monitors')}
${kpi('Alerting now', String(openNow), openNow ? 'needs attention' : 'all clear')}
</tr></table>

${h2('Availability by monitor')}
<table style="border-collapse:collapse;width:100%"><tr>${th('Monitor')}${th('Target')}${th('Now')}${th('Availability', true)}${th('In alert', true)}${th('Incidents', true)}</tr>
${rows.map(r => `<tr>${td(`<b>${esc(r.m.name)}</b><div style="font:400 11px -apple-system,Segoe UI,sans-serif;color:#6B7280">${esc(r.m.type)}</div>`)}${td(esc(target(r.m)), false, true)}${td(stateChip(r.state))}${td(`<span style="color:${color(r.avail)};font-weight:600">${pct(r.avail)}</span>`, true)}${td(r.down ? dur(r.down) : '—', true)}${td(r.episodes ? `${r.episodes}${r.events ? ` <span style="color:#6B7280">+${r.events} ev.</span>` : ''}` : (r.events ? `<span style="color:#6B7280">${r.events} ev.</span>` : '—'), true)}</tr>`).join('')}
</table>

${h2(`Incidents (${episodes.length})`)}
${episodes.length ? `<table style="border-collapse:collapse;width:100%"><tr>${th('Started')}${th('Monitor')}${th('Duration', true)}${th('What happened')}</tr>
${episodes.slice(0, 40).map(i => `<tr>${td(fmtDate(i.startedAt), false, true)}${td(`<b>${esc(i.monitor)}</b>`)}${td(i.endedAt ? dur(i.endedAt - i.startedAt) : '<span style="color:#C9372C">still open</span>', true)}${td(esc(i.detail.slice(0, 180)))}</tr>`).join('')}
${episodes.length > 40 ? `<tr>${td(`<span style="color:#6B7280">… and ${episodes.length - 40} more</span>`)}<td colspan="3"></td></tr>` : ''}</table>`
  : `<div style="font:400 13px -apple-system,Segoe UI,sans-serif;color:#6B7280">No incident this week.</div>`}

${worst.length ? h2('Needs attention') + `<ul style="margin:0;padding-left:18px;font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#111827">${worst.map(r => `<li><b>${esc(r.m.name)}</b> — ${pct(r.avail)} available, ${dur(r.down)} in alert over ${r.episodes} incident(s)</li>`).join('')}</ul>` : ''}

${topErrors.length ? h2('Noisiest containers (error lines in logs)') + `<table style="border-collapse:collapse;width:100%"><tr>${th('Server / container')}${th('Error lines', true)}</tr>${topErrors.map(([k, n]) => `<tr>${td(esc(k), false, true)}${td(n.toLocaleString(), true)}</tr>`).join('')}</table>` : ''}

${traffic.length ? h2('Traffic (webhooks & proxies)') + `<table style="border-collapse:collapse;width:100%"><tr>${th('Resource')}${th('Requests', true)}${th('Errors', true)}${th('Error rate', true)}${th('Avg', true)}</tr>${traffic.map(r => `<tr>${td(`${esc(r.resource)} <span style="color:#6B7280">${esc(r.type)}</span>`)}${td(r.w.total.toLocaleString(), true)}${td(r.w.errors.toLocaleString(), true)}${td(`<span style="color:${r.errPct > 5 ? '#C9372C' : r.errPct > 1 ? '#B7791F' : '#1D9E75'};font-weight:600">${pct(r.errPct)}</span>`, true)}${td(r.w.avgMs !== null ? r.w.avgMs + ' ms' : '—', true)}</tr>`).join('')}</table>` : ''}

<div style="font:400 11px -apple-system,Segoe UI,sans-serif;color:#9CA3AF;margin-top:28px;border-top:1px solid #E5E7EB;padding-top:12px">Generated by Midleman monitoring. Availability counts time a monitor spent in alert; one-off events (restarts, error bursts, long queries) are listed but do not reduce it.</div>
</div></body></html>`;

    const text = [
        `Midleman weekly report — ${period}`, '',
        `Overall availability: ${pct(rows.length ? rows.reduce((a, r) => a + r.avail, 0) / rows.length : 100)} · incidents: ${episodes.length} · events: ${events.length} · time in alert: ${dur(totalDown)} · alerting now: ${openNow}`, '',
        'Availability by monitor:', ...rows.map(r => `  ${r.m.name.padEnd(28)} ${pct(r.avail).padStart(8)}  ${r.down ? dur(r.down) : '—'}  ${r.episodes} incident(s)`), '',
        episodes.length ? 'Incidents:' : 'No incident this week.', ...episodes.slice(0, 40).map(i => `  ${fmtDate(i.startedAt)}  ${i.monitor}  ${i.endedAt ? dur(i.endedAt - i.startedAt) : 'still open'}  ${i.detail.slice(0, 120)}`),
    ].join('\n');
    return { subject, html, text };
}

export async function sendWeeklyReport(): Promise<{ ok: boolean; sent: number; errors: string[] }> {
    const cfg = getReportSettings();
    if (!cfg.emails.length) return { ok: false, sent: 0, errors: ['no recipients configured'] };
    if (!isSmtpConfigured()) return { ok: false, sent: 0, errors: ['SMTP not configured'] };
    const r = buildWeeklyReport();
    const errors: string[] = []; let sent = 0;
    for (const to of cfg.emails) {
        const res = await sendMail({ to, subject: r.subject, html: r.html, text: r.text });
        if (res.ok) sent++; else errors.push(`${to}: ${res.error || 'failed'}`);
    }
    saveReportSettings({ lastSentAt: Date.now(), lastError: errors.length ? errors.join('; ') : null });
    return { ok: sent > 0 && !errors.length, sent, errors };
}

/** ISO week key, e.g. 2026-W46 (UTC-based, good enough to send once per week). */
function weekKey(d: Date): string {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
}

/** Called by the monitor scheduler every tick: sends when the configured weekday/hour has passed this week. */
export async function reportSchedulerTick(now = new Date()): Promise<void> {
    const cfg = getReportSettings();
    if (!cfg.enabled || !cfg.emails.length) return;
    const { dow, minutes } = wallClockInTz(now, TZ);
    const wk = weekKey(now);
    if (dow !== cfg.dayOfWeek || minutes < cfg.hour * 60 || cfg.lastSentWeek === wk) return;
    saveReportSettings({ lastSentWeek: wk }); // claim the slot first so a slow SMTP never double-sends
    const r = await sendWeeklyReport();
    console.log(`📧 [monitors] Weekly report ${r.ok ? 'sent' : 'failed'} (${r.sent} recipient(s))${r.errors.length ? ': ' + r.errors.join('; ') : ''}`);
}
