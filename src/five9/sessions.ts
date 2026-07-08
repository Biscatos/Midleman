/**
 * Five9 connector session store (SQLite).
 *
 * Mirrors src/gocontact/sessions.ts for the Five9 connector. One row per
 * (connector, chatId); sessions expire by TTL or when Five9 fires a terminate
 * callback.  The correlation_id column is the Five9 conversation UUID — used
 * to look up the session when a callback arrives carrying only that id.
 *
 * Per-session auth (tokenId, farmId, apiHost, cloudClientUrl, orgId) is stored
 * here because Five9 tokens are anonymous/per-conversation — there is no shared
 * token war as with GoContact.
 */

import { log } from '../core/logger';
import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

export interface Five9Session {
    connector: string;
    /** Session key. For Meta: "{phone_number_id}:{wa_id}"; otherwise the chatId. */
    chatId: string;
    /** Raw customer identifier (wa_id / phone) — what replies are addressed to. */
    customerId: string;
    displayName: string;
    /** Five9 conversation UUID — the callback lookup key. */
    correlationId: string;
    /** Five9 anonymous tokenId for this conversation. */
    tokenId: string;
    farmId: string;
    /** Full HTTPS API host, e.g. "https://app.nld1.eu.five9.com". */
    apiHost: string;
    cloudClientUrl: string;
    orgId: string;
    /** Business number the customer wrote to (Meta phone_number_id). */
    phoneNumberId: string;
    /** WhatsApp message id of the latest inbound — for read receipts. */
    lastInboundMsgId: string;
    autoReplied: boolean;
    createdAt: number;       // Unix ms
    lastActivityAt: number;  // Unix ms
}

