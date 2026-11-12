// Monitors: a first-class resource (like proxies/webhooks) that watches
// external things and alerts through the notifications pipeline.
//
//   rabbitmq  — via the management API; alertOn is any combination of:
//               'silence'  → nothing published to the queue for N min (payments)
//               'messages' → anything published to the queue (error/DLQ queues)
//               'health'   → broker aliveness-test on the vhost fails
//   http      — an endpoint: down, unexpected status, or too slow.
//   redis     — connect + AUTH + PING (Bun's native client); down or too slow.
//   server    — a Docker host: a tiny agent on the server (src/agent) POSTs a
//               report every N seconds (outbound only — nothing to expose on the
//               server). Alerts: container down/unhealthy, restart loop, OOM,
//               error lines in container logs, disk/memory full, agent silent.
//
// Alerts fire once per episode (plus a re-alert after cooldownMinutes while
// still failing) and a recovery notice when the check turns green again.
// Runtime state is in memory: a restart re-baselines counters and may re-send
// one alert, which is acceptable.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { RedisClient } from 'bun';
import { resolve } from 'path';
import { emitNotificationEvent } from './notifications';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Seam for tests: swap the notification sink without SMTP/SMS. */
export const sink = { emit: emitNotificationEvent };
import { assertResolvedHostAllowed, ipInCidrs } from './ssrf-guard';
import { getTrafficWindow } from '../telemetry/request-log';
import { tunnelLocalPort } from './agent-tunnel';
import { agentConflict } from './agent-instance';
import { Connection as TdsConnection, Request as TdsRequest } from 'tedious';
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
    /** Reach the target through this Docker-host agent's reverse tunnel (its network, not ours). */
    via?: string;
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
    /** Also watch the dead-letter queue the consumer writes failed messages to
     *  (RabbitMQ convention `<queue>_error`). New messages there always alert. Default true. */
    watchErrorQueue: boolean;
    /** Override the dead-letter queue name; default `<queue>_error`. */
    errorQueue?: string;
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
    /** Alert when used_memory / maxmemory exceeds this % (0 = ignore; no effect without maxmemory). */
    maxMemoryPct: number;
    /** Alert when connected_clients exceeds this (0 = ignore). */
    maxClients: number;
    /** Replica only: alert when master_last_io_seconds_ago exceeds this (0 = ignore). */
    maxReplicaLagSec: number;
}

/** Readings parsed from INFO on the last successful Redis check. */
export interface RedisInfo {
    version: string; uptimeSec: number; role: string;
    usedMemory: number; maxMemory: number; memoryPct: number | null;
    clients: number; blockedClients: number;
    evictedKeys: number; rejectedConnections: number;
    hits: number; misses: number; hitRatio: number | null;
    rdbStatus: string; aofStatus: string | null; linkStatus: string | null; replicaLagSec: number | null;
}

export interface ServerMonitor extends MonitorBase {
    type: 'server';
    /** sha256 of the Bearer token the agent presents. The token itself is generated here, shown to the admin once and never stored. */
    agentTokenHash: string;
    /** Optional: only accept reports from these source IPs/CIDRs (the cloud server's egress IP). Empty = any. */
    allowedSourceCidrs?: string[];
    /** Burst alert when ≥ this many matching log lines arrive within logWindowMinutes (0 = off). */
    logErrorsPerWindow: number;
    logWindowMinutes: number;
    /** Episodic alerts when any mount / host memory is above these % (0 = off). */
    diskPct: number;
    memPct: number;
    /** Container names never alerted on (e.g. one-shot jobs). */
    ignoreContainers: string[];
    /** When set, only these containers alert (down, restart, OOM, log errors) and one that disappears from the host alerts too; the rest are shown as information. Empty = every container Docker should keep up. */
    criticalContainers: string[];
}

/** What the agent sends (see src/agent/index.ts). */
export interface AgentContainer {
    id: string; name: string; image: string;
    /** docker State.Status: running | exited | paused | restarting | dead | created */
    status: string;
    /** healthy | unhealthy | starting | null (no healthcheck) */
    health: string | null;
    restartCount: number; oomKilled: boolean; exitCode: number | null; startedAt: string | null;
    /** HostConfig.RestartPolicy.Name: no | always | unless-stopped | on-failure. A stopped container only alerts when Docker was supposed to keep it up, or it was running in an earlier report. */
    restartPolicy?: string;
    cpuPct: number | null; memBytes: number | null; memLimit: number | null;
    /** Docker networks it is attached to and its TCP ports (agents before this field send neither). */
    networks?: { name: string; ip: string }[]; ports?: number[];
    /** New matching log lines since the previous report. `warn` lines are kept and shown, never alerted on. */
    errors: { at: number; line: string; warn?: boolean }[];
}
export interface AgentReport {
    agent: string; at: number; intervalSeconds?: number;
    /** Random id of the agent process (agents before this field send none). */
    instance?: string;
    host: { hostname?: string; agentNetworks?: string[]; uptimeSec?: number; load1?: number; memPct: number | null; memTotal?: number; disks: { mount: string; pct: number; total: number; used: number }[] };
    containers: AgentContainer[];
}
/** Report as kept in the status: per-container error lines summarised, full lines live in State.serverErrors. */
export interface ServerSnapshot {
    at: number;
    host: AgentReport['host'];
    containers: (Omit<AgentContainer, 'errors'> & { errorsInWindow: number; warningsInWindow: number; lastError: { at: number; line: string } | null })[];
}

export type DbEngine = 'postgres' | 'mysql' | 'mssql';
export interface DatabaseMonitor extends MonitorBase {
    type: 'database';
    engine: DbEngine;
    host: string;
    port: number;
    database: string;
    username: string;
    password?: string;
    tls: boolean;
    /** Alert when SELECT 1 takes longer than this (0 = ignore). */
    maxLatencyMs: number;
    /** Alert when connections / max_connections exceeds this % (0 = ignore). */
    maxConnectionsPct: number;
    /** One-shot alert when a query has been running longer than this (0 = ignore). */
    maxLongQuerySec: number;
    /** Replica only: alert when replication lag exceeds this (0 = ignore). */
    maxReplicaLagSec: number;
}
export interface DbInfo {
    engine: DbEngine; version: string;
    connections: number; maxConnections: number | null; connectionsPct: number | null;
    longestQuerySec: number; waitingLocks: number;
    replica: boolean; replicaLagSec: number | null;
    sizeBytes: number | null; deadlocks: number | null;
}

export interface TrafficMonitor extends MonitorBase {
    type: 'traffic';
    source: 'webhook' | 'proxy';
    /** Webhook or proxy profile name as it appears in the request log. */
    resource: string;
    /** Sliding window (multiple of 30 min). */
    windowMinutes: number;
    /** Below this many requests in the window the error rate is not judged. */
    minRequests: number;
    /** Alert when (5xx + no response) / total exceeds this % (0 = ignore). */
    maxErrorPct: number;
    /** Alert when the average duration exceeds this (0 = ignore). */
    maxAvgMs: number;
}
export interface TrafficInfo { total: number; errors: number; errorPct: number | null; avgMs: number | null; windowMinutes: number }

/** One alert episode (or one-shot event) — the raw material of the weekly report. */
export interface Incident {
    id: string; monitor: string; type: Monitor['type'];
    kind: 'episode' | 'event';
    startedAt: number; endedAt: number | null;
    detail: string;
}

