/**
 * GoContact webchat session store (SQLite).
 *
 * Replaces the Redis cache of the original C# integration: one row per
 * (connector, chatId) holding the GoContact handles needed to keep talking
 * inside the same webchat dialog — bearer token, accessKey, dialogGroupUuid.
 *
 * Sessions expire by inactivity (TTL, default 2h like the original) or when
 * the agent sends LEAVE. Surviving restarts matters: the poller resumes
 * reading agent replies for every active session after a reboot.
 */

import { log } from '../core/logger';
import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

export interface ConnectorSession {
    connector: string;
    /** Session key. For Meta this is "{phone_number_id}:{wa_id}" so the same
     *  customer talking to several business numbers gets one GoContact chat
     *  per number; for channels without a business number it is the chat id. */
    chatId: string;
    /** The customer's own id (e.g. WhatsApp wa_id) — what replies are sent to. */
    customerId: string;
    displayName: string;
    // NOTE: no per-session token — the bearer token is shared per login user
    // (see token-manager.ts). GoContact invalidates a user's previous token on
    // each auth, so a per-session token would self-destruct under concurrency.
    domainUuid: string;
    accessKey: string;
    dialogGroupUuid: string;
    dialogGroupId: string;
    /** Business number that received the inbound messages (Meta). Empty for
     *  channels that don't carry one. */
    phoneNumberId: string;
    /** Channel message id of the customer's latest inbound message (e.g. the
     *  WhatsApp wamid) — used to send a read receipt when the agent replies. */
    lastInboundMsgId: string;
    /** True once the connector's auto-reply fired for this session. */
    autoReplied: boolean;
    createdAt: number;         // Unix ms
    lastActivityAt: number;    // Unix ms — bumped on every send/receive
}

