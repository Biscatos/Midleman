/**
 * SIP message log — per-message persistence for TCP/UDP SIP proxies.
 *
 * Mirrors the architecture of request-log.ts: a microtask-batched write queue
 * keeps the hot path off the SIP forwarding loop. Schema is dedicated (sip_logs)
 * because SIP's Call-ID / CSeq / From / To model does not fit the HTTP req/res
 * shape.
 *
 * UDP retransmissions are written as separate rows (one per packet). Seeing
 * retransmissions individually is useful diagnostic — repeated INVITEs with
 * the same Call-ID/CSeq/branch within ~T1 (500ms) indicate packet loss.
 *
 * PII note: From/To headers carry phone numbers / SIP URIs. Body capture
 * (SDP, etc.) is opt-in per profile (`logMessageBody`).
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import type { SipMessage } from '../sip/message';
import type { TcpUdpProfile } from '../core/types';

// ─── Config ─────────────────────────────────────────────────────────────────

export interface SipLogConfig {
    enabled: boolean;
    dataDir: string;
    retentionDays: number;
    maxBodySize: number;
}

const DEFAULT_CONFIG: SipLogConfig = {
    enabled: true,
    dataDir: './data',
    retentionDays: 7,
    maxBodySize: 64 * 1024,
};

let config: SipLogConfig = { ...DEFAULT_CONFIG };
let db: Database | null = null;

// ─── Schema ─────────────────────────────────────────────────────────────────

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sip_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    profile_name    TEXT NOT NULL,
    direction       TEXT NOT NULL,          -- 'in' (client→proxy→upstream) or 'out' (upstream→proxy→client)
    transport       TEXT NOT NULL,          -- 'udp' | 'tcp' | 'tls'
    peer_addr       TEXT,                   -- remote IP:port (best effort)
    is_request      INTEGER NOT NULL,       -- 1 = request, 0 = response
    method          TEXT,                   -- INVITE, BYE, etc. (request) or CSeq method (response)
    status_code     INTEGER,                -- response only
    reason_phrase   TEXT,                   -- response only
    call_id         TEXT,
    cseq            TEXT,                   -- "1 INVITE"
    from_uri        TEXT,
    to_uri          TEXT,
    branch          TEXT,                   -- top Via branch
    body            TEXT,                   -- captured body (SDP, etc.) if logMessageBody
    body_size       INTEGER DEFAULT 0
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sip_logs_timestamp ON sip_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sip_logs_profile ON sip_logs(profile_name);
CREATE INDEX IF NOT EXISTS idx_sip_logs_call_id ON sip_logs(call_id);
CREATE INDEX IF NOT EXISTS idx_sip_logs_method ON sip_logs(method);
CREATE INDEX IF NOT EXISTS idx_sip_logs_status ON sip_logs(status_code);
`;

// ─── Init ───────────────────────────────────────────────────────────────────

export function initSipLog(cfg: Partial<SipLogConfig> = {}): void {
    config = { ...DEFAULT_CONFIG, ...cfg };

    if (!config.enabled) {
        console.log('📋 SIP message logging: disabled');
        return;
    }

    mkdirSync(config.dataDir, { recursive: true });
    const dbPath = resolve(config.dataDir, 'sip-logs.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(CREATE_TABLE);
    db.exec(CREATE_INDEXES);

    console.log(`📋 SIP message logging: enabled (retention: ${config.retentionDays}d, max body: ${Math.round(config.maxBodySize / 1024)}KB)`);
    console.log(`   Database: ${dbPath}`);

    setInterval(purgeOldLogs, 60 * 60 * 1000);
}

export function shutdownSipLog(): void {
    flushSipLogQueue();
    db?.close();
    db = null;
}

// ─── Entry shape ────────────────────────────────────────────────────────────

export interface SipLogEntry {
    profileName: string;
    direction: 'in' | 'out';
    transport: 'udp' | 'tcp' | 'tls';
    peerAddr?: string;
    isRequest: boolean;
    method?: string;
    statusCode?: number;
    reasonPhrase?: string;
    callId?: string;
    cseq?: string;
    fromUri?: string;
    toUri?: string;
    branch?: string;
    body?: string;
    bodySize?: number;
}

// ─── Batched write queue ────────────────────────────────────────────────────

let _queue: SipLogEntry[] = [];
let _flushScheduled = false;

const insertStmt = () => db?.prepare(`
    INSERT INTO sip_logs (
        profile_name, direction, transport, peer_addr,
        is_request, method, status_code, reason_phrase,
        call_id, cseq, from_uri, to_uri, branch,
        body, body_size
    ) VALUES (
        $profileName, $direction, $transport, $peerAddr,
        $isRequest, $method, $statusCode, $reasonPhrase,
        $callId, $cseq, $fromUri, $toUri, $branch,
        $body, $bodySize
    )
`);

let _insertStmt: ReturnType<typeof insertStmt> | null = null;

function truncateBody(body: string): string {
    if (body.length <= config.maxBodySize) return body;
    return body.slice(0, config.maxBodySize) + `\n…[truncated, ${body.length - config.maxBodySize} more bytes]`;
}

function buildParams(e: SipLogEntry) {
    return {
        $profileName: e.profileName,
        $direction: e.direction,
        $transport: e.transport,
        $peerAddr: e.peerAddr || null,
        $isRequest: e.isRequest ? 1 : 0,
        $method: e.method || null,
        $statusCode: e.statusCode || null,
        $reasonPhrase: e.reasonPhrase || null,
        $callId: e.callId || null,
        $cseq: e.cseq || null,
        $fromUri: e.fromUri || null,
        $toUri: e.toUri || null,
        $branch: e.branch || null,
        $body: e.body ? truncateBody(e.body) : null,
        $bodySize: e.bodySize || 0,
    };
}

function flushSipLogQueue(): void {
    _flushScheduled = false;
    if (_queue.length === 0 || !db) return;
    const batch = _queue.splice(0);
    try {
        if (!_insertStmt) _insertStmt = insertStmt();
        const stmt = _insertStmt!;
        db.transaction(() => {
            for (const entry of batch) stmt!.run(buildParams(entry));
        })();
    } catch (err) {
        console.error('⚠️  Failed to flush SIP log queue:', err);
    }
}

export function logSipMessage(entry: SipLogEntry): void {
    if (!db) return;
    _queue.push(entry);
    if (!_flushScheduled) {
        _flushScheduled = true;
        queueMicrotask(flushSipLogQueue);
    }
}

// ─── Helper: extract entry from a parsed SipMessage ────────────────────────

const URI_DISPLAY_RE = /<([^>]+)>|([^;]+)/;

function extractUri(headerValue: string | undefined): string | undefined {
    if (!headerValue) return undefined;
    const m = headerValue.match(URI_DISPLAY_RE);
    return (m?.[1] ?? m?.[2] ?? headerValue).trim();
}

/** Should this message be logged given the profile's toggles? */
export function shouldLogSipMessage(profile: TcpUdpProfile, msg: SipMessage): boolean {
    if (!profile.logMessages && !profile.logMessageBody) return false;
    if (profile.logNoise) return true;

    // Filter noise: 100 Trying + OPTIONS keepalives
    if (!msg.isRequest && msg.statusCode === 100) return false;
    if (msg.isRequest && msg.method === 'OPTIONS') return false;
    return true;
}