export type Monitor = RabbitMqMonitor | HttpMonitor | RedisMonitor | ServerMonitor | DatabaseMonitor | TrafficMonitor;

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
    /** rabbitmq with watchErrorQueue: the dead-letter queue and how many messages sit in it (null = not found / not read yet). */
    errorQueue: { name: string; messages: number | null } | null;
    /** rabbitmq: consumers attached to the main queue (peeking it is refused while > 0). */
    consumers: number | null;
    /** redis: last INFO readings. */
    redis: RedisInfo | null;
    /** server: last agent report. */
    server: ServerSnapshot | null;
    /** database: last readings. */
    db: DbInfo | null;
    /** traffic: last window. */
    traffic: TrafficInfo | null;
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
        let migrated = false;
        for (const m of monitors as any[]) if (m.type === 'server' && typeof m.agentToken === 'string') { m.agentTokenHash = m.agentToken ? hashAgentToken(m.agentToken) : ''; delete m.agentToken; migrated = true; }
        if (migrated) persist();
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
        if ((m.type === 'rabbitmq' || m.type === 'redis' || m.type === 'database') && prev.type === m.type && !m.password && prev.password) m.password = prev.password;
        if (m.type === 'server' && prev.type === 'server' && !m.agentTokenHash) m.agentTokenHash = prev.agentTokenHash;
        monitors[idx] = m;
    } else {
        monitors.push(m);
    }
    if (m.type !== 'server') states.delete(m.name); // config changed → fresh baseline (a server keeps its agent report: toggling a critical container must not blank the detail)
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
    if (m.type === 'rabbitmq' || m.type === 'redis' || m.type === 'database') { delete o.password; o.hasPassword = !!m.password; }
    if (m.type === 'server') { delete o.agentTokenHash; o.hasToken = !!m.agentTokenHash; o.agentConflict = agentConflict(m.name); }
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
        via: typeof i.via === 'string' && i.via.trim() ? i.via.trim().toLowerCase() : undefined,
    };
    if (base.via && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(base.via)) return { error: '"via" must be the name of a Server monitor (agent)' };

    if (i.type === 'rabbitmq') {
        if (typeof i.apiUrl !== 'string' || !/^https?:\/\/\S+$/.test(i.apiUrl.trim())) return { error: '"apiUrl" must be an http(s) URL' };
        if (typeof i.queue !== 'string' || !i.queue.trim()) return { error: '"queue" is required' };
        // Accept the legacy single string too.
        const alertOn = (Array.isArray(i.alertOn) ? i.alertOn : [i.alertOn]).filter(Boolean) as RabbitAlert[];
        if (!alertOn.length || alertOn.some(a => a !== 'silence' && a !== 'messages' && a !== 'health')) return { error: '"alertOn" must be a non-empty list of "silence", "messages", "health"' };
        const silenceMinutes = num('silenceMinutes', 1, 100000, 30);
        if (i.errorQueue !== undefined && i.errorQueue !== null && typeof i.errorQueue !== 'string') return { error: '"errorQueue" must be a string' };
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
            watchErrorQueue: i.watchErrorQueue !== false,
            errorQueue: typeof i.errorQueue === 'string' && i.errorQueue.trim() ? i.errorQueue.trim() : undefined,
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
        const maxMemoryPct = num('maxMemoryPct', 0, 100, 85);
        if (typeof maxMemoryPct === 'string') return { error: maxMemoryPct };
        const maxClients = num('maxClients', 0, 1_000_000, 0);
        if (typeof maxClients === 'string') return { error: maxClients };
        const maxReplicaLagSec = num('maxReplicaLagSec', 0, 86400, 60);
        if (typeof maxReplicaLagSec === 'string') return { error: maxReplicaLagSec };
        if (i.password !== undefined && i.password !== null && typeof i.password !== 'string') return { error: '"password" must be a string' };
        return { monitor: {
            ...base, type: 'redis',
            host: (i.host as string).trim(), port, db, maxLatencyMs, maxMemoryPct, maxClients, maxReplicaLagSec,
            password: (i.password as string | undefined) || undefined,
            tls: i.tls === true,
        } };
    }

    if (i.type === 'server') {
        const logErrorsPerWindow = num('logErrorsPerWindow', 0, 100000, 5);
        if (typeof logErrorsPerWindow === 'string') return { error: logErrorsPerWindow };
        const logWindowMinutes = num('logWindowMinutes', 1, 1440, 5);
        if (typeof logWindowMinutes === 'string') return { error: logWindowMinutes };
        const diskPct = num('diskPct', 0, 100, 90);
        if (typeof diskPct === 'string') return { error: diskPct };
        const memPct = num('memPct', 0, 100, 90);
        if (typeof memPct === 'string') return { error: memPct };
        if (i.ignoreContainers !== undefined && !Array.isArray(i.ignoreContainers)) return { error: '"ignoreContainers" must be an array' };
        const cidrs = Array.isArray(i.allowedSourceCidrs) ? (i.allowedSourceCidrs as unknown[]).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : [];
        for (const c of cidrs) if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(c)) return { error: `"allowedSourceCidrs": "${c}" is not an IPv4 address or CIDR` };
        return { monitor: {
            ...base, type: 'server',
            agentTokenHash: '', // set from newAgentToken() on create / rotate, kept from the saved monitor on edit
            allowedSourceCidrs: cidrs.length ? cidrs.slice(0, 20) : undefined,
            logErrorsPerWindow, logWindowMinutes, diskPct, memPct,
            ignoreContainers: ((i.ignoreContainers as unknown[]) || []).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 100),
            criticalContainers: (Array.isArray(i.criticalContainers) ? i.criticalContainers as unknown[] : []).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 200),
        } };
    }

    if (i.type === 'database') {
        const engine = i.engine;
        if (engine !== 'postgres' && engine !== 'mysql' && engine !== 'mssql') return { error: '"engine" must be "postgres", "mysql" or "mssql"' };
        if (typeof i.host !== 'string' || !i.host.trim()) return { error: '"host" is required' };
        const port = num('port', 1, 65535, engine === 'postgres' ? 5432 : engine === 'mysql' ? 3306 : 1433);
        if (typeof port === 'string') return { error: port };
        if (typeof i.database !== 'string' || !i.database.trim()) return { error: '"database" is required' };
        if (typeof i.username !== 'string' || !i.username.trim()) return { error: '"username" is required' };
        if (i.password !== undefined && i.password !== null && typeof i.password !== 'string') return { error: '"password" must be a string' };
        const maxLatencyMs = num('maxLatencyMs', 0, 120000, 0); if (typeof maxLatencyMs === 'string') return { error: maxLatencyMs };
        const maxConnectionsPct = num('maxConnectionsPct', 0, 100, 85); if (typeof maxConnectionsPct === 'string') return { error: maxConnectionsPct };
        const maxLongQuerySec = num('maxLongQuerySec', 0, 86400, 60); if (typeof maxLongQuerySec === 'string') return { error: maxLongQuerySec };
        const maxReplicaLagSec = num('maxReplicaLagSec', 0, 86400, 60); if (typeof maxReplicaLagSec === 'string') return { error: maxReplicaLagSec };
        return { monitor: {
            ...base, type: 'database', engine, host: (i.host as string).trim(), port, database: (i.database as string).trim(), username: (i.username as string).trim(),
            password: (i.password as string | undefined) || undefined, tls: i.tls === true, maxLatencyMs, maxConnectionsPct, maxLongQuerySec, maxReplicaLagSec,
        } };
    }

    if (i.type === 'traffic') {
        if (i.source !== 'webhook' && i.source !== 'proxy') return { error: '"source" must be "webhook" or "proxy"' };
        if (typeof i.resource !== 'string' || !i.resource.trim()) return { error: '"resource" (webhook or proxy name) is required' };
        const windowMinutes = num('windowMinutes', 30, 1440, 30); if (typeof windowMinutes === 'string') return { error: windowMinutes };
        const minRequests = num('minRequests', 1, 1_000_000, 10); if (typeof minRequests === 'string') return { error: minRequests };
        const maxErrorPct = num('maxErrorPct', 0, 100, 5); if (typeof maxErrorPct === 'string') return { error: maxErrorPct };
        const maxAvgMs = num('maxAvgMs', 0, 600000, 0); if (typeof maxAvgMs === 'string') return { error: maxAvgMs };
        return { monitor: { ...base, type: 'traffic', source: i.source, resource: (i.resource as string).trim(), windowMinutes: Math.ceil(windowMinutes / 30) * 30, minRequests, maxErrorPct, maxAvgMs } };
    }

    return { error: '"type" must be "rabbitmq", "http", "redis", "server", "database" or "traffic"' };
}

