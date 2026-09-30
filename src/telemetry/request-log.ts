import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync, statSync } from 'fs';
import { getLogSettings, resolveLogMode, type LogResourceKind } from './log-settings';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface RequestLogConfig {
    enabled: boolean;
    dataDir: string;
    retentionDays: number;   // Auto-purge after N days (default: 7)
    maxBodySize: number;     // Max body bytes to capture (default: 64KB)
}

const DEFAULT_CONFIG: RequestLogConfig = {
    enabled: true,
    dataDir: './data',
    retentionDays: 7,
    maxBodySize: 64 * 1024, // 64KB
};

let config: RequestLogConfig = { ...DEFAULT_CONFIG };
let db: Database | null = null;

// ─── Schema ─────────────────────────────────────────────────────────────────

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS request_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id      TEXT NOT NULL,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    type            TEXT NOT NULL,          -- 'proxy' or 'webhook'
    profile_name    TEXT,                   -- associated profile name
    target_name     TEXT,                   -- named target identifier (null for legacy/proxy)
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    target_url      TEXT NOT NULL,
    client_ip       TEXT,

    -- Request
    req_headers     TEXT,                   -- JSON
    req_body        TEXT,                   -- captured body (truncated)
    req_body_size   INTEGER DEFAULT 0,      -- original body size in bytes

    -- Response
    res_status      INTEGER,
    res_status_text TEXT,
    res_headers     TEXT,                   -- JSON
    res_body        TEXT,                   -- captured body (truncated)
    res_body_size   INTEGER DEFAULT 0,      -- original body size in bytes

    duration_ms     REAL,
    error           TEXT                    -- error message if request failed
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_type ON request_logs(type);
CREATE INDEX IF NOT EXISTS idx_request_logs_profile ON request_logs(profile_name);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(res_status);
CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_method ON request_logs(method);
CREATE INDEX IF NOT EXISTS idx_request_logs_target ON request_logs(target_name);
CREATE INDEX IF NOT EXISTS idx_request_logs_type_id ON request_logs(type, id);
`;

const MIGRATIONS = [
    // Add target_name column for multi-target support
    `ALTER TABLE request_logs ADD COLUMN target_name TEXT`,
    // Store per-attempt timeline for webhook-fanout retries (JSON array)
    `ALTER TABLE request_logs ADD COLUMN attempts TEXT`,
];

// ─── Initialization ─────────────────────────────────────────────────────────

export function initRequestLog(cfg: Partial<RequestLogConfig> = {}): void {
    config = { ...DEFAULT_CONFIG, ...cfg };

    if (!config.enabled) {
        console.log('📋 Request logging: disabled');
        return;
    }

    const dbPath = resolve(config.dataDir, 'request-logs.db');
    _dbPath = dbPath;

    try {
        mkdirSync(config.dataDir, { recursive: true });
        db = new Database(dbPath, { create: true });
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        // Incremental auto-vacuum lets purges give pages back to the OS via
        // `PRAGMA incremental_vacuum` instead of a full (blocking) VACUUM.
        // On a pre-existing database this only takes effect after the next
        // VACUUM (the "Compact" action in Settings → Logs).
        try { db.exec('PRAGMA auto_vacuum = INCREMENTAL'); } catch {}
        db.exec(CREATE_TABLE);

        // Run migrations before indexes (ignore errors for already-applied migrations)
        for (const migration of MIGRATIONS) {
            try { db.exec(migration); } catch {}
        }

        db.exec(CREATE_INDEXES);

        // Schedule auto-purge every hour
        void purgeOldLogs();
        setInterval(() => { void purgeOldLogs(); }, 60 * 60 * 1000);

        console.log(`📋 Request logging: enabled (retention: ${getEffectiveRetentionDays()}d, max body: ${(config.maxBodySize / 1024).toFixed(0)}KB, default mode: ${getLogSettings().defaultMode})`);
        console.log(`   Database: ${dbPath}`);
    } catch (err) {
        console.error('❌ Failed to initialize request log database:', err);
        db = null;
    }
}

export function shutdownRequestLog(): void {
    if (db) {
        db.close();
        db = null;
    }
}

// ─── Logging ────────────────────────────────────────────────────────────────

export interface RequestLogEntry {
    requestId: string;
    type: 'target' | 'proxy' | 'webhook' | 'webhook-fanout' | 'connector' | 'connector-fanout';
    profileName?: string;
    targetName?: string;
    method: string;
    path: string;
    targetUrl: string;
    clientIp?: string;

    reqHeaders: Record<string, string>;
    reqBody?: string | null;
    reqBodySize?: number;

    resStatus?: number;
    resStatusText?: string;
    resHeaders?: Record<string, string>;
    resBody?: string | null;
    resBodySize?: number;

    durationMs?: number;
    error?: string;

    attempts?: AttemptRecord[];
}

export interface AttemptRecord {
    attempt: number;        // 1-based
    status?: number;        // HTTP status (omitted if network error)
    statusText?: string;
    durationMs: number;
    delayMs?: number;       // wait before this attempt (0 for the first)
    error?: string;         // network/timeout error message
}

const insertStmt = () => db?.prepare(`
    INSERT INTO request_logs (
        request_id, type, profile_name, target_name, method, path, target_url, client_ip,
        req_headers, req_body, req_body_size,
        res_status, res_status_text, res_headers, res_body, res_body_size,
        duration_ms, error, attempts
    ) VALUES (
        $requestId, $type, $profileName, $targetName, $method, $path, $targetUrl, $clientIp,
        $reqHeaders, $reqBody, $reqBodySize,
        $resStatus, $resStatusText, $resHeaders, $resBody, $resBodySize,
        $durationMs, $error, $attempts
    )
