import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

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
    type            TEXT NOT NULL,          -- 'target' or 'proxy'
    profile_name    TEXT,                   -- null for target requests
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
`;

const MIGRATIONS = [
    // Add target_name column for multi-target support
    `ALTER TABLE request_logs ADD COLUMN target_name TEXT`,
];

// ─── Initialization ─────────────────────────────────────────────────────────

export function initRequestLog(cfg: Partial<RequestLogConfig> = {}): void {
    config = { ...DEFAULT_CONFIG, ...cfg };

    if (!config.enabled) {
        console.log('📋 Request logging: disabled');
        return;
    }

    const dbPath = resolve(config.dataDir, 'request-logs.db');

    try {
        mkdirSync(config.dataDir, { recursive: true });
        db = new Database(dbPath, { create: true });
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec(CREATE_TABLE);

        // Run migrations before indexes (ignore errors for already-applied migrations)
        for (const migration of MIGRATIONS) {
            try { db.exec(migration); } catch {}
        }

        db.exec(CREATE_INDEXES);

        // Schedule auto-purge every hour
        purgeOldLogs();
        setInterval(purgeOldLogs, 60 * 60 * 1000);

        console.log(`📋 Request logging: enabled (retention: ${config.retentionDays}d, max body: ${(config.maxBodySize / 1024).toFixed(0)}KB)`);
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
    type: 'target' | 'proxy' | 'webhook' | 'webhook-fanout';
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
}

const insertStmt = () => db?.prepare(`
    INSERT INTO request_logs (
        request_id, type, profile_name, target_name, method, path, target_url, client_ip,
        req_headers, req_body, req_body_size,
        res_status, res_status_text, res_headers, res_body, res_body_size,
        duration_ms, error
    ) VALUES (
        $requestId, $type, $profileName, $targetName, $method, $path, $targetUrl, $clientIp,
        $reqHeaders, $reqBody, $reqBodySize,
        $resStatus, $resStatusText, $resHeaders, $resBody, $resBodySize,
        $durationMs, $error
    )
`);

let _insertStmt: ReturnType<typeof insertStmt> | null = null;

export function logRequest(entry: RequestLogEntry): void {
    if (!db) return;

    try {
        if (!_insertStmt) _insertStmt = insertStmt();

        _insertStmt?.run({
            $requestId: entry.requestId,
            $type: entry.type,
            $profileName: entry.profileName || null,
            $targetName: entry.targetName || null,
            $method: entry.method,
            $path: entry.path,
            $targetUrl: entry.targetUrl,
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
            $error: entry.error || null,
        });
    } catch (err) {
        console.error('⚠️  Failed to log request:', err);
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

        // Skip cloning when size is unknown (chunked) or known to be large —
        // cloning forces Bun to buffer the entire body in memory which causes
        // "Maximum response size reached" on large or streaming responses.
        if (contentLength < 0 || contentLength > 64 * 1024) {
            const sizeLabel = contentLength >= 0 ? `${contentLength} bytes` : 'unknown size';
            return { body: `[response body not captured: ${sizeLabel}]`, size: contentLength >= 0 ? contentLength : 0 };
        }

        const clone = res.clone();
        const text = await clone.text();
        return { body: text, size: text.length };
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

export function headersToRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}

// ─── Query API ──────────────────────────────────────────────────────────────

export interface RequestLogQuery {
    page?: number;
    limit?: number;
    type?: 'target' | 'proxy' | 'webhook';
    profileName?: string;
    targetName?: string;
    method?: string;
    status?: number;
    search?: string;          // search in path, target_url, request_id
    from?: string;            // ISO date
    to?: string;              // ISO date
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
}

export interface RequestLogDetail extends RequestLogSummary {
    reqHeaders: string | null;
    reqBody: string | null;
    resHeaders: string | null;
    resBody: string | null;
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
    if (query.search) {
        conditions.push('(path LIKE $search OR target_url LIKE $search OR request_id LIKE $search OR profile_name LIKE $search OR target_name LIKE $search)');
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

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM request_logs ${where}`).get(params as any) as { total: number };
    const total = countRow?.total || 0;

    const rows = db.prepare(`
        SELECT id, request_id, timestamp, type, profile_name, target_name, method, path, target_url,
               client_ip, req_body, res_status, res_status_text, duration_ms, req_body_size, res_body_size, error
        FROM request_logs ${where}
        ORDER BY id DESC
        LIMIT $limit OFFSET $offset
    `).all({ ...params, $limit: limit, $offset: offset } as any) as any[];

    return {
        requests: rows.map(r => ({
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
            reqBody: r.req_body,
            resStatus: r.res_status,
            resStatusText: r.res_status_text,
            durationMs: r.duration_ms,
            reqBodySize: r.req_body_size,
            resBodySize: r.res_body_size,
            error: r.error,
        })),
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
               duration_ms, error
        FROM request_logs WHERE id = $id
    `).get({ $id: id }) as any;

    if (!row) return null;

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
    };
}

// ─── Purge ──────────────────────────────────────────────────────────────────

function purgeOldLogs(): void {
    if (!db) return;
    try {
        const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const result = db.prepare('DELETE FROM request_logs WHERE timestamp < $cutoff').run({ $cutoff: cutoff });
        if ((result as any).changes > 0) {
            console.log(`🧹 Purged ${(result as any).changes} request log(s) older than ${config.retentionDays} days`);
        }
    } catch (err) {
        console.error('⚠️  Failed to purge old request logs:', err);
    }
}

export function getRequestLogStats(): { total: number; oldest: string | null; newest: string | null; dbSizeMB: number } {
    if (!db) return { total: 0, oldest: null, newest: null, dbSizeMB: 0 };

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

        return {
            total: stats?.total || 0,
            oldest: stats?.oldest || null,
            newest: stats?.newest || null,
            dbSizeMB,
        };
    } catch {
        return { total: 0, oldest: null, newest: null, dbSizeMB: 0 };
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
        const timeline = db.prepare(`
            SELECT strftime('%Y-%m-%dT%H:', timestamp) ||
                   CASE WHEN CAST(strftime('%M', timestamp) AS INTEGER) < 30 THEN '00' ELSE '30' END AS bucket,
                   COUNT(*) as count,
                   SUM(CASE WHEN res_status >= 500 OR error IS NOT NULL THEN 1 ELSE 0 END) as errors
            FROM request_logs
            WHERE timestamp >= datetime('now', '-24 hours')
            GROUP BY bucket
            ORDER BY bucket ASC
        `).all() as { bucket: string; count: number; errors: number }[];

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
