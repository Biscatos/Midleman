// Monitors: a first-class resource (like proxies/webhooks) that watches
// external things and alerts through the notifications pipeline.
//
//   rabbitmq  — via the management API; alertOn is any combination of:
//               'silence'  → nothing published to the queue for N min (payments)
//               'messages' → anything published to the queue (error/DLQ queues)
//               'health'   → broker aliveness-test on the vhost fails
//   http      — an endpoint: down, unexpected status, or too slow.
//   redis     — connect + AUTH + PING (Bun's native client); down or too slow.
//
// Alerts fire once per episode (plus a re-alert after cooldownMinutes while
// still failing) and a recovery notice when the check turns green again.
// Runtime state is in memory: a restart re-baselines counters and may re-send
// one alert, which is acceptable.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { RedisClient } from 'bun';
import { resolve } from 'path';
import { emitNotificationEvent } from './notifications';

/** Seam for tests: swap the notification sink without SMTP/SMS. */
export const sink = { emit: emitNotificationEvent };
import { assertResolvedHostAllowed } from './ssrf-guard';
import { isWithinBusinessHours, validateWeekly, type DaySchedule } from './business-hours';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MonitorBase {
    name: string;
    enabled: boolean;
    description?: string;
    /** Seconds between checks (10–86400). */
    intervalSeconds: number;
    /** Minutes before the same still-failing monitor alerts again. */
    cooldownMinutes: number;
    /** Only alert inside these hours (Africa/Luanda). Empty = always. */
    weekly?: DaySchedule[];
    /** Allow private/internal IPs as targets (default true — monitors usually watch internal infra). */
    allowPrivate?: boolean;
}

export type RabbitAlert = 'silence' | 'messages' | 'health';

export interface RabbitMqMonitor extends MonitorBase {
    type: 'rabbitmq';
    /** Management API base, e.g. http://10.11.1.200:15672 */
    apiUrl: string;
    vhost?: string;
    queue: string;
    username?: string;
    password?: string;
    alertOn: RabbitAlert[];
    /** For 'silence': minutes without publishes before alerting. */
    silenceMinutes: number;
}

export interface HttpMonitor extends MonitorBase {
    type: 'http';
    url: string;
    method: 'GET' | 'HEAD' | 'POST';
    /** "200", "2xx", "200,204" … default "2xx" */
    expectStatus: string;
    timeoutMs: number;
    /** Alert when the response takes longer than this (0 = ignore). */
    maxLatencyMs: number;
    /** Optional substring the body must contain. */
    bodyContains?: string;
    headers?: Record<string, string>;
}

export interface RedisMonitor extends MonitorBase {
    type: 'redis';
    host: string;
    port: number;
    password?: string;
    db: number;
    tls: boolean;
    /** Alert when PING takes longer than this (0 = ignore). */
    maxLatencyMs: number;
}

export type Monitor = RabbitMqMonitor | HttpMonitor | RedisMonitor;

export interface MonitorStatus {
    state: 'ok' | 'alert' | 'unknown' | 'disabled';
    lastCheckAt: number | null;
    lastError: string | null;
    /** http: last latency; rabbitmq: last publish counter */
    lastValue: number | null;
    /** rabbitmq: when the counter last changed */
    lastActivityAt: number | null;
    /** When the current alert episode started (null = healthy). */
    alertSince: number | null;
    lastAlertAt: number | null;
    /** Last checks, oldest first (max HISTORY_MAX): ok + value (latency, or publish delta for queues). */
    history: { at: number; ok: boolean; value: number | null; error: string | null; ms: number }[];
}
const HISTORY_MAX = 60;

// ─── Persistence ────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const FILE = resolve(DATA_DIR, 'monitors.json');

let monitors: Monitor[] = [];

export function loadMonitors(): Monitor[] {
    try {
        monitors = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf-8')) : [];
        if (!Array.isArray(monitors)) monitors = [];
    } catch (err) {
        console.warn('⚠️  Could not load monitors:', err instanceof Error ? err.message : err);
        monitors = [];
    }
    return monitors;
}