`);

let _insertStmt: ReturnType<typeof insertStmt> | null = null;

// ─── Async Write Queue ───────────────────────────────────────────────────────
// logRequest never blocks the event loop — entries are pushed to a queue and
// flushed in a single WAL batch transaction on the next microtask tick.

let _logQueue: RequestLogEntry[] = [];
let _flushScheduled = false;

function buildParams(entry: RequestLogEntry) {
    return {
        $requestId: entry.requestId,
        $type: entry.type,
        $profileName: entry.profileName || null,
        $targetName: entry.targetName || null,
        $method: entry.method,
        $path: redactUrlSecrets(entry.path),
        $targetUrl: redactUrlSecrets(entry.targetUrl),
        $clientIp: entry.clientIp || null,
        $reqHeaders: JSON.stringify(entry.reqHeaders),
        $reqBody: entry.reqBody ? truncateBody(entry.reqBody) : null,
        $reqBodySize: entry.reqBodySize || 0,
        $resStatus: entry.resStatus || null,
        $resStatusText: entry.resStatusText || null,
        $resHeaders: entry.resHeaders ? JSON.stringify(entry.resHeaders) : null,
        $resBody: entry.resBody ? truncateBody(entry.resBody) : null,
        $resBodySize: entry.resBodySize || 0,
        $durationMs: entry.durationMs || null,
        $error: redactUrlSecrets(entry.error) || null,
        $attempts: entry.attempts && entry.attempts.length > 0 ? JSON.stringify(entry.attempts) : null,
    };
}

function flushLogQueue(): void {
    _flushScheduled = false;
    if (_logQueue.length === 0 || !db) return;
    const batch = _logQueue.splice(0);
    try {
        if (!_insertStmt) _insertStmt = insertStmt();
        const stmt = _insertStmt!;
        db.transaction(() => {
            for (const entry of batch) stmt.run(buildParams(entry));
        })();
    } catch (err) {
        console.error('⚠️  Failed to flush log queue:', err);
    }
}

/** Which configurable resource a log row belongs to, for per-resource log modes. */
function resourceOf(type: RequestLogEntry['type'], entry: { profileName?: string; targetName?: string }): { kind: LogResourceKind; name: string | undefined } {
    switch (type) {
        case 'proxy':
        case 'target':
            return { kind: 'profile', name: entry.profileName || entry.targetName };
        case 'webhook':
        case 'webhook-fanout':
            return { kind: 'webhook', name: entry.targetName };
        case 'connector':
        case 'connector-fanout':
            return { kind: 'connector', name: entry.targetName };
    }
}

/** True when the effective mode for this resource is anything but 'off'.
 *  Callers that pay to capture bodies (proxy clone+read) can skip that work. */
export function isLoggingEnabledFor(type: RequestLogEntry['type'], names: { profileName?: string; targetName?: string }): boolean {
    if (!db) return false;
    const r = resourceOf(type, names);
    return resolveLogMode(r.kind, r.name) !== 'off';
}

function isErrorEntry(entry: RequestLogEntry): boolean {
    if (entry.error) return true;
    return typeof entry.resStatus === 'number' && entry.resStatus >= 400;
}

export function logRequest(entry: RequestLogEntry): void {
    if (!db) return;
    const r = resourceOf(entry.type, entry);
    const mode = resolveLogMode(r.kind, r.name);
    if (mode === 'off') return;
    if (mode === 'errors-only' && !isErrorEntry(entry)) return;
    _logQueue.push(entry);
    if (!_flushScheduled) {
        _flushScheduled = true;
        queueMicrotask(flushLogQueue);
    }
}

// ─── Body Capture Helpers ───────────────────────────────────────────────────

function truncateBody(body: string): string {
    if (body.length <= config.maxBodySize) return body;
    return body.substring(0, config.maxBodySize) + `\n... [truncated at ${(config.maxBodySize / 1024).toFixed(0)}KB]`;
}

/**
 * Safely capture a request body. Clones the request to avoid consuming the stream.
 * Returns the body text and original size.
 */
export async function captureRequestBody(req: Request): Promise<{ body: string | null; size: number }> {
    if (!db) return { body: null, size: 0 };

    try {
        const contentType = req.headers.get('content-type') || '';
        // Skip binary content types
        if (isBinaryContentType(contentType)) {
            const length = parseInt(req.headers.get('content-length') || '0', 10);
            return { body: `[binary: ${contentType}, ${length} bytes]`, size: length };
        }

        // Skip cloning when content-length is known to exceed capture limit —
        // avoids allocating a second copy of a large body just for logging.
        const contentLength = parseInt(req.headers.get('content-length') || '-1', 10);
        if (contentLength > config.maxBodySize) {
            return { body: `[request body not captured: ${contentLength} bytes]`, size: contentLength };
        }

        // Clone and read body
        const clone = req.clone();
        const text = await clone.text();
        return { body: text, size: text.length };
    } catch {
        return { body: null, size: 0 };
    }
}

/**
 * Safely capture a response body. Clones the response to avoid consuming the stream.
 */
export async function captureResponseBody(res: Response): Promise<{ body: string | null; size: number }> {
    if (!db) return { body: null, size: 0 };

    try {
        const contentType = res.headers.get('content-type') || '';
        const contentLength = parseInt(res.headers.get('content-length') || '-1', 10);

        if (isBinaryContentType(contentType)) {
            return { body: `[binary: ${contentType}${contentLength >= 0 ? ', ' + contentLength + ' bytes' : ''}]`, size: contentLength >= 0 ? contentLength : 0 };
        }

        // Known-large bodies: skip entirely (cloning would buffer the whole thing).
        if (contentLength > config.maxBodySize) {
            return { body: `[response body not captured: ${contentLength} bytes]`, size: contentLength };
        }

        const clone = res.clone();
        if (contentLength >= 0) {
            const text = await clone.text();
            return { body: text, size: text.length };
        }

        // Unknown size (chunked / streaming — e.g. Kestrel, Express): read the
        // clone incrementally and stop at maxBodySize so we keep the error
        // payload of API responses without ever buffering an unbounded stream.
        if (!clone.body) return { body: null, size: 0 };
        const reader = clone.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        let truncated = false;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                received += value.byteLength;
                if (received > config.maxBodySize) {
                    chunks.push(value.subarray(0, value.byteLength - (received - config.maxBodySize)));
                    truncated = true;
                    break;
                }
                chunks.push(value);
            }
        } catch {
            // Upstream stream error — keep whatever we already have.
        }
        if (truncated) {
            // Never cancel a tee'd branch (it can stall the sibling the client is
            // reading). Drain the rest in the background and discard it.
            void (async () => { try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch {} })();
        }
        const merged = new Uint8Array(Math.min(received, config.maxBodySize));
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
        const text = new TextDecoder().decode(merged);
        return {
            body: truncated ? text + `\n... [truncated at ${(config.maxBodySize / 1024).toFixed(0)}KB, chunked response]` : text,
            size: received,
        };
    } catch {
        return { body: null, size: 0 };
    }
}

function isBinaryContentType(ct: string): boolean {
    if (!ct) return false;
    const lower = ct.toLowerCase();
    return lower.startsWith('image/') ||
        lower.startsWith('audio/') ||
        lower.startsWith('video/') ||
        lower.includes('octet-stream') ||
        lower.includes('application/zip') ||
        lower.includes('application/gzip') ||
        lower.includes('application/pdf') ||
        lower.includes('font/') ||
        lower.includes('application/wasm');
}

const REDACTED_HEADERS = new Set([
    'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
    'x-forward-token', 'proxy-authorization', 'x-access-token',
]);

export function headersToRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value;
    });
    return result;
}

// Query-string params that carry secrets and must never be persisted to the
// request log (they show up in path/targetUrl when a caller passes a token in
// the URL, e.g. ?token=, ?key=, ?hub.verify_token=).
const SECRET_QUERY_PARAMS = new Set([
    'token', 'key', 'access_key', 'accesskey', 'apikey', 'api_key',
    'verify_token', 'hub.verify_token', 'secret', 'password', 'passwd', 'pwd',
    'signature', 'sig', 'auth', 'authorization', 'access_token',
]);

/** Replace secret query-string values with [redacted] in any path or URL.
 *  Works on bare paths ("/x?token=…") and full URLs alike, leaving everything
 *  else untouched. */
export function redactUrlSecrets(s: string | null | undefined): string | null {
    if (!s || s.indexOf('=') < 0) return s ?? null;
    return s.replace(/([?&])([^=&#]+)=([^&#]*)/g, (full, sep: string, rawKey: string) => {
        let name = rawKey;
        try { name = decodeURIComponent(rawKey); } catch { /* keep raw */ }
        return SECRET_QUERY_PARAMS.has(name.toLowerCase()) ? `${sep}${rawKey}=[redacted]` : full;
    });
}

// ─── Query API ──────────────────────────────────────────────────────────────

export interface RequestLogQuery {
    page?: number;
    limit?: number;
    type?: RequestLogEntry['type'];
    profileName?: string;
    targetName?: string;
    method?: string;
    status?: number;
    requestId?: string;       // exact match (indexed) — used to load fan-outs of one request
    search?: string;          // search in path, target_url, request_id (+ body when searchBody)
    searchBody?: boolean;     // also match req_body / res_body — slower (no index)
    from?: string;            // ISO date
    to?: string;              // ISO date
    /** Include req_body in list rows. Off by default: the column can hold 64KB
     *  per row and only the webhook payload editor needs it. */
    includeBody?: boolean;
}

// Short-lived caches so the dashboard's 3s/5s polling never re-runs a full
// COUNT(*) over millions of rows on the main thread. Invalidated on purge.
const COUNT_CACHE_TTL_MS = 15_000;
const STATS_CACHE_TTL_MS = 30_000;
const _countCache = new Map<string, { at: number; total: number }>();
let _statsCache: { at: number; value: ReturnType<typeof getRequestLogStats> } | null = null;
let _breakdownCache: { at: number; value: ReturnType<typeof getRequestLogBreakdown> } | null = null;

function invalidateCaches(): void {
    _countCache.clear();
    _statsCache = null;
    _breakdownCache = null;
}

export interface RequestLogListResult {
    requests: RequestLogSummary[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

export interface RequestLogSummary {
    id: number;
    requestId: string;
    timestamp: string;
    type: string;
    profileName: string | null;
    targetName: string | null;
    method: string;
    path: string;
    targetUrl: string;
    clientIp: string | null;
    resStatus: number | null;
    resStatusText: string | null;
    durationMs: number | null;
    reqBodySize: number;
    resBodySize: number;
    error: string | null;
    attemptCount: number | null;
}

export interface RequestLogDetail extends RequestLogSummary {
    reqHeaders: string | null;
    reqBody: string | null;
    resHeaders: string | null;
    resBody: string | null;
    attempts: AttemptRecord[] | null;
}

export function queryRequestLogs(query: RequestLogQuery): RequestLogListResult {
    if (!db) return { requests: [], total: 0, page: 1, limit: 50, totalPages: 0 };

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(200, Math.max(1, query.limit || 50));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (query.type) {
        conditions.push('type = $type');
        params.$type = query.type;
    } else {
        conditions.push("type != 'webhook-fanout'");
    }
    if (query.profileName) {
        conditions.push('profile_name = $profileName');
        params.$profileName = query.profileName;
    }
    if (query.targetName) {
        conditions.push('target_name = $targetName');
        params.$targetName = query.targetName;
    }
    if (query.method) {
        conditions.push('method = $method');
        params.$method = query.method;
    }
    if (query.status) {
        conditions.push('res_status = $status');
        params.$status = query.status;
    }
    if (query.requestId) {
        conditions.push('request_id = $requestId');
        params.$requestId = query.requestId;
    }
    if (query.search) {
        // Body search is opt-in because it forces a full scan over potentially
        // large TEXT columns; the default search stays cheap (indexable cols).
        const cols = ['path', 'target_url', 'request_id', 'profile_name', 'target_name'];
        if (query.searchBody) cols.push('req_body', 'res_body');
        conditions.push('(' + cols.map(c => `${c} LIKE $search`).join(' OR ') + ')');
        params.$search = `%${query.search}%`;
    }
    if (query.from) {
        conditions.push('timestamp >= $from');
        params.$from = query.from;
    }
    if (query.to) {
        conditions.push('timestamp <= $to');
        params.$to = query.to;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Exact request_id lookups are tiny and never worth caching; everything
    // else (notably the unfiltered default view) is cached briefly.
    const cacheKey = query.requestId ? null : where + '|' + JSON.stringify(params);
    let total: number;
    const cached = cacheKey ? _countCache.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.at < COUNT_CACHE_TTL_MS) {
        total = cached.total;
    } else {
        const countRow = db.prepare(`SELECT COUNT(*) as total FROM request_logs ${where}`).get(params as any) as { total: number };
        total = countRow?.total || 0;
        if (cacheKey) _countCache.set(cacheKey, { at: Date.now(), total });
    }

    const bodyCol = query.includeBody ? 'req_body, ' : '';
    const rows = db.prepare(`
        SELECT id, request_id, timestamp, type, profile_name, target_name, method, path, target_url,
               client_ip, ${bodyCol}res_status, res_status_text, duration_ms, req_body_size, res_body_size, error, attempts
        FROM request_logs ${where}
        ORDER BY id DESC
        LIMIT $limit OFFSET $offset
    `).all({ ...params, $limit: limit, $offset: offset } as any) as any[];

    return {
        requests: rows.map(r => {
            let attemptCount: number | null = null;
            if (r.attempts) {
                try { const arr = JSON.parse(r.attempts); if (Array.isArray(arr)) attemptCount = arr.length; } catch {}
            }
            return {
                id: r.id,
                requestId: r.request_id,
                timestamp: r.timestamp,
                type: r.type,
                profileName: r.profile_name,
                targetName: r.target_name,
                method: r.method,
                path: r.path,
                targetUrl: r.target_url,
                clientIp: r.client_ip,
                ...(query.includeBody ? { reqBody: r.req_body } : {}),
                resStatus: r.res_status,
                resStatusText: r.res_status_text,
                durationMs: r.duration_ms,
                reqBodySize: r.req_body_size,
                resBodySize: r.res_body_size,
                error: r.error,
                attemptCount,
            };
        }),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
    };
}

export function getRequestLogDetail(id: number): RequestLogDetail | null {
    if (!db) return null;

    const row = db.prepare(`
        SELECT id, request_id, timestamp, type, profile_name, target_name, method, path, target_url,
               client_ip, req_headers, req_body, req_body_size,
               res_status, res_status_text, res_headers, res_body, res_body_size,
               duration_ms, error, attempts
        FROM request_logs WHERE id = $id
    `).get({ $id: id }) as any;

    if (!row) return null;

    let attempts: AttemptRecord[] | null = null;
    if (row.attempts) {
        try { attempts = JSON.parse(row.attempts); } catch { attempts = null; }
    }

    return {
        id: row.id,
        requestId: row.request_id,
        timestamp: row.timestamp,
        type: row.type,
        profileName: row.profile_name,
        targetName: row.target_name,
        method: row.method,
        path: row.path,
        targetUrl: row.target_url,
        clientIp: row.client_ip,
        reqHeaders: row.req_headers,
        reqBody: row.req_body,
        reqBodySize: row.req_body_size,
        resStatus: row.res_status,
        resStatusText: row.res_status_text,
        resHeaders: row.res_headers,
        resBody: row.res_body,
        resBodySize: row.res_body_size,
        durationMs: row.duration_ms,
        error: row.error,
        attempts,
        attemptCount: attempts ? attempts.length : null,
    };
}

// ─── Purge ──────────────────────────────────────────────────────────────────

let _dbPath = '';

/** Retention in days: dashboard setting wins, then env/config, then 7. */
export function getEffectiveRetentionDays(): number {
    const s = getLogSettings();
    if (s.retentionDays && s.retentionDays > 0) return s.retentionDays;
    return config.retentionDays > 0 ? config.retentionDays : 7;
}

/** request_logs.timestamp is stored by SQLite's datetime('now') as
 *  "YYYY-MM-DD HH:MM:SS" (UTC, space separator). Cutoffs must use the same
 *  shape — an ISO string with a "T" does not compare correctly. */
function toSqliteUtc(d: Date): string {
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

const PURGE_BATCH = 5000;

export interface PurgeOptions {
    /** Delete rows older than this many hours. Omit/0 = no age filter (everything matching). */
    olderThanHours?: number;
    /** Keep rows that represent failures (res_status >= 400 or error set). */
    keepErrors?: boolean;
    /** Restrict to one row type. */
    type?: RequestLogEntry['type'];
}

export interface PurgeStatus {
    running: boolean;
    deleted: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    options: PurgeOptions | null;
}

const _purge: PurgeStatus = { running: false, deleted: 0, startedAt: null, finishedAt: null, error: null, options: null };

export function getPurgeStatus(): PurgeStatus {
    return { ..._purge, options: _purge.options ? { ..._purge.options } : null };
}

const yieldToLoop = () => new Promise<void>(r => setTimeout(r, 0));

/**
 * Delete in small batches, yielding to the event loop between them, so a
 * multi-million-row purge never freezes proxy traffic (bun:sqlite is sync).
 * Returns the number of rows deleted.
 */
async function deleteInBatches(where: string, params: Record<string, any>): Promise<number> {
    if (!db) return 0;
    const stmt = db.prepare(`DELETE FROM request_logs WHERE id IN (SELECT id FROM request_logs ${where} LIMIT ${PURGE_BATCH})`);
    let total = 0;
    for (;;) {
        const changes = (stmt.run(params as any) as any).changes as number;
        total += changes;
        _purge.deleted = total;
        if (changes < PURGE_BATCH) break;
        await yieldToLoop();
    }
    return total;
}

/** Give freed pages back to the OS without a full VACUUM. No-op until the
 *  database has been VACUUMed once with auto_vacuum=INCREMENTAL set. */
function reclaimSpace(): void {
    if (!db) return;
    try { db.exec('PRAGMA incremental_vacuum'); } catch {}
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
}

function buildPurgeWhere(opts: PurgeOptions): { where: string; params: Record<string, any> } {
    const conds: string[] = [];
    const params: Record<string, any> = {};
    if (opts.olderThanHours && opts.olderThanHours > 0) {
        conds.push('timestamp < $cutoff');
        params.$cutoff = toSqliteUtc(new Date(Date.now() - opts.olderThanHours * 3600 * 1000));
    }
    if (opts.keepErrors) {
        conds.push('(error IS NULL AND (res_status IS NULL OR res_status < 400))');
    }
    if (opts.type) {
        conds.push('type = $type');
        params.$type = opts.type;
    }
    return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

/** Scheduled retention purge (hourly). */
async function purgeOldLogs(): Promise<void> {
    if (!db || _purge.running) return;
    try {
        const days = getEffectiveRetentionDays();
        const { where, params } = buildPurgeWhere({ olderThanHours: days * 24 });
        const deleted = await deleteInBatches(where, params);
        if (deleted > 0) {
            invalidateCaches();
            reclaimSpace();
            console.log(`🧹 Purged ${deleted} request log(s) older than ${days} day(s)`);
        }
    } catch (err) {
        console.error('⚠️  Failed to purge old request logs:', err);
    }
}

/**
 * Manual purge from the dashboard. Runs in the background; poll
 * getPurgeStatus() for progress. Rejects if one is already running.
 */
export function startPurge(opts: PurgeOptions): PurgeStatus {
    if (!db) throw new Error('Request logging is disabled');
    if (_purge.running) throw new Error('A purge is already running');
    _purge.running = true;
    _purge.deleted = 0;
    _purge.startedAt = new Date().toISOString();
    _purge.finishedAt = null;
    _purge.error = null;
    _purge.options = { ...opts };
    const { where, params } = buildPurgeWhere(opts);
    (async () => {
        try {
            const deleted = await deleteInBatches(where, params);
            invalidateCaches();
            reclaimSpace();
            console.log(`🧹 Manual purge removed ${deleted} request log(s) (${JSON.stringify(opts)})`);
        } catch (err) {
            _purge.error = err instanceof Error ? err.message : String(err);
            console.error('⚠️  Manual purge failed:', err);
        } finally {
            _purge.running = false;
            _purge.finishedAt = new Date().toISOString();
        }
    })();
    return getPurgeStatus();
}

/**
 * Full VACUUM: rebuilds the file so it actually shrinks after purges and
 * enables incremental auto-vacuum for the future. Blocks the process for the
 * duration (seconds to minutes on a multi-GB file) — the UI warns about it.
 */
export function compactDatabase(): { beforeMB: number; afterMB: number; durationMs: number } {
    if (!db) throw new Error('Request logging is disabled');
    if (_purge.running) throw new Error('Wait for the running purge to finish');
    const before = fileSizeMB();
    const t0 = performance.now();
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    db.exec('VACUUM');
    invalidateCaches();
    return { beforeMB: before, afterMB: fileSizeMB(), durationMs: Math.round(performance.now() - t0) };
}

function fileSizeMB(): number {
    try {
        let bytes = statSync(_dbPath).size;
        try { bytes += statSync(_dbPath + '-wal').size; } catch {}
        return Math.round(bytes / (1024 * 1024) * 100) / 100;
    } catch {
        return 0;
    }
}

export function getRequestLogStats(): { total: number; oldest: string | null; newest: string | null; dbSizeMB: number; fileSizeMB: number; retentionDays: number } {
    const empty = { total: 0, oldest: null, newest: null, dbSizeMB: 0, fileSizeMB: 0, retentionDays: getEffectiveRetentionDays() };
    if (!db) return empty;
    if (_statsCache && Date.now() - _statsCache.at < STATS_CACHE_TTL_MS) return _statsCache.value;

    try {
        const stats = db.prepare(`
            SELECT COUNT(*) as total,
                   MIN(timestamp) as oldest,
                   MAX(timestamp) as newest
            FROM request_logs
            WHERE type != 'webhook-fanout'
        `).get() as any;

        const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count || 0;
        const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size || 4096;
        const dbSizeMB = Math.round((pageCount * pageSize) / (1024 * 1024) * 100) / 100;

        const value = {
            total: stats?.total || 0,
            oldest: stats?.oldest || null,
            newest: stats?.newest || null,
            dbSizeMB,
            fileSizeMB: fileSizeMB(),
            retentionDays: getEffectiveRetentionDays(),
        };
        _statsCache = { at: Date.now(), value };
        return value;
    } catch {
        return empty;
    }
}

/** Per-type row and error counts for the Settings → Logs page (cached 30s). */
export function getRequestLogBreakdown(): { types: { type: string; count: number; errors: number }[]; total: number; errors: number; freelistMB: number; autoVacuum: string } {
    const empty = { types: [], total: 0, errors: 0, freelistMB: 0, autoVacuum: 'none' };
    if (!db) return empty;
    if (_breakdownCache && Date.now() - _breakdownCache.at < STATS_CACHE_TTL_MS) return _breakdownCache.value;
    try {
        const types = db.prepare(`
            SELECT type, COUNT(*) as count,
                   SUM(CASE WHEN error IS NOT NULL OR res_status >= 400 THEN 1 ELSE 0 END) as errors
            FROM request_logs GROUP BY type ORDER BY count DESC
        `).all() as { type: string; count: number; errors: number }[];
        const freelist = (db.prepare('PRAGMA freelist_count').get() as any)?.freelist_count || 0;
        const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size || 4096;
        const av = (db.prepare('PRAGMA auto_vacuum').get() as any)?.auto_vacuum;
        const value = {
            types,
            total: types.reduce((a, t) => a + t.count, 0),
            errors: types.reduce((a, t) => a + (t.errors || 0), 0),
            freelistMB: Math.round(freelist * pageSize / (1024 * 1024) * 100) / 100,
            autoVacuum: av === 2 ? 'incremental' : av === 1 ? 'full' : 'none',
        };
        _breakdownCache = { at: Date.now(), value };
        return value;
    } catch {
        return empty;
    }
}

/**
 * Returns the most recent timestamp (Unix ms) for a webhook by name, considering
 * only inbound `webhook` records (fan-out attempts are excluded). Null when the
 * webhook has never received a payload — used by the silence-alert scheduler.
 */
export function getLastWebhookActivity(webhookName: string): number | null {
    if (!db) return null;
    try {
        const row = db.prepare(
            `SELECT MAX(timestamp) AS ts FROM request_logs WHERE type = 'webhook' AND target_name = $name`
        ).get({ $name: webhookName }) as { ts: string | null } | undefined;
        if (!row || !row.ts) return null;
        // request_logs timestamps are stored as ISO UTC without a trailing 'Z'
        const ms = Date.parse(row.ts + 'Z');
        return Number.isFinite(ms) ? ms : null;
    } catch {
        return null;
    }
}

export function getRequestLogChart(): {
    timeline: { bucket: string; count: number; errors: number }[];
    methods: { method: string; count: number }[];
    statuses: { status: number; count: number }[];
    avgDuration: number;
    errorRate: number;
} {
    const empty = { timeline: [], methods: [], statuses: [], avgDuration: 0, errorRate: 0 };
    if (!db) return empty;

    try {
        // Time-bucketed request counts (last 24h, 30-minute buckets)
        const rawTimeline = db.prepare(`
            SELECT strftime('%Y-%m-%dT%H:', timestamp) ||
                   CASE WHEN CAST(strftime('%M', timestamp) AS INTEGER) < 30 THEN '00' ELSE '30' END AS bucket,
                   COUNT(*) as count,
                   SUM(CASE WHEN res_status >= 500 OR error IS NOT NULL THEN 1 ELSE 0 END) as errors
            FROM request_logs
            WHERE timestamp >= datetime('now', '-24 hours')
            GROUP BY bucket
            ORDER BY bucket ASC
        `).all() as { bucket: string; count: number; errors: number }[];

        // Build a dense 48-slot grid (last 24h, 30-minute resolution, UTC) so the
        // chart always renders consistently even when traffic is sparse.
        const byBucket = new Map(rawTimeline.map(r => [r.bucket, r]));
        const now = new Date();
        const anchor = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            now.getUTCHours(), now.getUTCMinutes() < 30 ? 0 : 30, 0, 0,
        ));
        const timeline: { bucket: string; count: number; errors: number }[] = [];
        for (let i = 47; i >= 0; i--) {
            const t = new Date(anchor.getTime() - i * 30 * 60 * 1000);
            const bucket =
                t.getUTCFullYear() + '-' +
                String(t.getUTCMonth() + 1).padStart(2, '0') + '-' +
                String(t.getUTCDate()).padStart(2, '0') + 'T' +
                String(t.getUTCHours()).padStart(2, '0') + ':' +
                String(t.getUTCMinutes()).padStart(2, '0');
            const hit = byBucket.get(bucket);
            timeline.push({ bucket, count: hit?.count ?? 0, errors: hit?.errors ?? 0 });
        }

        // Method breakdown
        const methods = db.prepare(`
            SELECT method, COUNT(*) as count
            FROM request_logs
            WHERE timestamp >= datetime('now', '-24 hours')
            GROUP BY method
            ORDER BY count DESC
        `).all() as { method: string; count: number }[];

        // Status code breakdown (individual codes)
        const statuses = db.prepare(`
            SELECT res_status as status, COUNT(*) as count
            FROM request_logs
            WHERE timestamp >= datetime('now', '-24 hours')
              AND res_status IS NOT NULL
            GROUP BY res_status
            ORDER BY count DESC
            LIMIT 10
        `).all() as { status: number; count: number }[];

        // Average duration & error rate
        const agg = db.prepare(`
            SELECT AVG(duration_ms) as avg_dur,
                   SUM(CASE WHEN res_status >= 500 OR error IS NOT NULL THEN 1 ELSE 0 END) * 100.0 / MAX(COUNT(*), 1) as err_rate
            FROM request_logs
            WHERE timestamp >= datetime('now', '-24 hours')
        `).get() as any;

        return {
            timeline,
            methods,
            statuses,
            avgDuration: Math.round((agg?.avg_dur || 0) * 100) / 100,
            errorRate: Math.round((agg?.err_rate || 0) * 10) / 10,
        };
    } catch {
        return empty;
    }
}