export function newAgentToken(): string { return 'mma_' + randomBytes(32).toString('base64url'); }
export function hashAgentToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

// ─── Runtime state & checks ─────────────────────────────────────────────────

interface State extends MonitorStatus { checking: boolean; /** dead-letter queue publish counter at the previous check */ errPublished: number | null; /** redis counters at the previous check (restart / eviction / rejection detection) */ redisPrev: { evicted: number; rejected: number; uptime: number } | null; /** server: bursts detected when a report arrived, consumed by the next runCheck */ pendingBursts: string[]; /** server: captured log lines, newest last (max ERRORS_MAX) */ serverErrors: { at: number; container: string; line: string; warn?: boolean }[]; /** server: exception classes already seen per container */ seenErrorKinds: Map<string, Set<string>>; /** server: previous report's restart counters */ serverPrev: Map<string, { restartCount: number; oomKilled: boolean; running: boolean }>; /** database: deadlock counter at the previous check */ dbPrev: { deadlocks: number | null } | null; /** server: error lines per day per container (14 days) — for the weekly report */ errorDaily: Record<string, Record<string, number>>; /** incident open for the current alert episode */ openIncident: string | null }
const ERRORS_MAX = 300;
const states = new Map<string, State>();

function stateOf(name: string): State {
    let s = states.get(name);
    if (!s) {
        s = { state: 'unknown', lastCheckAt: null, lastError: null, lastValue: null, lastActivityAt: null, alertSince: null, lastAlertAt: null, history: [], errorQueue: null, consumers: null, redis: null, server: null, db: null, traffic: null, checking: false, errPublished: null, redisPrev: null, pendingBursts: [], serverErrors: [], seenErrorKinds: new Map(), serverPrev: new Map(), dbPrev: null, errorDaily: {}, openIncident: null };
        states.set(name, s);
    }
    return s;
}

// ─── State persistence & incidents ──────────────────────────────────────────
// Runtime state survives a restart (no blank charts, no duplicate alert, no "new error" for
// exceptions already seen). Written every minute by the scheduler and on shutdown.

const STATE_FILE = resolve(DATA_DIR, 'monitor-state.json');
const INCIDENTS_FILE = resolve(DATA_DIR, 'monitor-incidents.json');
const INCIDENTS_MAX = 5000;
let incidents: Incident[] | null = null;

export function saveStates(): void {
    try {
        const out: Record<string, unknown> = {};
        for (const [name, st] of states) {
            if (!getMonitor(name)) continue;
            const { checking: _c, pendingBursts: _p, seenErrorKinds, serverPrev, ...rest } = st;
            out[name] = { ...rest, seenErrorKinds: Object.fromEntries([...seenErrorKinds].map(([k, v]) => [k, [...v]])), serverPrev: Object.fromEntries(serverPrev) };
        }
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify(out), 'utf-8');
    } catch (e) { console.warn('⚠️  Could not persist monitor state:', e instanceof Error ? e.message : e); }
}
function loadStates(): void {
    try {
        if (!existsSync(STATE_FILE)) return;
        const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Record<string, any>;
        let n = 0;
        for (const [name, v] of Object.entries(raw)) {
            if (!getMonitor(name)) continue;
            const st = stateOf(name);
            Object.assign(st, v, {
                checking: false, pendingBursts: [],
                seenErrorKinds: new Map(Object.entries(v.seenErrorKinds || {}).map(([k, arr]) => [k, new Set(arr as string[])])),
                serverPrev: new Map(Object.entries(v.serverPrev || {})),
                history: Array.isArray(v.history) ? v.history.slice(-HISTORY_MAX) : [],
                errorDaily: v.errorDaily || {},
            });
            n++;
        }
        if (n) console.log(`📡 [monitors] Restored state for ${n} monitor(s)`);
    } catch (e) { console.warn('⚠️  Could not restore monitor state:', e instanceof Error ? e.message : e); }
}

function loadIncidents(): Incident[] {
    if (incidents) return incidents;
    try { incidents = existsSync(INCIDENTS_FILE) ? JSON.parse(readFileSync(INCIDENTS_FILE, 'utf-8')) : []; if (!Array.isArray(incidents)) incidents = []; }
    catch { incidents = []; }
    return incidents!;
}
function persistIncidents(): void {
    try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(INCIDENTS_FILE, JSON.stringify(loadIncidents()), 'utf-8'); }
    catch (e) { console.warn('⚠️  Could not persist incidents:', e instanceof Error ? e.message : e); }
}
function recordIncident(m: Monitor, kind: Incident['kind'], detail: string, at: number): Incident {
    const list = loadIncidents();
    const inc: Incident = { id: randomBytes(6).toString('hex'), monitor: m.name, type: m.type, kind, startedAt: at, endedAt: kind === 'event' ? at : null, detail: detail.slice(0, 500) };
    list.push(inc);
    if (list.length > INCIDENTS_MAX) list.splice(0, list.length - INCIDENTS_MAX);
    persistIncidents();
    return inc;
}
function closeIncident(id: string | null, at: number): void {
    if (!id) return;
    const inc = loadIncidents().find(i => i.id === id);
    if (inc && inc.endedAt === null) { inc.endedAt = at; persistIncidents(); }
}
/** Incidents newest first; `since` filters by start or still-open. */
export function listIncidents(opts: { since?: number; monitor?: string; limit?: number } = {}): Incident[] {
    let list = loadIncidents();
    if (opts.monitor) list = list.filter(i => i.monitor === opts.monitor);
    if (opts.since) list = list.filter(i => i.startedAt >= opts.since! || i.endedAt === null || (i.endedAt && i.endedAt >= opts.since!));
    return list.slice().reverse().slice(0, opts.limit ?? 500);
}
/** Error lines per day per container across all server monitors, for the report. */
export function errorDailyAll(): { monitor: string; day: string; container: string; count: number }[] {
    const out: { monitor: string; day: string; container: string; count: number }[] = [];
    for (const [name, st] of states) for (const [day, byC] of Object.entries(st.errorDaily)) for (const [container, count] of Object.entries(byC)) out.push({ monitor: name, day, container, count });
    return out;
}