function persist(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(FILE, JSON.stringify(monitors, null, 2), 'utf-8');
    } catch (err) {
        console.warn('⚠️  Could not persist monitors:', err instanceof Error ? err.message : err);
    }
}

export function listMonitors(): Monitor[] { return monitors; }
export function getMonitor(name: string): Monitor | undefined { return monitors.find(m => m.name === name); }

/** Create or replace. Keeps the stored password when the input omits it. */
export function upsertMonitor(m: Monitor): { created: boolean } {
    const idx = monitors.findIndex(x => x.name === m.name);
    if (idx >= 0) {
        const prev = monitors[idx];
        if (m.type !== 'http' && prev.type === m.type && !m.password && prev.password) m.password = prev.password;
        monitors[idx] = m;
    } else {
        monitors.push(m);
    }
    states.delete(m.name); // config changed → fresh baseline
    persist();
    return { created: idx < 0 };
}

export function deleteMonitor(name: string): boolean {
    const idx = monitors.findIndex(x => x.name === name);
    if (idx < 0) return false;
    monitors.splice(idx, 1);
    states.delete(name);
    persist();
    return true;
}

/** Shape safe to send to the dashboard (no password). */
export function publicMonitor(m: Monitor): Record<string, unknown> {
    const o = { ...(m as unknown as Record<string, unknown>) };
    if (m.type === 'rabbitmq' || m.type === 'redis') { delete o.password; o.hasPassword = !!m.password; }
    return { ...o, status: getStatus(m.name) };
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateMonitorInput(input: unknown): { error: string } | { monitor: Monitor } {
    if (!input || typeof input !== 'object') return { error: 'body must be an object' };
    const i = input as Record<string, unknown>;
    const name = typeof i.name === 'string' ? i.name.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return { error: '"name" must be 1–64 chars: letters, digits, . _ -' };
    const num = (k: string, min: number, max: number, def: number): number | string => {
        if (i[k] === undefined || i[k] === '' || i[k] === null) return def;
        const n = Number(i[k]);
        return Number.isFinite(n) && n >= min && n <= max ? n : `"${k}" must be a number between ${min} and ${max}`;
    };
    const intervalSeconds = num('intervalSeconds', 10, 86400, 60);
    if (typeof intervalSeconds === 'string') return { error: intervalSeconds };
    const cooldownMinutes = num('cooldownMinutes', 1, 100000, 60);
    if (typeof cooldownMinutes === 'string') return { error: cooldownMinutes };
    const wk = validateWeekly(i.weekly);
    if ('error' in wk) return { error: '"weekly": ' + wk.error };

    const base: MonitorBase = {
        name,
        enabled: i.enabled !== false,
        description: typeof i.description === 'string' && i.description.trim() ? i.description.trim().slice(0, 200) : undefined,
        intervalSeconds,
        cooldownMinutes,
        weekly: Array.isArray(i.weekly) && i.weekly.length ? i.weekly as DaySchedule[] : undefined,
        allowPrivate: i.allowPrivate !== false,
    };

    if (i.type === 'rabbitmq') {
        if (typeof i.apiUrl !== 'string' || !/^https?:\/\/\S+$/.test(i.apiUrl.trim())) return { error: '"apiUrl" must be an http(s) URL' };
        if (typeof i.queue !== 'string' || !i.queue.trim()) return { error: '"queue" is required' };
        // Accept the legacy single string too.
        const alertOn = (Array.isArray(i.alertOn) ? i.alertOn : [i.alertOn]).filter(Boolean) as RabbitAlert[];
        if (!alertOn.length || alertOn.some(a => a !== 'silence' && a !== 'messages' && a !== 'health')) return { error: '"alertOn" must be a non-empty list of "silence", "messages", "health"' };
        const silenceMinutes = num('silenceMinutes', 1, 100000, 30);
        if (typeof silenceMinutes === 'string') return { error: silenceMinutes };
        for (const k of ['vhost', 'username', 'password']) {
            if (i[k] !== undefined && i[k] !== null && typeof i[k] !== 'string') return { error: `"${k}" must be a string` };
        }
        return { monitor: {
            ...base, type: 'rabbitmq',
            apiUrl: (i.apiUrl as string).trim().replace(/\/$/, ''),
            vhost: (i.vhost as string | undefined)?.trim() || undefined,
            queue: (i.queue as string).trim(),
            username: (i.username as string | undefined)?.trim() || undefined,
            password: (i.password as string | undefined) || undefined,
            alertOn,
            silenceMinutes,
        } };
    }

    if (i.type === 'http') {
        if (typeof i.url !== 'string' || !/^https?:\/\/\S+$/.test(i.url.trim())) return { error: '"url" must be an http(s) URL' };
        const method = i.method === undefined ? 'GET' : i.method;
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return { error: '"method" must be GET, HEAD or POST' };
        const expectStatus = typeof i.expectStatus === 'string' && i.expectStatus.trim() ? i.expectStatus.trim() : '2xx';
        if (!/^(\d{3}|[1-5]xx)(\s*,\s*(\d{3}|[1-5]xx))*$/i.test(expectStatus)) return { error: '"expectStatus" must be like "200", "2xx" or "200,204"' };
        const timeoutMs = num('timeoutMs', 500, 120000, 10000);
        if (typeof timeoutMs === 'string') return { error: timeoutMs };
        const maxLatencyMs = num('maxLatencyMs', 0, 120000, 0);
        if (typeof maxLatencyMs === 'string') return { error: maxLatencyMs };
        let headers: Record<string, string> | undefined;
        if (i.headers !== undefined && i.headers !== null) {
            if (typeof i.headers !== 'object' || Array.isArray(i.headers)) return { error: '"headers" must be an object' };
            headers = {};
            for (const [k, v] of Object.entries(i.headers as Record<string, unknown>)) {
                if (typeof v !== 'string') return { error: `header "${k}" must be a string` };
                headers[k] = v;
            }
            if (!Object.keys(headers).length) headers = undefined;
        }
        return { monitor: {
            ...base, type: 'http',
            url: (i.url as string).trim(), method, expectStatus, timeoutMs, maxLatencyMs,
            bodyContains: typeof i.bodyContains === 'string' && i.bodyContains ? i.bodyContains : undefined,
            headers,
        } };
    }

    if (i.type === 'redis') {
        if (typeof i.host !== 'string' || !i.host.trim()) return { error: '"host" is required' };
        const port = num('port', 1, 65535, 6379);
        if (typeof port === 'string') return { error: port };
        const db = num('db', 0, 15, 0);
        if (typeof db === 'string') return { error: db };
        const maxLatencyMs = num('maxLatencyMs', 0, 120000, 0);
        if (typeof maxLatencyMs === 'string') return { error: maxLatencyMs };
        if (i.password !== undefined && i.password !== null && typeof i.password !== 'string') return { error: '"password" must be a string' };
        return { monitor: {
            ...base, type: 'redis',
            host: (i.host as string).trim(), port, db, maxLatencyMs,
            password: (i.password as string | undefined) || undefined,
            tls: i.tls === true,
        } };
    }

    return { error: '"type" must be "rabbitmq", "http" or "redis"' };
}

// ─── Runtime state & checks ─────────────────────────────────────────────────

interface State extends MonitorStatus { checking: boolean }
const states = new Map<string, State>();

function stateOf(name: string): State {
    let s = states.get(name);
    if (!s) {
        s = { state: 'unknown', lastCheckAt: null, lastError: null, lastValue: null, lastActivityAt: null, alertSince: null, lastAlertAt: null, history: [], checking: false };
        states.set(name, s);
    }
    return s;
}

export function getStatus(name: string): MonitorStatus {
    const m = getMonitor(name);
    const { checking: _c, ...s } = stateOf(name);
    if (m && !m.enabled) return { ...s, state: 'disabled' };
    return s;
}

function statusMatches(expect: string, status: number): boolean {
    return expect.split(',').some(p => {
        p = p.trim().toLowerCase();
        return p.endsWith('xx') ? Math.floor(status / 100) === Number(p[0]) : Number(p) === status;
    });
}

/** Returns a failure reason, or null when healthy. */
async function checkHttp(m: HttpMonitor, s: State): Promise<string | null> {
    await assertResolvedHostAllowed(m.url, { allowPrivate: m.allowPrivate !== false });
    const t0 = Date.now();
    const res = await fetch(m.url, { method: m.method, headers: m.headers, signal: AbortSignal.timeout(m.timeoutMs), redirect: 'manual' });
    const latency = Date.now() - t0;
    s.lastValue = latency;
    if (!statusMatches(m.expectStatus, res.status)) return `HTTP ${res.status} (expected ${m.expectStatus})`;
    if (m.bodyContains) {
        const text = await res.text();
        if (!text.includes(m.bodyContains)) return `body does not contain "${m.bodyContains}"`;
    }
    if (m.maxLatencyMs > 0 && latency > m.maxLatencyMs) return `slow: ${latency} ms (max ${m.maxLatencyMs} ms)`;
    return null;
}

/** Returns a failure reason, or null when PING answers in time. */
async function checkRedis(m: RedisMonitor, s: State): Promise<string | null> {
    // Host policy applies here too (same rules as HTTP targets).
    await assertResolvedHostAllowed(`${m.tls ? 'https' : 'http'}://${m.host}:${m.port}/`, { allowPrivate: m.allowPrivate !== false });
    const auth = m.password ? `:${encodeURIComponent(m.password)}@` : '';
    const url = `${m.tls ? 'rediss' : 'redis'}://${auth}${m.host}:${m.port}/${m.db}`;
    const client = new RedisClient(url, { connectionTimeout: 5000, autoReconnect: false, enableOfflineQueue: false });
    const t0 = Date.now();
    try {
        await client.connect();
        const pong = await client.send('PING', []);
        const latency = Date.now() - t0;
        s.lastValue = latency;
        if (pong !== 'PONG') return `unexpected PING reply: ${String(pong)}`;
        if (m.maxLatencyMs > 0 && latency > m.maxLatencyMs) return `slow: ${latency} ms (max ${m.maxLatencyMs} ms)`;
        return null;
    } finally {
        try { client.close(); } catch {}
    }
}

/** fail = episodic alert reason (health / silence); burst = one-shot reason (messages arrived). */
async function checkRabbit(m: RabbitMqMonitor, s: State): Promise<{ fail: string | null; burst: string | null; delta: number }> {
    const vhost = encodeURIComponent(m.vhost || '/');
    const headers: Record<string, string> = {};
    if (m.username) headers.Authorization = 'Basic ' + Buffer.from(`${m.username}:${m.password || ''}`).toString('base64');
    const get = async (path: string) => {
        const url = `${m.apiUrl}${path}`;
        await assertResolvedHostAllowed(url, { allowPrivate: m.allowPrivate !== false });
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`management API HTTP ${res.status} on ${path}`);
        return res.json() as Promise<any>;
    };
    const fails: string[] = [];
    let burst: string | null = null;
    let delta = 0; // messages published since the previous check (0 on the baseline check)

    if (m.alertOn.includes('health')) {
        const h = await get(`/api/aliveness-test/${vhost}`);
        if (h?.status !== 'ok') fails.push(`broker aliveness-test failed (${JSON.stringify(h)})`);
    }
    if (m.alertOn.includes('silence') || m.alertOn.includes('messages')) {
        const j = await get(`/api/queues/${vhost}/${encodeURIComponent(m.queue)}`);
        // No message_stats = nothing ever published since the broker started.
        const count = Number(j?.message_stats?.publish ?? 0);
        const prev = s.lastValue;
        s.lastValue = count;
        if (prev === null) {
            s.lastActivityAt = Date.now(); // baseline: the clock starts now
        } else {
            delta = count - prev;
            // A decrease means the broker restarted — still activity.
            if (delta !== 0) s.lastActivityAt = Date.now();
            if (m.alertOn.includes('messages') && delta > 0) burst = `${delta} new message(s) in queue "${m.queue}"`;
            if (m.alertOn.includes('silence')) {
                const silentMin = Math.floor((Date.now() - (s.lastActivityAt ?? Date.now())) / 60_000);
                if (silentMin >= m.silenceMinutes) fails.push(`no messages in "${m.queue}" for ${silentMin} min`);
            }
        }
    }
    return { fail: fails.length ? fails.join('; ') : null, burst, delta };
}