let db: Database | null = null;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
    connector         TEXT NOT NULL,
    chat_id           TEXT NOT NULL,
    display_name      TEXT NOT NULL DEFAULT '',
    token             TEXT NOT NULL,
    token_expires_at  INTEGER NOT NULL,
    domain_uuid       TEXT NOT NULL,
    access_key        TEXT NOT NULL,
    dialog_group_uuid TEXT NOT NULL,
    dialog_group_id   TEXT NOT NULL DEFAULT '',
    phone_number_id   TEXT NOT NULL DEFAULT '',
    customer_id       TEXT NOT NULL DEFAULT '',
    auto_replied      INTEGER NOT NULL DEFAULT 0,
    last_inbound_msg_id TEXT NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL,
    last_activity_at  INTEGER NOT NULL,
    PRIMARY KEY (connector, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(connector, last_activity_at);

-- Out-of-hours reply de-dup. Kept SEPARATE from sessions because the
-- "reply-only" mode never creates a session, so there is no session row to
-- carry the flag. One row per (connector, session-key) with the last time the
-- out-of-hours message was sent, used to throttle to once per anti-spam window.
CREATE TABLE IF NOT EXISTS out_of_hours_replies (
    connector     TEXT NOT NULL,
    chat_id       TEXT NOT NULL,
    last_sent_at  INTEGER NOT NULL,
    PRIMARY KEY (connector, chat_id)
);
`;

export function initConnectorSessions(dataDir: string): void {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = resolve(dataDir, 'gocontact-sessions.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(CREATE_TABLE);
    // Migration for stores created before phone_number_id existed.
    try { db.exec("ALTER TABLE sessions ADD COLUMN phone_number_id TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
    try { db.exec("ALTER TABLE sessions ADD COLUMN last_inbound_msg_id TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
    try { db.exec("ALTER TABLE sessions ADD COLUMN customer_id TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
    try { db.exec("ALTER TABLE sessions ADD COLUMN auto_replied INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
    log.info(`💬 GoContact session store: ${dbPath}`);
}

export function shutdownConnectorSessions(): void {
    db?.close();
    db = null;
}

function rowToSession(r: any): ConnectorSession {
    return {
        connector: r.connector,
        chatId: r.chat_id,
        customerId: r.customer_id || r.chat_id,
        displayName: r.display_name,
        domainUuid: r.domain_uuid,
        accessKey: r.access_key,
        dialogGroupUuid: r.dialog_group_uuid,
        dialogGroupId: r.dialog_group_id,
        phoneNumberId: r.phone_number_id || '',
        lastInboundMsgId: r.last_inbound_msg_id || '',
        autoReplied: !!r.auto_replied,
        createdAt: r.created_at,
        lastActivityAt: r.last_activity_at,
    };
}

export function getSession(connector: string, chatId: string): ConnectorSession | null {
    if (!db) return null;
    const row = db.query('SELECT * FROM sessions WHERE connector = $c AND chat_id = $id')
        .get({ $c: connector, $id: chatId });
    return row ? rowToSession(row) : null;
}

export function upsertSession(s: ConnectorSession): void {
    if (!db) return;
    // The legacy token/token_expires_at columns are NOT NULL; write placeholders
    // (the token is no longer persisted per session — see token-manager.ts).
    db.query(`
        INSERT INTO sessions (connector, chat_id, display_name, token, token_expires_at, domain_uuid,
                              access_key, dialog_group_uuid, dialog_group_id, phone_number_id, customer_id, last_inbound_msg_id, created_at, last_activity_at)
        VALUES ($connector, $chatId, $displayName, '', 0, $domainUuid,
                $accessKey, $dgUuid, $dgId, $phoneId, $customerId, $lastInbound, $createdAt, $lastActivity)
        ON CONFLICT(connector, chat_id) DO UPDATE SET
            display_name = $displayName,
            domain_uuid = $domainUuid, access_key = $accessKey,
            dialog_group_uuid = $dgUuid, dialog_group_id = $dgId,
            phone_number_id = $phoneId, customer_id = $customerId, last_inbound_msg_id = $lastInbound, last_activity_at = $lastActivity
    `).run({
        $connector: s.connector, $chatId: s.chatId, $customerId: s.customerId, $displayName: s.displayName,
        $domainUuid: s.domainUuid, $accessKey: s.accessKey,
        $dgUuid: s.dialogGroupUuid, $dgId: s.dialogGroupId, $phoneId: s.phoneNumberId,
        $lastInbound: s.lastInboundMsgId,
        $createdAt: s.createdAt, $lastActivity: s.lastActivityAt,
    });
}

export function touchSession(connector: string, chatId: string): void {
    if (!db) return;
    db.query('UPDATE sessions SET last_activity_at = $now WHERE connector = $c AND chat_id = $id')
        .run({ $now: Date.now(), $c: connector, $id: chatId });
}

export function markSessionAutoReplied(connector: string, chatId: string): void {
    if (!db) return;
    db.query('UPDATE sessions SET auto_replied = 1 WHERE connector = $c AND chat_id = $id')
        .run({ $c: connector, $id: chatId });
}

export function updateSessionLastInbound(connector: string, chatId: string, messageId: string): void {
    if (!db) return;
    db.query('UPDATE sessions SET last_inbound_msg_id = $m WHERE connector = $c AND chat_id = $id')
        .run({ $m: messageId, $c: connector, $id: chatId });
}

/** Unix ms of the last out-of-hours reply sent to this (connector, chatId), or
 *  0 if none. Used to throttle the out-of-hours auto-reply per customer. */
export function getOutOfHoursLastSent(connector: string, chatId: string): number {
    if (!db) return 0;
    const row = db.query('SELECT last_sent_at FROM out_of_hours_replies WHERE connector = $c AND chat_id = $id')
        .get({ $c: connector, $id: chatId }) as { last_sent_at: number } | null;
    return row ? row.last_sent_at : 0;
}

/** Record that an out-of-hours reply was sent to (connector, chatId) at `ts`. */
export function markOutOfHoursSent(connector: string, chatId: string, ts: number): void {
    if (!db) return;
    db.query(`INSERT INTO out_of_hours_replies (connector, chat_id, last_sent_at)
              VALUES ($c, $id, $t)
              ON CONFLICT(connector, chat_id) DO UPDATE SET last_sent_at = $t`)
        .run({ $c: connector, $id: chatId, $t: ts });
}

export function deleteSession(connector: string, chatId: string): void {
    if (!db) return;
    db.query('DELETE FROM sessions WHERE connector = $c AND chat_id = $id')
        .run({ $c: connector, $id: chatId });
}

/** Active (non-expired) sessions for a connector — what the poller iterates. */
export function listActiveSessions(connector: string, ttlMinutes: number): ConnectorSession[] {
    if (!db) return [];
    const cutoff = Date.now() - Math.max(5, ttlMinutes) * 60_000;
    const rows = db.query('SELECT * FROM sessions WHERE connector = $c AND last_activity_at >= $cutoff')
        .all({ $c: connector, $cutoff: cutoff });
    return rows.map(rowToSession);
}

/** All sessions for the dashboard (including possibly-stale ones). */
export function listSessions(connector?: string): ConnectorSession[] {
    if (!db) return [];
    const rows = connector
        ? db.query('SELECT * FROM sessions WHERE connector = $c ORDER BY last_activity_at DESC').all({ $c: connector })
        : db.query('SELECT * FROM sessions ORDER BY last_activity_at DESC').all();
    return rows.map(rowToSession);
}

/** Purge sessions idle for longer than the TTL. Returns the removed sessions
 *  so the caller can emit expiry events for each. */
export function purgeExpiredSessions(connector: string, ttlMinutes: number): ConnectorSession[] {
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

/** Remove every session of a connector (when the connector is deleted). */
export function deleteConnectorSessions(connector: string): number {
    if (!db) return 0;
    const res = db.query('DELETE FROM sessions WHERE connector = $c').run({ $c: connector });
    db.query('DELETE FROM out_of_hours_replies WHERE connector = $c').run({ $c: connector });
    return res.changes;
}