export function getStatus(name: string): MonitorStatus {
    const m = getMonitor(name);
    const { checking: _c, errPublished: _e, redisPrev: _r, pendingBursts: _b, serverErrors: _se, seenErrorKinds: _k, serverPrev: _sp, dbPrev: _d, errorDaily: _ed, openIncident: _oi, ...s } = stateOf(name);
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
/** Direct: SSRF policy applies. Via an agent: a local bridged port (the agent's TUNNEL_ALLOW decides what it reaches). */
async function resolveTarget(m: MonitorBase, host: string, port: number, scheme: string): Promise<{ host: string; port: number }> {
    if (m.via) return { host: '127.0.0.1', port: await tunnelLocalPort(m.via, host, port) };
    await assertResolvedHostAllowed(`${scheme}://${host}:${port}/`, { allowPrivate: m.allowPrivate !== false });
    return { host, port };
}
/** Rewrite an http(s) URL to go through the tunnel; returns the URL to fetch plus the Host header to keep. */
async function resolveUrl(m: MonitorBase, raw: string): Promise<{ url: string; host: string | null; tls: boolean }> {
    if (!m.via) { await assertResolvedHostAllowed(raw, { allowPrivate: m.allowPrivate !== false }); return { url: raw, host: null, tls: false }; }
    const u = new URL(raw);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const local = await tunnelLocalPort(m.via, u.hostname, port);
    const out = new URL(raw); out.hostname = '127.0.0.1'; out.port = String(local);
    return { url: out.toString(), host: u.host, tls: u.protocol === 'https:' };
}

async function checkHttp(m: HttpMonitor, s: State): Promise<string | null> {
    const r = await resolveUrl(m, m.url);
    const headers: Record<string, string> = { ...(m.headers || {}) };
    if (r.host) headers.Host = r.host;
    const t0 = Date.now();
    // shortcut: HTTPS through a tunnel skips certificate validation (the cert is for the real host, we dial 127.0.0.1); fine for health checks, revisit if the body is sensitive.
    const res = await fetch(r.url, { method: m.method, headers, signal: AbortSignal.timeout(m.timeoutMs), redirect: 'manual', ...(r.tls ? { tls: { rejectUnauthorized: false } } : {}) } as any);
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

function parseRedisInfo(raw: string): RedisInfo {
    const kv: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0 && line[0] !== '#') kv[line.slice(0, i)] = line.slice(i + 1); }
    const n = (k: string) => Number(kv[k] ?? 0) || 0;
    const used = n('used_memory'), max = n('maxmemory'), hits = n('keyspace_hits'), misses = n('keyspace_misses');
    const replica = kv.role === 'slave';
    return {
        version: kv.redis_version || '?', uptimeSec: n('uptime_in_seconds'), role: kv.role || '?',
        usedMemory: used, maxMemory: max, memoryPct: max > 0 ? Math.round(1000 * used / max) / 10 : null,
        clients: n('connected_clients'), blockedClients: n('blocked_clients'),
        evictedKeys: n('evicted_keys'), rejectedConnections: n('rejected_connections'),
        hits, misses, hitRatio: hits + misses > 0 ? Math.round(1000 * hits / (hits + misses)) / 10 : null,
        rdbStatus: kv.rdb_last_bgsave_status || 'ok', aofStatus: kv.aof_enabled === '1' ? (kv.aof_last_write_status || 'ok') : null,
        linkStatus: replica ? (kv.master_link_status || '?') : null, replicaLagSec: replica ? n('master_last_io_seconds_ago') : null,
    };
}

const fmtBytes = (b: number) => b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + ' GB' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

/** fail = episodic (down / slow / memory / clients / persistence / replication); burst = one-shot (restart, evictions, rejected connections). */
async function checkRedis(m: RedisMonitor, s: State): Promise<{ fail: string | null; burst: string | null }> {
    const tgt = await resolveTarget(m, m.host, m.port, m.tls ? 'https' : 'http');
    const auth = m.password ? `:${encodeURIComponent(m.password)}@` : '';
    const url = `${m.tls ? 'rediss' : 'redis'}://${auth}${tgt.host}:${tgt.port}/${m.db}`;
    const client = new RedisClient(url, { connectionTimeout: 5000, autoReconnect: false, enableOfflineQueue: false });
    const t0 = Date.now();
    try {
        await client.connect();
        const pong = await client.send('PING', []);
        const latency = Date.now() - t0;
        s.lastValue = latency;
        if (pong !== 'PONG') return { fail: `unexpected PING reply: ${String(pong)}`, burst: null };
        // shortcut: Bun's RedisClient fails on bulk replies of a few KB (full INFO), so read the sections one by one; drop when Bun fixes it.
        let raw = '';
        for (const sec of ['server', 'clients', 'memory', 'stats', 'persistence', 'replication']) raw += String(await client.send('INFO', [sec])) + '\n';
        const info = parseRedisInfo(raw);
        s.redis = info;
        const fails: string[] = [], bursts: string[] = [];
        if (m.maxLatencyMs > 0 && latency > m.maxLatencyMs) fails.push(`slow: ${latency} ms (max ${m.maxLatencyMs} ms)`);
        if (m.maxMemoryPct > 0 && info.memoryPct !== null && info.memoryPct > m.maxMemoryPct) fails.push(`memory ${info.memoryPct}% of maxmemory (${fmtBytes(info.usedMemory)} / ${fmtBytes(info.maxMemory)}, max ${m.maxMemoryPct}%)`);
        if (m.maxClients > 0 && info.clients > m.maxClients) fails.push(`${info.clients} clients connected (max ${m.maxClients})`);
        if (info.rdbStatus !== 'ok') fails.push(`last RDB save failed (${info.rdbStatus})`);
        if (info.aofStatus && info.aofStatus !== 'ok') fails.push(`AOF write failing (${info.aofStatus})`);
        if (info.linkStatus && info.linkStatus !== 'up') fails.push(`replica link ${info.linkStatus}`);
        else if (m.maxReplicaLagSec > 0 && info.replicaLagSec !== null && info.replicaLagSec > m.maxReplicaLagSec) fails.push(`replica ${info.replicaLagSec}s behind master (max ${m.maxReplicaLagSec}s)`);
        const prev = s.redisPrev;
        if (prev) {
            if (info.uptimeSec < prev.uptime) bursts.push(`server restarted (uptime ${info.uptimeSec}s) — cache is empty`);
            if (info.evictedKeys > prev.evicted) bursts.push(`${info.evictedKeys - prev.evicted} key(s) evicted for lack of memory`);
            if (info.rejectedConnections > prev.rejected) bursts.push(`${info.rejectedConnections - prev.rejected} connection(s) rejected (maxclients reached)`);
        }
        s.redisPrev = { evicted: info.evictedKeys, rejected: info.rejectedConnections, uptime: info.uptimeSec };
        return { fail: fails.join('; ') || null, burst: bursts.join('; ') || null };
    } finally {
        try { client.close(); } catch {}
    }
}

/** The dead-letter queue a RabbitMQ monitor watches alongside its queue. */
export function errorQueueName(m: RabbitMqMonitor): string { return m.errorQueue || `${m.queue}_error`; }