async function notify(m: Monitor, kind: 'alert' | 'recovered', detail: string): Promise<void> {
    const target = m.type === 'http' ? `${m.method} ${m.url}` : m.type === 'redis' ? `redis ${m.host}:${m.port}/${m.db}` : `queue ${m.queue} @ ${m.apiUrl}`;
    const category = `monitor.${m.type}.${kind === 'alert' ? 'alert' : 'recovered'}`;
    // Silence on a payments queue is a warning; everything else (down, errors arriving) is critical.
    const severity = kind === 'recovered' ? 'info' : (m.type === 'rabbitmq' && /^no messages/.test(detail) ? 'warning' : 'critical');
    const subject = kind === 'alert' ? `Monitor alert — ${m.name}` : `Monitor recovered — ${m.name}`;
    const body = [
        `Monitor "${m.name}" (${m.type}) ${kind === 'alert' ? 'is alerting' : 'recovered'}.`,
        ``,
        `Target: ${target}`,
        `Detail: ${detail}`,
        `Time:   ${new Date().toISOString()}`,
        ...(m.description ? [``, m.description] : []),
    ].join('\n');
    try {
        await sink.emit({ category, severity, subject, body, payload: { monitor: m.name, type: m.type, kind, detail } });
    } catch (e) {
        console.warn(`📧 [monitor] notification pipeline error for ${m.name}:`, e);
    }
}