export function buildSipLogEntry(
    profile: TcpUdpProfile,
    msg: SipMessage,
    direction: 'in' | 'out',
    transport: 'udp' | 'tcp' | 'tls',
    peerAddr?: string,
): SipLogEntry {
    const topVia = msg.vias[0];
    const branch = topVia?.params.get('branch');
    const bodyStr = msg.body && msg.body.length > 0 ? msg.body.toString('utf8') : undefined;

    return {
        profileName: profile.name,
        direction,
        transport,
        peerAddr,
        isRequest: msg.isRequest,
        method: msg.isRequest ? msg.method : msg.cseqMethod,
        statusCode: msg.isRequest ? undefined : msg.statusCode,
        reasonPhrase: msg.isRequest ? undefined : msg.reasonPhrase,
        callId: msg.callId,
        cseq: msg.cseq,
        fromUri: extractUri(msg.from),
        toUri: extractUri(msg.to),
        branch: typeof branch === 'string' ? branch : undefined,
        body: profile.logMessageBody ? bodyStr : undefined,
        bodySize: msg.body?.length ?? 0,
    };
}

// ─── Query API (for /admin endpoints) ──────────────────────────────────────

export interface SipLogQuery {
    profileName?: string;
    callId?: string;
    method?: string;
    direction?: 'in' | 'out';
    transport?: 'udp' | 'tcp' | 'tls';
    statusCode?: number;
    since?: string;       // ISO timestamp
    until?: string;
    page?: number;
    pageSize?: number;
}