/** fail = episodic alert reason (health / silence); burst = one-shot reason (messages arrived). */
async function checkRabbit(m: RabbitMqMonitor, s: State): Promise<{ fail: string | null; burst: string | null; delta: number }> {
    const vhost = encodeURIComponent(m.vhost || '/');
    const headers: Record<string, string> = {};
    if (m.username) headers.Authorization = 'Basic ' + Buffer.from(`${m.username}:${m.password || ''}`).toString('base64');
    const apiBase = await resolveUrl(m, m.apiUrl.replace(/\/+$/, ''));
    if (apiBase.host) headers.Host = apiBase.host;
    const get = async (path: string) => {
        const url = `${apiBase.url.replace(/\/+$/, '')}${path}`;
        if (!m.via) await assertResolvedHostAllowed(url, { allowPrivate: m.allowPrivate !== false });
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
        s.consumers = Number(j?.consumers ?? 0);
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
    if (m.watchErrorQueue !== false) { // monitors saved before this field existed default to watching
        const eq = errorQueueName(m);
        try {
            const j = await get(`/api/queues/${vhost}/${encodeURIComponent(eq)}`);
            const published = Number(j?.message_stats?.publish ?? 0);
            s.errorQueue = { name: eq, messages: Number(j?.messages ?? 0) };
            if (s.errPublished !== null && published > s.errPublished) {
                const n = published - s.errPublished;
                burst = (burst ? burst + '; ' : '') + `${n} new message(s) in error queue "${eq}"`;
            }
            s.errPublished = published;
        } catch (e: any) {
            // 404 = no dead-letter queue (yet): report it, do not alert on it.
            s.errorQueue = { name: eq, messages: null };
            if (!/HTTP 404/.test(String(e?.message || e))) throw e;
        }
    } else {
        s.errorQueue = null;
    }
    return { fail: fails.length ? fails.join('; ') : null, burst, delta };
}

async function notify(m: Monitor, kind: 'alert' | 'recovered', detail: string): Promise<void> {
    const target = m.type === 'http' ? `${m.method} ${m.url}` : m.type === 'redis' ? `redis ${m.host}:${m.port}/${m.db}` : m.type === 'server' ? `docker host ${m.name}` : m.type === 'database' ? `${m.engine} ${m.host}:${m.port}/${m.database}` : m.type === 'traffic' ? `${m.source} ${m.resource}` : `queue ${m.queue} @ ${m.apiUrl}`;
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
export async function peekQueue(m: RabbitMqMonitor, count = 10, which: 'main' | 'error' = 'main'): Promise<PeekedMessage[]> {
    const queue = which === 'error' ? errorQueueName(m) : m.queue;
    if (which === 'main') {
        // Peeking pops and requeues: on a queue with a live consumer that reorders a message and
        // flags it redelivered, which payment consumers often treat as a failed retry. Refuse.
        const c = stateOf(m.name).consumers;
        if (c === null || c > 0) throw new Error(`"${m.queue}" has ${c ?? 'unknown'} active consumer(s) — peeking would requeue messages as redelivered. Peek the error queue instead.`);
    }
    const url = `${m.apiUrl}/api/queues/${encodeURIComponent(m.vhost || '/')}/${encodeURIComponent(queue)}/get`;
    await assertResolvedHostAllowed(url, { allowPrivate: m.allowPrivate !== false });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (m.username) headers.Authorization = 'Basic ' + Buffer.from(`${m.username}:${m.password || ''}`).toString('base64');
    const res = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ count: Math.max(1, Math.min(500, count)), ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 20_000 }) });
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

// ─── Error-queue operations ─────────────────────────────────────────────────
// The management API only pops messages from the head of a queue, so every
// operation works on "the first N" (or all). Requeue = pop from the error queue,
// republish to the main queue with the original properties (x-death headers
// dropped so the consumer sees a clean retry). If a republish fails, the message
// is pushed back to the error queue and the batch stops — nothing is lost silently.

function rabbitHeaders(m: RabbitMqMonitor, json = false): Record<string, string> {
    const h: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {};
    if (m.username) h.Authorization = 'Basic ' + Buffer.from(`${m.username}:${m.password || ''}`).toString('base64');
    return h;
}
async function rabbitPop(m: RabbitMqMonitor, queue: string, count: number, requeue: boolean): Promise<any[]> {
    const vh = encodeURIComponent(m.vhost || '/');
    const url = `${m.apiUrl}/api/queues/${vh}/${encodeURIComponent(queue)}/get`;
    await assertResolvedHostAllowed(url, { allowPrivate: m.allowPrivate !== false });
    const res = await fetch(url, { method: 'POST', headers: rabbitHeaders(m, true), signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ count, ackmode: requeue ? 'ack_requeue_true' : 'ack_requeue_false', encoding: 'auto', truncate: 10_000_000 }) });
    if (!res.ok) throw new Error(`management API HTTP ${res.status} (get ${queue})`);
    return (await res.json()) as any[];
}
async function rabbitPublish(m: RabbitMqMonitor, routingKey: string, msg: any, stripDeath: boolean): Promise<void> {
    const vh = encodeURIComponent(m.vhost || '/');
    const url = `${m.apiUrl}/api/exchanges/${vh}/amq.default/publish`;
    const props = { ...(msg.properties || {}) };
    if (stripDeath && props.headers && typeof props.headers === 'object') {
        const h = { ...props.headers }; delete h['x-death']; delete h['x-first-death-exchange']; delete h['x-first-death-queue']; delete h['x-first-death-reason']; delete h['x-last-death-exchange']; delete h['x-last-death-queue']; delete h['x-last-death-reason'];
        props.headers = h;
    }
    const res = await fetch(url, { method: 'POST', headers: rabbitHeaders(m, true), signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ routing_key: routingKey, payload: msg.payload, payload_encoding: msg.payload_encoding === 'base64' ? 'base64' : 'string', properties: props }) });
    if (!res.ok) throw new Error(`management API HTTP ${res.status} (publish ${routingKey})`);
    const j: any = await res.json().catch(() => ({}));
    if (j && j.routed === false) throw new Error(`publish to "${routingKey}" was not routed (queue missing?)`);
}

export interface ErrorQueueResult { requested: number | 'all'; processed: number; remaining: number | null; error?: string }

/** Move the first `count` (or all) messages from the error queue back to the main queue. */
export async function requeueErrorMessages(m: RabbitMqMonitor, count: number | 'all'): Promise<ErrorQueueResult> {
    const eq = errorQueueName(m);
    let processed = 0; let error: string | undefined;
    const limit = count === 'all' ? Infinity : Math.max(1, count);
    outer: while (processed < limit) {
        const batch = await rabbitPop(m, eq, Math.min(50, limit - processed), false);
        if (!batch.length) break;
        for (const msg of batch) {
            try { await rabbitPublish(m, m.queue, msg, true); processed++; }
            catch (e) {
                error = e instanceof Error ? e.message : String(e);
                // Put it (and the rest of this popped batch) back so nothing is lost.
                try { await rabbitPublish(m, eq, msg, false); } catch { error += ' — and the message could NOT be returned to the error queue; see logs'; console.error('[monitor] lost message while requeueing', m.name, msg); }
                for (const rest of batch.slice(batch.indexOf(msg) + 1)) { try { await rabbitPublish(m, eq, rest, false); } catch { console.error('[monitor] lost message while requeueing', m.name, rest); } }
                break outer;
            }
        }
        if (batch.length < 50 && count !== 'all') break;
    }
    return { requested: count, processed, remaining: await errorQueueDepth(m), error };
}