export interface PeekedMessage { payload: string; bytes: number; redelivered: boolean; routingKey: string; exchange: string; timestamp: number | null; headers: Record<string, unknown> | null; truncated: boolean }

/** Read up to `count` messages from the watched queue WITHOUT consuming them
 *  (management API `get` with ack_requeue_true). RabbitMQ marks them redelivered. */
export async function peekQueue(m: RabbitMqMonitor, count = 10): Promise<PeekedMessage[]> {
    const url = `${m.apiUrl}/api/queues/${encodeURIComponent(m.vhost || '/')}/${encodeURIComponent(m.queue)}/get`;
    await assertResolvedHostAllowed(url, { allowPrivate: m.allowPrivate !== false });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (m.username) headers.Authorization = 'Basic ' + Buffer.from(`${m.username}:${m.password || ''}`).toString('base64');
    const res = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ count: Math.max(1, Math.min(50, count)), ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 20_000 }) });
    if (!res.ok) throw new Error(`management API HTTP ${res.status}`);
    const arr = (await res.json()) as any[];
    return arr.map(x => ({
        payload: typeof x.payload === 'string' ? x.payload : JSON.stringify(x.payload),
        bytes: Number(x.payload_bytes ?? 0),
        redelivered: !!x.redelivered,
        routingKey: String(x.routing_key ?? ''),
        exchange: String(x.exchange ?? ''),
        timestamp: typeof x.properties?.timestamp === 'number' ? x.properties.timestamp * 1000 : null,
        headers: x.properties?.headers && typeof x.properties.headers === 'object' ? x.properties.headers : null,
        truncated: x.payload_encoding === 'base64' || (Number(x.payload_bytes ?? 0) > 20_000),
    }));
}

