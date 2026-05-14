/**
 * Raw TCP/TLS connection log — protocol-agnostic.
 *
 * One row per accepted connection: peer address, transport, bytes in/out,
 * duration, close reason. Useful for non-SIP TCP/UDP proxies (or to confirm
 * peers are reaching the listener even when no SIP messages are parsed).
 *
 * UDP is connectionless — not applicable. Listener-side only (we don't track
 * the upstream socket; that's a single shared connection per profile).
 *
 * Same batched-write pattern as request-log / sip-log: queueMicrotask flush
 * keeps the accept/close hot path off the DB.
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

export interface ConnLogConfig {
    enabled: boolean;
    dataDir: string;
    retentionDays: number;
}

const DEFAULT_CONFIG: ConnLogConfig = {
    enabled: true,
    dataDir: './data',
    retentionDays: 7,
};

let config: ConnLogConfig = { ...DEFAULT_CONFIG };
let db: Database | null = null;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS tcpudp_conn_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_at       TEXT NOT NULL,
    closed_at       TEXT,
    profile_name    TEXT NOT NULL,
    transport       TEXT NOT NULL,          -- 'tcp' | 'tls'
    peer_addr       TEXT,                   -- remote host:port
    bytes_in        INTEGER DEFAULT 0,
    bytes_out       INTEGER DEFAULT 0,
    duration_ms     INTEGER,
    close_reason    TEXT                    -- 'eof' | 'error:<msg>' | 'rejected' | null
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_conn_logs_opened ON tcpudp_conn_logs(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_conn_logs_profile ON tcpudp_conn_logs(profile_name);
`;

export function initConnLog(cfg: Partial<ConnLogConfig> = {}): void {
    config = { ...DEFAULT_CONFIG, ...cfg };
    if (!config.enabled) {
        console.log('📋 Connection logging: disabled');
        return;
    }
    mkdirSync(config.dataDir, { recursive: true });
    const dbPath = resolve(config.dataDir, 'tcpudp-conn-logs.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(CREATE_TABLE);
    db.exec(CREATE_INDEXES);
    console.log(`📋 Connection logging: enabled (retention: ${config.retentionDays}d)`);
    setInterval(purgeOld, 60 * 60 * 1000);
}

export function shutdownConnLog(): void {
    flushQueue();
    db?.close();
    db = null;
}

export interface ConnLogEntry {
    openedAt: string;       // ISO
    closedAt: string;       // ISO
    profileName: string;
    transport: 'tcp' | 'tls';
    peerAddr?: string;
    bytesIn: number;
    bytesOut: number;
    durationMs: number;
    closeReason?: string;
}

let _queue: ConnLogEntry[] = [];
let _flushScheduled = false;

const insertStmt = () => db?.prepare(`
    INSERT INTO tcpudp_conn_logs (
        opened_at, closed_at, profile_name, transport, peer_addr,
        bytes_in, bytes_out, duration_ms, close_reason
    ) VALUES (
        $openedAt, $closedAt, $profileName, $transport, $peerAddr,
        $bytesIn, $bytesOut, $durationMs, $closeReason
    )
`);

let _insertStmt: ReturnType<typeof insertStmt> | null = null;

function flushQueue(): void {
    _flushScheduled = false;
    if (_queue.length === 0 || !db) return;
    const batch = _queue.splice(0);
    try {
        if (!_insertStmt) _insertStmt = insertStmt();
        const stmt = _insertStmt!;
        db.transaction(() => {
            for (const e of batch) {
                stmt!.run({
                    $openedAt: e.openedAt,
                    $closedAt: e.closedAt,
                    $profileName: e.profileName,
                    $transport: e.transport,
                    $peerAddr: e.peerAddr || null,
                    $bytesIn: e.bytesIn,
                    $bytesOut: e.bytesOut,
                    $durationMs: e.durationMs,
                    $closeReason: e.closeReason || null,
                });
            }
        })();
    } catch (err) {
        console.error('⚠️  Failed to flush connection log queue:', err);
    }
}

export function logConnection(entry: ConnLogEntry): void {
    if (!db) return;
    _queue.push(entry);
    if (!_flushScheduled) {
        _flushScheduled = true;
        queueMicrotask(flushQueue);
    }
}

export interface ConnLogQuery {
    profileName?: string;
    transport?: 'tcp' | 'tls';
    since?: string;
    until?: string;
    page?: number;
    pageSize?: number;
}

export function queryConnLogs(q: ConnLogQuery = {}): { total: number; page: number; pageSize: number; rows: any[] } {
    if (!db) return { total: 0, page: 1, pageSize: 0, rows: [] };
    const filters: string[] = [];
    const params: Record<string, any> = {};
    if (q.profileName) { filters.push('profile_name = $profileName'); params.$profileName = q.profileName; }
    if (q.transport)   { filters.push('transport = $transport');      params.$transport = q.transport; }
    if (q.since)       { filters.push('opened_at >= $since');         params.$since = q.since; }
    if (q.until)       { filters.push('opened_at <= $until');         params.$until = q.until; }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, q.pageSize ?? 50));
    const offset = (page - 1) * pageSize;

    const total = (db.prepare(`SELECT COUNT(*) as c FROM tcpudp_conn_logs ${where}`).get(params as any) as any).c;
    const rows = db.prepare(`
        SELECT * FROM tcpudp_conn_logs ${where}
        ORDER BY id DESC LIMIT $limit OFFSET $offset
    `).all({ ...params, $limit: pageSize, $offset: offset });

    return { total, page, pageSize, rows };
}

function purgeOld(): void {
    if (!db) return;
    try {
        const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const r = db.prepare('DELETE FROM tcpudp_conn_logs WHERE opened_at < $cutoff').run({ $cutoff: cutoff });
        if ((r.changes ?? 0) > 0) {
            console.log(`📋 Connection log retention: purged ${r.changes} rows`);
        }
    } catch (err) {
        console.error('⚠️  Connection log purge failed:', err);
    }
}