/** Drop the first `count` messages (pop without requeue), or purge the whole queue. */
export async function discardErrorMessages(m: RabbitMqMonitor, count: number | 'all'): Promise<ErrorQueueResult> {
    const eq = errorQueueName(m);
    if (count === 'all') {
        const vh = encodeURIComponent(m.vhost || '/');
        const url = `${m.apiUrl}/api/queues/${vh}/${encodeURIComponent(eq)}/contents`;
        await assertResolvedHostAllowed(url, { allowPrivate: m.allowPrivate !== false });
        const before = (await errorQueueDepth(m)) ?? 0;
        const res = await fetch(url, { method: 'DELETE', headers: rabbitHeaders(m), signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`management API HTTP ${res.status} (purge ${eq})`);
        return { requested: 'all', processed: before, remaining: 0 };
    }
    let processed = 0;
    while (processed < count) {
        const batch = await rabbitPop(m, eq, Math.min(50, count - processed), false);
        if (!batch.length) break;
        processed += batch.length;
    }
    return { requested: count, processed, remaining: await errorQueueDepth(m) };
}

/** Read (without consuming) up to `count` messages for download. */
export async function exportErrorMessages(m: RabbitMqMonitor, count = 500): Promise<PeekedMessage[]> {
    return peekQueue(m, Math.min(500, Math.max(1, count)), 'error');
}

async function errorQueueDepth(m: RabbitMqMonitor): Promise<number | null> {
    try {
        const vh = encodeURIComponent(m.vhost || '/');
        const res = await fetch(`${m.apiUrl}/api/queues/${vh}/${encodeURIComponent(errorQueueName(m))}?columns=messages`, { headers: rabbitHeaders(m), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        return Number(((await res.json()) as any)?.messages ?? 0);
    } catch { return null; }
}

// ─── Server (Docker host agent) ─────────────────────────────────────────────

const ERROR_KIND_RE = /\b([A-Z][A-Za-z0-9_$.]*(?:Exception|Error|Fault|Timeout))\b/;
/** "NullPointerException" from a Java/.NET/Node line; else the first word after the level. */
function errorKind(line: string): string {
    const m = ERROR_KIND_RE.exec(line);
    if (m) return m[1].split('.').pop()!;
    const t = line.replace(/^\S*\d{4}-\d\d-\d\d\S*\s*/, '').match(/\b(ERROR|FATAL|Exception|panic|WARN)\b[:\s-]*(\S+)/i);
    return t ? (t[1] + ' ' + t[2]).slice(0, 60) : line.slice(0, 40);
}

/** Validate a token against a server monitor; constant-time. Returns the monitor or null. */
export function agentMonitorForToken(name: string, token: string): ServerMonitor | null {
    const m = getMonitor(name.toLowerCase());
    if (!m || m.type !== 'server' || !m.agentTokenHash || !token || token.length > 256) return null;
    const a = Buffer.from(m.agentTokenHash, 'hex'), b = Buffer.from(hashAgentToken(token), 'hex');
    return a.length === b.length && timingSafeEqual(a, b) ? m : null;
}
/** Source-IP allowlist, when the monitor has one. */
export function agentSourceAllowed(m: ServerMonitor, ip: string): boolean {
    return !m.allowedSourceCidrs?.length || ipInCidrs(ip.replace(/^::ffff:/, ''), m.allowedSourceCidrs);
}
/** A genuine agent reports once per interval; anything much faster is a replay or a misconfigured/abusive client. */
export function agentReportTooSoon(m: ServerMonitor): boolean {
    const s = stateOf(m.name);
    const minGapMs = Math.max(5, Math.floor(m.intervalSeconds / 3)) * 1000;
    return s.server !== null && Date.now() - s.server.at < minGapMs;
}

/** Store an agent report, detect one-shot events against the previous one, then evaluate the monitor. */
export async function ingestAgentReport(m: ServerMonitor, r: AgentReport): Promise<MonitorStatus> {
    const s = stateOf(m.name);
    const now = Date.now();
    const windowMs = m.logWindowMinutes * 60_000;
    const containers: ServerSnapshot['containers'] = [];
    for (const c of r.containers) {
        const { errors: lines, ...rest } = c;
        for (const e of lines) s.serverErrors.push({ at: e.at || now, container: c.name, line: e.line.slice(0, 500), ...(e.warn ? { warn: true } : {}) });
        const errors = lines.filter(e => !e.warn);   // everything below (counts, new-error detection, alerts) is about errors only
        if (errors.length) { const day = new Date(now).toISOString().slice(0, 10); (s.errorDaily[day] ||= {})[c.name] = (s.errorDaily[day][c.name] || 0) + errors.length; }
        if (watchedContainer(m, c.name)) {
            const prev = s.serverPrev.get(c.name);
            if (prev && c.restartCount > prev.restartCount) s.pendingBursts.push(`container "${c.name}" restarted (${c.restartCount - prev.restartCount}×, total ${c.restartCount})${c.oomKilled ? ' — OOM killed' : ''}${c.exitCode ? ` exit ${c.exitCode}` : ''}`);
            else if (prev && c.oomKilled && !prev.oomKilled) s.pendingBursts.push(`container "${c.name}" was OOM killed`);
            let seen = s.seenErrorKinds.get(c.name);
            const firstReport = !seen;
            if (!seen) { seen = new Set(); s.seenErrorKinds.set(c.name, seen); }
            for (const e of errors) {
                const k = errorKind(e.line);
                if (!seen.has(k)) { seen.add(k); if (!firstReport) s.pendingBursts.push(`new error in "${c.name}": ${e.line.slice(0, 200)}`); }
            }
            const inWindow = s.serverErrors.filter(e => e.container === c.name && !e.warn && now - e.at <= windowMs).length;
            // first report only baselines: a backlog of old errors must not alert
            if (!firstReport && m.logErrorsPerWindow > 0 && errors.length && inWindow >= m.logErrorsPerWindow) s.pendingBursts.push(`${inWindow} error lines in "${c.name}" within ${m.logWindowMinutes} min — last: ${errors[errors.length - 1].line.slice(0, 200)}`);
        }
        s.serverPrev.set(c.name, { restartCount: c.restartCount, oomKilled: c.oomKilled, running: c.status === 'running' || s.serverPrev.get(c.name)?.running === true });
        const all = s.serverErrors.filter(e => e.container === c.name), mine = all.filter(e => !e.warn);
        containers.push({ ...rest, warningsInWindow: all.filter(e => e.warn && now - e.at <= windowMs).length, errorsInWindow: mine.filter(e => now - e.at <= windowMs).length, lastError: mine.length ? { at: mine[mine.length - 1].at, line: mine[mine.length - 1].line } : null });
    }
    if (s.serverErrors.length > ERRORS_MAX) s.serverErrors.splice(0, s.serverErrors.length - ERRORS_MAX);
    for (const day of Object.keys(s.errorDaily)) if (Date.now() - Date.parse(day) > 15 * 86_400_000) delete s.errorDaily[day];
    s.server = { at: now, host: r.host, containers: containers.sort((a, b) => a.name.localeCompare(b.name)) };
    s.lastActivityAt = now;
    return runCheck(m);
}

export function serverErrors(name: string, container?: string, limit = 200): { at: number; container: string; line: string; warn?: boolean }[] {
    const all = stateOf(name).serverErrors;
    const list = container ? all.filter(e => e.container === container) : all;
    return list.slice(-limit).reverse();
}

/** Critical list set → only those; otherwise everything not ignored. */
export function watchedContainer(m: ServerMonitor, name: string): boolean {
    if (m.ignoreContainers.includes(name)) return false;
    return !m.criticalContainers?.length || m.criticalContainers.includes(name);
}

/** Episodic failures from the latest report; bursts queued by ingestAgentReport. value = error lines in this report. */
function checkServer(m: ServerMonitor, s: State): { fail: string | null; burst: string | null; value: number } {
    const fails: string[] = [];
    const burst = s.pendingBursts.join('; ') || null;
    s.pendingBursts = [];
    const snap = s.server;
    if (!snap) {
        if (s.lastCheckAt === null) return { fail: null, burst, value: 0 }; // just created: wait for the first report
        return { fail: 'no report from the agent yet — is it running?', burst, value: 0 };
    }
    const staleMs = Math.max(3 * m.intervalSeconds, 90) * 1000;
    if (Date.now() - snap.at > staleMs) fails.push(`agent silent for ${Math.round((Date.now() - snap.at) / 60_000)} min — server offline or agent down`);
    const crit = m.criticalContainers || [];
    for (const name of crit) if (!snap.containers.some(c => c.name === name)) fails.push(`critical container "${name}" not found on the host`);
    for (const c of snap.containers) {
        if (!watchedContainer(m, c.name)) continue;
        // without a critical list: a stopped container only matters when Docker was meant to keep it up
        const wanted = crit.length > 0 || (c.restartPolicy && c.restartPolicy !== 'no') || s.serverPrev.get(c.name)?.running === true;
        if (c.status !== 'running') { if (wanted) fails.push(`container "${c.name}" is ${c.status}${c.exitCode ? ` (exit ${c.exitCode})` : ''}`); }
        else if (c.health === 'unhealthy') fails.push(`container "${c.name}" is unhealthy`);
    }
    if (m.diskPct > 0) for (const d of snap.host.disks) if (d.pct >= m.diskPct) fails.push(`disk ${d.mount} at ${d.pct}%`);
    if (m.memPct > 0 && snap.host.memPct !== null && snap.host.memPct >= m.memPct) fails.push(`host memory at ${snap.host.memPct}%`);
    const value = snap.containers.reduce((a, c) => a + c.errorsInWindow, 0);
    const text = fails.length > 6 ? fails.slice(0, 6).join('; ') + `; and ${fails.length - 6} more` : fails.join('; ');
    return { fail: text || null, burst, value };
}

// ─── Database (Postgres / MySQL / SQL Server) ───────────────────────────────


/** Run one query per engine and read the first row; `sqlRows` abstracts Bun.SQL (pg/mysql) and tedious (mssql). */
async function withDb<T>(m: DatabaseMonitor, fn: (q: (sql: string) => Promise<any[]>) => Promise<T>): Promise<T> {
    if (m.engine === 'mssql') {
        const conn = new TdsConnection({
            server: m.host,
            authentication: { type: 'default', options: { userName: m.username, password: m.password || '' } },
            options: { port: m.port, database: m.database, encrypt: m.tls, trustServerCertificate: true, connectTimeout: 8000, requestTimeout: 10000, rowCollectionOnRequestCompletion: true },
        });
        await new Promise<void>((res, rej) => { conn.on('connect', (err: any) => err ? rej(err) : res()); conn.connect(); });
        const q = (sql: string) => new Promise<any[]>((res, rej) => {
            const rows: any[] = [];
            const r = new TdsRequest(sql, (err: any) => err ? rej(err) : res(rows));
            r.on('row', (cols: any[]) => { const o: any = {}; for (const c of cols) o[c.metadata.colName] = c.value; rows.push(o); });
            conn.execSql(r);
        });
        try { return await fn(q); } finally { try { conn.close(); } catch {} }
    }
    const url = `${m.engine === 'postgres' ? 'postgres' : 'mysql'}://${encodeURIComponent(m.username)}:${encodeURIComponent(m.password || '')}@${m.host}:${m.port}/${encodeURIComponent(m.database)}${m.tls ? (m.engine === 'postgres' ? '?sslmode=require' : '?ssl=true') : ''}`;
    const sql = new Bun.SQL(url, { max: 1, connectionTimeout: 8, idleTimeout: 10 } as any);
    try { return await fn(async (text: string) => (await (sql as any).unsafe(text)) as any[]); }
    finally { try { await sql.close(); } catch {} }
}

const Q = {
    postgres: {
        version: "SELECT version() AS v",
        conns: "SELECT count(*)::int AS n, (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS mx FROM pg_stat_activity WHERE backend_type = 'client backend'",
        longest: "SELECT coalesce(max(extract(epoch FROM now() - query_start)), 0)::float AS s FROM pg_stat_activity WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid()",
        locks: "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
        repl: "SELECT pg_is_in_recovery() AS r, CASE WHEN pg_is_in_recovery() THEN extract(epoch FROM now() - pg_last_xact_replay_timestamp())::float END AS lag",
        size: "SELECT pg_database_size(current_database())::bigint AS b",
        deadlocks: "SELECT coalesce(sum(deadlocks), 0)::bigint AS d FROM pg_stat_database",
    },
    mysql: {
        version: "SELECT VERSION() AS v",
        conns: "SELECT (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected') AS n, @@max_connections AS mx",
        longest: "SELECT COALESCE(MAX(TIME), 0) AS s FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND INFO IS NOT NULL AND ID <> CONNECTION_ID()",
        locks: "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE STATE LIKE '%lock%'",
        repl: "SHOW REPLICA STATUS",
        size: "SELECT COALESCE(SUM(data_length + index_length), 0) AS b FROM information_schema.TABLES WHERE table_schema = DATABASE()",
        deadlocks: "SELECT NULL AS d",
    },
    mssql: {
        version: "SELECT @@VERSION AS v",
        conns: "SELECT (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS n, (SELECT CASE WHEN CAST(value_in_use AS int) = 0 THEN 32767 ELSE CAST(value_in_use AS int) END FROM sys.configurations WHERE name = 'user connections') AS mx",
        longest: "SELECT ISNULL(MAX(total_elapsed_time), 0) / 1000.0 AS s FROM sys.dm_exec_requests WHERE session_id <> @@SPID AND session_id > 50 AND status IN ('running', 'runnable', 'suspended')",
        locks: "SELECT COUNT(*) AS n FROM sys.dm_exec_requests WHERE blocking_session_id <> 0",
        repl: "SELECT CAST(0 AS bit) AS r, NULL AS lag",
        size: "SELECT CAST(SUM(CAST(size AS bigint)) * 8 * 1024 AS bigint) AS b FROM sys.database_files",
        deadlocks: "SELECT cntr_value AS d FROM sys.dm_os_performance_counters WHERE counter_name = 'Number of Deadlocks/sec' AND instance_name = '_Total'",
    },
} as const;

async function checkDatabase(m0: DatabaseMonitor, s: State): Promise<{ fail: string | null; burst: string | null }> {
    const tgt = await resolveTarget(m0, m0.host, m0.port, m0.tls ? 'https' : 'http');
    const m: DatabaseMonitor = tgt.host === m0.host && tgt.port === m0.port ? m0 : { ...m0, host: tgt.host, port: tgt.port };
    const q = Q[m.engine];
    const t0 = Date.now();
    return withDb(m, async run => {
        await run('SELECT 1 AS ok');
        const latency = Date.now() - t0; s.lastValue = latency;
        const one = async (sql: string) => { try { return (await run(sql))[0] || {}; } catch { return {}; } };
        const v = await one(q.version), c = await one(q.conns), l = await one(q.longest), k = await one(q.locks), sz = await one(q.size), d = await one(q.deadlocks);
        let replica = false, lag: number | null = null;
        try {
            const r = (await run(q.repl))[0] || {};
            if (m.engine === 'mysql') { if (Object.keys(r).length) { replica = true; const sb = r.Seconds_Behind_Source ?? r.Seconds_Behind_Master; lag = sb === null || sb === undefined ? null : Number(sb); } }
            else { replica = r.r === true || r.r === 1; lag = replica && r.lag !== null && r.lag !== undefined ? Number(r.lag) : null; }
        } catch {}
        const connections = Number(c.n ?? 0), maxC = c.mx === null || c.mx === undefined ? null : Number(c.mx);
        const info: DbInfo = {
            engine: m.engine, version: String(v.v || '?').split('\n')[0].slice(0, 80),
            connections, maxConnections: maxC, connectionsPct: maxC ? Math.round(1000 * connections / maxC) / 10 : null,
            longestQuerySec: Math.round(Number(l.s || 0)), waitingLocks: Number(k.n || 0),
            replica, replicaLagSec: lag === null ? null : Math.round(lag),
            sizeBytes: sz.b === null || sz.b === undefined ? null : Number(sz.b), deadlocks: d.d === null || d.d === undefined ? null : Number(d.d),
        };
        s.db = info;
        const fails: string[] = [], bursts: string[] = [];
        if (m.maxLatencyMs > 0 && latency > m.maxLatencyMs) fails.push(`slow: ${latency} ms (max ${m.maxLatencyMs} ms)`);
        if (m.maxConnectionsPct > 0 && info.connectionsPct !== null && info.connectionsPct > m.maxConnectionsPct) fails.push(`${info.connections} of ${info.maxConnections} connections in use (${info.connectionsPct}%, max ${m.maxConnectionsPct}%)`);
        if (info.replica && lag === null) fails.push('replica not receiving from primary');
        else if (m.maxReplicaLagSec > 0 && info.replica && lag !== null && lag > m.maxReplicaLagSec) fails.push(`replica ${Math.round(lag)}s behind primary (max ${m.maxReplicaLagSec}s)`);
        if (m.maxLongQuerySec > 0 && info.longestQuerySec > m.maxLongQuerySec) bursts.push(`a query has been running for ${info.longestQuerySec}s (max ${m.maxLongQuerySec}s)`);
        if (info.waitingLocks > 0) bursts.push(`${info.waitingLocks} session(s) waiting on locks`);
        if (s.dbPrev && info.deadlocks !== null && s.dbPrev.deadlocks !== null && info.deadlocks > s.dbPrev.deadlocks) bursts.push(`${info.deadlocks - s.dbPrev.deadlocks} deadlock(s)`);
        s.dbPrev = { deadlocks: info.deadlocks };
        return { fail: fails.join('; ') || null, burst: bursts.join('; ') || null };
    });
}

// ─── Traffic (the Midleman request log itself) ──────────────────────────────

function checkTraffic(m: TrafficMonitor, s: State): { fail: string | null; value: number | null } {
    const w = getTrafficWindow(m.source, m.resource, m.windowMinutes);
    const errorPct = w.total ? Math.round(1000 * w.errors / w.total) / 10 : null;
    s.traffic = { total: w.total, errors: w.errors, errorPct, avgMs: w.avgMs, windowMinutes: m.windowMinutes };
    s.lastActivityAt = w.total ? Date.now() : s.lastActivityAt;
    const fails: string[] = [];
    if (w.total >= m.minRequests) {
        if (m.maxErrorPct > 0 && errorPct !== null && errorPct > m.maxErrorPct) fails.push(`${errorPct}% of ${w.total} requests failed in the last ${m.windowMinutes} min (max ${m.maxErrorPct}%)`);
        if (m.maxAvgMs > 0 && w.avgMs !== null && w.avgMs > m.maxAvgMs) fails.push(`average ${w.avgMs} ms over ${w.total} requests (max ${m.maxAvgMs} ms)`);
    }
    return { fail: fails.join('; ') || null, value: errorPct };
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
            else if (m.type === 'redis') ({ fail, burst } = await checkRedis(m, s));
            else if (m.type === 'server') { const r = checkServer(m, s); fail = r.fail; burst = r.burst; s.lastValue = r.value; }
            else if (m.type === 'database') ({ fail, burst } = await checkDatabase(m, s));
            else if (m.type === 'traffic') { const r = checkTraffic(m, s); fail = r.fail; s.lastValue = r.value; }
            else ({ fail, burst, delta } = await checkRabbit(m, s));
        } catch (e: any) {
            // Unreachable target is itself the failure.
            fail = e?.message || String(e);
        }
        const now = Date.now();
        s.lastCheckAt = now;
        s.lastError = fail || burst;
        s.history.push({ at: now, ok: !fail && !burst, value: m.type === 'rabbitmq' ? Math.max(0, delta) : s.lastValue, error: fail || burst || null, ms: Date.now() - t0 });
        if (burst) recordIncident(m, 'event', burst, now);
        if (s.history.length > HISTORY_MAX) s.history.splice(0, s.history.length - HISTORY_MAX);
        const inHours = !m.weekly?.length || isWithinBusinessHours(m.weekly, undefined, new Date());
        const cooldownMs = m.cooldownMinutes * 60_000;
        const canAlert = () => inHours && (s.lastAlertAt === null || now - s.lastAlertAt >= cooldownMs);

        // One notification per check: a burst arriving together with a failure goes in the same message.
        if (burst && !fail && canAlert()) { s.lastAlertAt = now; await notify(m, 'alert', burst); }

        if (fail) {
            s.state = 'alert';
            if (s.alertSince === null) { s.alertSince = now; s.openIncident = recordIncident(m, 'episode', fail, now).id; }
            if (canAlert()) { s.lastAlertAt = now; await notify(m, 'alert', burst ? `${fail}; ${burst}` : fail); }
        } else {
            s.state = burst ? 'alert' : 'ok';
            if (s.alertSince !== null) {
                const downMin = Math.round((now - s.alertSince) / 60_000);
                await notify(m, 'recovered', `healthy again after ~${downMin} min`);
                closeIncident(s.openIncident, now); s.openIncident = null;
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

let lastStateSave = 0;
export function startMonitorScheduler(): void {
    if (timer) return;
    loadMonitors();
    loadStates();
    timer = setInterval(() => { void tick(); if (Date.now() - lastStateSave > 60_000) { lastStateSave = Date.now(); saveStates(); } }, 10_000);
    void tick();
    console.log(`📡 [monitors] Scheduler started (${monitors.length} monitor(s))`);
}

export function stopMonitorScheduler(): void {
    if (timer) { clearInterval(timer); timer = null; }
    saveStates();
    states.clear();
}