export interface QueueInfo { name: string; vhost: string; messages: number; consumers: number; state: string }

/** Queues visible to the given credentials (management API /api/queues[/vhost]). */
export async function listRabbitQueues(apiUrl: string, vhost: string | undefined, username: string | undefined, password: string | undefined, allowPrivate = true): Promise<QueueInfo[]> {
    const base = apiUrl.trim().replace(/\/$/, '');
    const url = `${base}/api/queues${vhost ? '/' + encodeURIComponent(vhost) : ''}?columns=name,vhost,messages,consumers,state`;
    await assertResolvedHostAllowed(url, { allowPrivate });
    const headers: Record<string, string> = {};
    if (username) headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`management API HTTP ${res.status}`);
    const arr = (await res.json()) as any[];
    return arr.map(q => ({ name: String(q.name), vhost: String(q.vhost ?? '/'), messages: Number(q.messages ?? 0), consumers: Number(q.consumers ?? 0), state: String(q.state ?? '') }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function runCheck(m: Monitor): Promise<MonitorStatus> {
    const s = stateOf(m.name);
    if (s.checking) return getStatus(m.name);
    s.checking = true;
    try {
        const t0 = Date.now();
        let fail: string | null;        // episodic: alert once, recovery notice when it clears
        let burst: string | null = null; // one-shot: messages arrived (cooldown between alerts)
        let delta = 0;                   // rabbitmq: publishes since the previous check (what the chart plots)
        try {
            if (m.type === 'http') fail = await checkHttp(m, s);
            else if (m.type === 'redis') fail = await checkRedis(m, s);
            else ({ fail, burst, delta } = await checkRabbit(m, s));
        } catch (e: any) {
            // Unreachable target is itself the failure.
            fail = e?.message || String(e);
        }
        const now = Date.now();
        s.lastCheckAt = now;
        s.lastError = fail || burst;
        s.history.push({ at: now, ok: !fail && !burst, value: m.type === 'rabbitmq' ? Math.max(0, delta) : s.lastValue, error: fail || burst || null, ms: Date.now() - t0 });
        if (s.history.length > HISTORY_MAX) s.history.splice(0, s.history.length - HISTORY_MAX);
        const inHours = !m.weekly?.length || isWithinBusinessHours(m.weekly, undefined, new Date());
        const cooldownMs = m.cooldownMinutes * 60_000;
        const canAlert = () => inHours && (s.lastAlertAt === null || now - s.lastAlertAt >= cooldownMs);

        if (burst && canAlert()) { s.lastAlertAt = now; await notify(m, 'alert', burst); }

        if (fail) {
            s.state = 'alert';
            if (s.alertSince === null) s.alertSince = now;
            if (canAlert()) { s.lastAlertAt = now; await notify(m, 'alert', fail); }
        } else {
            s.state = burst ? 'alert' : 'ok';
            if (s.alertSince !== null) {
                const downMin = Math.round((now - s.alertSince) / 60_000);
                await notify(m, 'recovered', `healthy again after ~${downMin} min`);
                s.alertSince = null;
                if (!burst) s.lastAlertAt = null;
            }
        }
    } finally {
        s.checking = false;
    }
    return getStatus(m.name);
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
    const now = Date.now();
    for (const m of monitors) {
        if (!m.enabled) continue;
        const s = stateOf(m.name);
        if (s.lastCheckAt !== null && now - s.lastCheckAt < m.intervalSeconds * 1000) continue;
        void runCheck(m).catch(e => console.warn(`[monitor] ${m.name} check error:`, e));
    }
}

export function startMonitorScheduler(): void {
    if (timer) return;
    loadMonitors();
    timer = setInterval(() => { void tick(); }, 10_000);
    void tick();
    console.log(`📡 [monitors] Scheduler started (${monitors.length} monitor(s))`);
}

export function stopMonitorScheduler(): void {
    if (timer) { clearInterval(timer); timer = null; }
    states.clear();
}