export function querySipLogs(q: SipLogQuery = {}): { total: number; page: number; pageSize: number; rows: any[] } {
    if (!db) return { total: 0, page: 1, pageSize: 0, rows: [] };

    const filters: string[] = [];
    const params: Record<string, any> = {};

    if (q.profileName)  { filters.push('profile_name = $profileName'); params.$profileName = q.profileName; }
    if (q.callId)       { filters.push('call_id = $callId');           params.$callId = q.callId; }
    if (q.method)       { filters.push('method = $method');            params.$method = q.method; }
    if (q.direction)    { filters.push('direction = $direction');      params.$direction = q.direction; }
    if (q.transport)    { filters.push('transport = $transport');      params.$transport = q.transport; }
    if (q.statusCode)   { filters.push('status_code = $statusCode');   params.$statusCode = q.statusCode; }
    if (q.since)        { filters.push('timestamp >= $since');         params.$since = q.since; }
    if (q.until)        { filters.push('timestamp <= $until');         params.$until = q.until; }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, q.pageSize ?? 50));
    const offset = (page - 1) * pageSize;

    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM sip_logs ${where}`).get(params as any) as { total: number };
    const rows = db.prepare(`
        SELECT id, timestamp, profile_name, direction, transport, peer_addr,
               is_request, method, status_code, reason_phrase,
               call_id, cseq, from_uri, to_uri, branch, body_size
        FROM sip_logs
        ${where}
        ORDER BY id DESC
        LIMIT $limit OFFSET $offset
    `).all({ ...params, $limit: pageSize, $offset: offset });

    return { total: totalRow.total, page, pageSize, rows };
}

export function getSipLogDetail(id: number): any | null {
    if (!db) return null;
    return db.prepare(`SELECT * FROM sip_logs WHERE id = $id`).get({ $id: id }) ?? null;
}

export function getSipLogStats(): { total: number; sizeBytes: number; oldest: string | null } {
    if (!db) return { total: 0, sizeBytes: 0, oldest: null };
    const total = (db.prepare('SELECT COUNT(*) as c FROM sip_logs').get() as any)?.c ?? 0;
    const oldest = (db.prepare("SELECT MIN(timestamp) as t FROM sip_logs").get() as any)?.t ?? null;
    const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count || 0;
    const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size || 4096;
    return { total, sizeBytes: pageCount * pageSize, oldest };
}

// ─── Retention ─────────────────────────────────────────────────────────────

function purgeOldLogs(): void {
    if (!db) return;
    try {
        const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const result = db.prepare('DELETE FROM sip_logs WHERE timestamp < $cutoff').run({ $cutoff: cutoff });
        if ((result.changes ?? 0) > 0) {
            console.log(`📋 SIP log retention: purged ${result.changes} entries older than ${config.retentionDays}d`);
        }
    } catch (err) {
        console.error('⚠️  SIP log purge failed:', err);
    }
}