let db: Database | null = null;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
    connector          TEXT NOT NULL,
    chat_id            TEXT NOT NULL,
    customer_id        TEXT NOT NULL DEFAULT '',
    display_name       TEXT NOT NULL DEFAULT '',
    correlation_id     TEXT NOT NULL DEFAULT '',
    token_id           TEXT NOT NULL DEFAULT '',
    farm_id            TEXT NOT NULL DEFAULT '',
    api_host           TEXT NOT NULL DEFAULT '',
    cloud_client_url   TEXT NOT NULL DEFAULT '',
    org_id             TEXT NOT NULL DEFAULT '',
    phone_number_id    TEXT NOT NULL DEFAULT '',
    last_inbound_msg_id TEXT NOT NULL DEFAULT '',
    auto_replied       INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    last_activity_at   INTEGER NOT NULL,
    PRIMARY KEY (connector, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_five9_sessions_activity
    ON sessions(connector, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_five9_sessions_correlation
    ON sessions(connector, correlation_id);
`;

export function initFive9Sessions(dataDir: string): void {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = resolve(dataDir, 'five9-sessions.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(CREATE_TABLE);
    log.info(`🤝 Five9 session store: ${dbPath}`);
}

export function shutdownFive9Sessions(): void {
    db?.close();
    db = null;
}

function rowToSession(r: any): Five9Session {
    return {
        connector: r.connector,
        chatId: r.chat_id,
        customerId: r.customer_id || r.chat_id,
        displayName: r.display_name,
        correlationId: r.correlation_id,
        tokenId: r.token_id,
        farmId: r.farm_id,
        apiHost: r.api_host,
        cloudClientUrl: r.cloud_client_url,
        orgId: r.org_id,
        phoneNumberId: r.phone_number_id || '',
        lastInboundMsgId: r.last_inbound_msg_id || '',
        autoReplied: !!r.auto_replied,
        createdAt: r.created_at,
        lastActivityAt: r.last_activity_at,
    };
}

export function getFive9Session(connector: string, chatId: string): Five9Session | null {
    if (!db) return null;
    const row = db.query('SELECT * FROM sessions WHERE connector = $c AND chat_id = $id')
        .get({ $c: connector, $id: chatId });
    return row ? rowToSession(row) : null;
}

/** Look up by Five9 correlationId (conversation UUID). Used in callback routing. */
export function getFive9SessionByCorrelation(connector: string, correlationId: string): Five9Session | null {
    if (!db) return null;
    const row = db.query('SELECT * FROM sessions WHERE connector = $c AND correlation_id = $cid')
        .get({ $c: connector, $cid: correlationId });
    return row ? rowToSession(row) : null;
}

export function upsertFive9Session(s: Five9Session): void {
    if (!db) return;
    db.query(`
        INSERT INTO sessions (
            connector, chat_id, customer_id, display_name, correlation_id,
            token_id, farm_id, api_host, cloud_client_url, org_id,
            phone_number_id, last_inbound_msg_id, auto_replied, created_at, last_activity_at
        ) VALUES (
            $connector, $chatId, $customerId, $displayName, $correlationId,
            $tokenId, $farmId, $apiHost, $cloudClientUrl, $orgId,
            $phoneId, $lastInbound, $autoReplied, $createdAt, $lastActivity
        )
        ON CONFLICT(connector, chat_id) DO UPDATE SET
            customer_id = $customerId,
            display_name = $displayName,
            correlation_id = $correlationId,
            token_id = $tokenId,
            farm_id = $farmId,
            api_host = $apiHost,
            cloud_client_url = $cloudClientUrl,
            org_id = $orgId,
            phone_number_id = $phoneId,
            last_inbound_msg_id = $lastInbound,
            auto_replied = $autoReplied,
            last_activity_at = $lastActivity
    `).run({
        $connector: s.connector, $chatId: s.chatId, $customerId: s.customerId,
        $displayName: s.displayName, $correlationId: s.correlationId,
        $tokenId: s.tokenId, $farmId: s.farmId, $apiHost: s.apiHost,
        $cloudClientUrl: s.cloudClientUrl, $orgId: s.orgId,
        $phoneId: s.phoneNumberId, $lastInbound: s.lastInboundMsgId,
        $autoReplied: s.autoReplied ? 1 : 0,
        $createdAt: s.createdAt, $lastActivity: s.lastActivityAt,
    });
}

export function touchFive9Session(connector: string, chatId: string): void {
    if (!db) return;
    db.query('UPDATE sessions SET last_activity_at = $now WHERE connector = $c AND chat_id = $id')
        .run({ $now: Date.now(), $c: connector, $id: chatId });
}

export function markFive9SessionAutoReplied(connector: string, chatId: string): void {
    if (!db) return;
    db.query('UPDATE sessions SET auto_replied = 1 WHERE connector = $c AND chat_id = $id')
        .run({ $c: connector, $id: chatId });
}

export function updateFive9SessionLastInbound(connector: string, chatId: string, messageId: string): void {
    if (!db) return;
    db.query('UPDATE sessions SET last_inbound_msg_id = $m WHERE connector = $c AND chat_id = $id')
        .run({ $m: messageId, $c: connector, $id: chatId });
}

export function deleteFive9Session(connector: string, chatId: string): void {
    if (!db) return;
    db.query('DELETE FROM sessions WHERE connector = $c AND chat_id = $id')
        .run({ $c: connector, $id: chatId });
}

export function listFive9Sessions(connector?: string): Five9Session[] {
    if (!db) return [];
    const rows = connector
        ? db.query('SELECT * FROM sessions WHERE connector = $c ORDER BY last_activity_at DESC').all({ $c: connector })
        : db.query('SELECT * FROM sessions ORDER BY last_activity_at DESC').all();
    return rows.map(rowToSession);
}

/** Purge sessions idle beyond the TTL. Returns removed sessions so the caller
 *  can emit expiry events. */
export function purgeFive9ExpiredSessions(connector: string, ttlMinutes: number): Five9Session[] {
    if (!db) return [];
    const cutoff = Date.now() - Math.max(5, ttlMinutes) * 60_000;
    const expired = db.query('SELECT * FROM sessions WHERE connector = $c AND last_activity_at < $cutoff')
        .all({ $c: connector, $cutoff: cutoff }).map(rowToSession);
    if (expired.length > 0) {
        db.query('DELETE FROM sessions WHERE connector = $c AND last_activity_at < $cutoff')
            .run({ $c: connector, $cutoff: cutoff });
    }
    return expired;
}

/** Remove all sessions for a connector (when the connector is deleted). */
export function deleteFive9ConnectorSessions(connector: string): number {
    if (!db) return 0;
    const res = db.query('DELETE FROM sessions WHERE connector = $c').run({ $c: connector });
    return res.changes;
}
