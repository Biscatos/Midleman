/**
 * Backend error feed — captures every error/warning raised anywhere in the
 * process and exposes it to the dashboard ("System Alerts" page).
 *
 * Why a console monkey-patch instead of an opt-in logger:
 * `core/logger.ts` is opt-in (11 modules import it) while ~130 bare
 * `console.error`/`console.warn` calls live across the codebase — plus
 * anything thrown from inside dependencies. Patching the console object at
 * boot is the only chokepoint that sees all of them. `process.on(
 * 'uncaughtException'|'unhandledRejection')` covers what never reaches the
 * console at all.
 *
 * Entries are deduplicated by fingerprint (severity + normalised message +
 * top stack frame): a flapping connector becomes one row with a count, not
 * ten thousand rows. Storage is SQLite in its own file so it survives
 * restarts without touching the auth schema/migrations.
 *
 *   install()   → call once, first thing in index.ts
 *   record()    → manual capture (structured, with source/context)
 *   queryErrors / ackErrors / clearErrors → admin API surface
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');

/** Rows kept in the table. Oldest-by-lastSeen are pruned past this. */
const MAX_ROWS = 2000;
/** Entries older than this (by lastSeen) are pruned on write. */
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export type ErrorSeverity = 'error' | 'warn';

export interface ErrorEntry {
    id: number;
    fingerprint: string;
    severity: ErrorSeverity;
    source: string;
    message: string;
    stack: string | null;
    context: string | null;
    count: number;
    firstSeen: number;
    lastSeen: number;
    acknowledged: boolean;
    acknowledgedAt: number | null;
    acknowledgedBy: string | null;
}

// ─── Storage ────────────────────────────────────────────────────────────────

let _db: Database | null = null;

function db(): Database {
    if (_db) return _db;
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    _db = new Database(resolve(DATA_DIR, 'error-feed.db'), { create: true });
    _db.run('PRAGMA journal_mode = WAL');
    _db.run(`
        CREATE TABLE IF NOT EXISTS error_events (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            fingerprint     TEXT    NOT NULL UNIQUE,
            severity        TEXT    NOT NULL,
            source          TEXT    NOT NULL,
            message         TEXT    NOT NULL,
            stack           TEXT,
            context         TEXT,
            count           INTEGER NOT NULL DEFAULT 1,
            first_seen      INTEGER NOT NULL,
            last_seen       INTEGER NOT NULL,
            acknowledged    INTEGER NOT NULL DEFAULT 0,
            acknowledged_at INTEGER,
            acknowledged_by TEXT
        )
    `);
    _db.run('CREATE INDEX IF NOT EXISTS idx_error_last_seen ON error_events(last_seen DESC)');
    _db.run('CREATE INDEX IF NOT EXISTS idx_error_ack ON error_events(acknowledged, severity)');
    return _db;
}

// ─── Redaction ──────────────────────────────────────────────────────────────
// Stack traces and error messages routinely carry credentials (LDAP binds,
// SMTP passwords, GoContact tokens, URLs with userinfo). This page is stored
// on disk and rendered in the browser, so scrub before persisting.

type Redaction = [RegExp, string] | [RegExp, (...m: any[]) => string];

const REDACTIONS: Redaction[] = [
    // scheme://user:pass@host
    [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
    // Authorization: Bearer/Basic <token>
    [/\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '$1 ***'],
    // key=value style secrets in messages / query strings
    [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|cookie|session)\b(\s*[:=]\s*|"\s*:\s*")([^\s,;&"'}]+)/gi,
        (_m, k: string, sep: string) => `${k}${sep}***`],
    // bare JWTs
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '***jwt***'],
];

export function redact(s: string): string {
    let out = s;
    for (const [re, rep] of REDACTIONS) out = out.replace(re, rep as any);
    return out;
}

// ─── Fingerprinting ─────────────────────────────────────────────────────────
// Numbers, hex ids, UUIDs, quoted names and timestamps vary between otherwise
// identical failures — strip them so "connect ECONNREFUSED 10.0.0.4:5432" and
// the same error a second later collapse into one row.

function normalise(msg: string): string {
    return msg
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, '<ts>')
        .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
        .replace(/\d+/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

function topFrame(stack: string | null): string {
    if (!stack) return '';
    for (const line of stack.split('\n')) {
        const t = line.trim();
        if (t.startsWith('at ')) return t.replace(/:\d+:\d+\)?$/, '').slice(0, 200);
    }
    return '';
}

function fingerprintOf(severity: string, source: string, message: string, stack: string | null): string {
    // Bun exposes Bun.hash; fall back to a cheap FNV-1a if it ever isn't there.
    const key = `${severity}|${source}|${normalise(message)}|${topFrame(stack)}`;
    try {
        return String((globalThis as any).Bun.hash(key));
    } catch {
        let h = 0x811c9dc5;
        for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return String(h);
    }
}

// ─── Source inference ───────────────────────────────────────────────────────
// Derives a coarse subsystem tag ("gocontact", "sip", "npm", …) from the call
// site so the page can be filtered by area.

const KNOWN_SOURCES = [
    'gocontact', 'five9', 'reports', 'npm', 'sip', 'proxy', 'webhook',
    'connector', 'auth', 'ldap', 'oauth', 'smtp', 'sms', 'telemetry',
    'notifications', 'certs', 'core',
];

function inferSource(stack: string | null): string {
    if (!stack) return 'runtime';
    const m = stack.match(/(?:src[\\/])([a-z0-9-]+)[\\/]/i);
    if (m && KNOWN_SOURCES.includes(m[1]!.toLowerCase())) return m[1]!.toLowerCase();
    const f = stack.match(/([a-z0-9-]+)-server\.ts/i);
    if (f) return f[1]!.toLowerCase();
    return 'runtime';
}

// ─── Recording ──────────────────────────────────────────────────────────────

// Guards against the capture path logging its own failures back into itself,
// which would recurse until the stack blows.
let _reentrant = false;

let _lastErrorAt = 0;
let _totalCaptured = 0;

export interface RecordInput {
    severity: ErrorSeverity;
    message: string;
    stack?: string | null;
    /** Subsystem tag. Inferred from the stack when omitted. */
    source?: string;
    /** Extra structured detail shown in the row's expanded view. */
    context?: Record<string, unknown> | string | null;
}

/** Capture one error/warning. Never throws — a broken feed must not break the
 *  code path that raised the error. */
export function record(input: RecordInput): void {
    if (_reentrant) return;
    _reentrant = true;
    try {
        const now = Date.now();
        const message = redact(String(input.message || '')).slice(0, 4000);
        if (!message) return;
        const stack = input.stack ? redact(String(input.stack)).slice(0, 8000) : null;
        const source = (input.source || inferSource(stack)).slice(0, 40);
        const context = input.context == null
            ? null
            : redact(typeof input.context === 'string' ? input.context : safeJson(input.context)).slice(0, 4000);
        const fp = fingerprintOf(input.severity, source, message, stack);

        db().run(
            `INSERT INTO error_events (fingerprint, severity, source, message, stack, context, count, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(fingerprint) DO UPDATE SET
               count        = count + 1,
               last_seen    = excluded.last_seen,
               stack        = COALESCE(excluded.stack, stack),
               context      = COALESCE(excluded.context, context),
               -- A recurrence un-acknowledges the entry: the problem is back.
               acknowledged = 0,
               acknowledged_at = NULL,
               acknowledged_by = NULL`,
            [fp, input.severity, source, message, stack, context, now, now],
        );

        _totalCaptured++;
        if (input.severity === 'error') _lastErrorAt = now;
        // Prune cheaply — only every so often, not on every single capture.
        if (_totalCaptured % 50 === 0) prune();
    } catch {
        // Swallow: the feed is best-effort observability, never a failure mode.
    } finally {
        _reentrant = false;
    }
}

function safeJson(v: unknown): string {
    try { return JSON.stringify(v); } catch { return String(v); }
}

function prune(): void {
    try {
        const cutoff = Date.now() - RETENTION_MS;
        db().run('DELETE FROM error_events WHERE last_seen < ?', [cutoff]);
        db().run(
            `DELETE FROM error_events WHERE id NOT IN (
                 SELECT id FROM error_events ORDER BY last_seen DESC LIMIT ?
             )`,
            [MAX_ROWS],
        );
    } catch { /* best effort */ }
}

// ─── Install (console patch + process hooks) ────────────────────────────────

let _installed = false;

/** Patch console.error/console.warn and register process-level handlers.
 *  Idempotent; call once at the very top of index.ts. */
export function install(): void {
    if (_installed) return;
    _installed = true;

    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);

    const capture = (severity: ErrorSeverity, args: unknown[]) => {
        // Prefer a real Error's stack; otherwise synthesise one so we still
        // know where the log came from (used for source inference).
        const err = args.find(a => a instanceof Error) as Error | undefined;
        const stack = err?.stack || new Error().stack?.split('\n').slice(3).join('\n') || null;
        record({ severity, message: args.map(fmtArg).join(' '), stack });
    };

    console.error = (...args: unknown[]) => { capture('error', args); origError(...args); };
    console.warn = (...args: unknown[]) => { capture('warn', args); origWarn(...args); };

    // 'uncaughtExceptionMonitor' — NOT 'uncaughtException'. Registering the
    // latter would suppress the runtime's default crash-and-exit, silently
    // turning fatal errors into a process limping along in an unknown state.
    // The monitor variant observes and lets the default behaviour stand.
    process.on('uncaughtExceptionMonitor', (err: Error) => {
        record({ severity: 'error', source: 'runtime', message: `uncaughtException: ${err?.message || err}`, stack: err?.stack || null });
    });

    // No 'monitor' variant exists for rejections, so this listener does change
    // behaviour: the runtime no longer terminates on an unhandled rejection.
    // For a long-running proxy that's the safer trade — one orphaned promise
    // shouldn't take down every active tunnel — and the failure is now visible
    // on the dashboard rather than silently fatal.
    process.on('unhandledRejection', (reason: unknown) => {
        const e = reason instanceof Error ? reason : null;
        record({
            severity: 'error',
            source: 'runtime',
            message: `unhandledRejection: ${e?.message || safeJson(reason)}`,
            stack: e?.stack || null,
        });
        origError('❌ unhandledRejection:', reason);
    });
}

// Self-install on module evaluation. ES imports are hoisted, so an explicit
// install() call at the top of index.ts would still run *after* every other
// module's top-level code. Being the first import in index.ts, evaluating
// here is what actually gets the patch in before anything can throw.
install();

function fmtArg(a: unknown): string {
    if (a instanceof Error) return a.message || String(a);
    if (typeof a === 'string') return a;
    if (a === null || a === undefined) return String(a);
    if (typeof a === 'object') return safeJson(a);
    return String(a);
}

// ─── Query surface (admin API) ──────────────────────────────────────────────

export interface ErrorQuery {
    page?: number;
    limit?: number;
    severity?: ErrorSeverity;
    source?: string;
    search?: string;
    /** 'open' (default) hides acknowledged rows; 'all' shows everything. */
    state?: 'open' | 'acked' | 'all';
}

interface Row {
    id: number; fingerprint: string; severity: string; source: string;
    message: string; stack: string | null; context: string | null;
    count: number; first_seen: number; last_seen: number;
    acknowledged: number; acknowledged_at: number | null; acknowledged_by: string | null;
}

function toEntry(r: Row): ErrorEntry {
    return {
        id: r.id,
        fingerprint: r.fingerprint,
        severity: r.severity as ErrorSeverity,
        source: r.source,
        message: r.message,
        stack: r.stack,
        context: r.context,
        count: r.count,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        acknowledged: !!r.acknowledged,
        acknowledgedAt: r.acknowledged_at,
        acknowledgedBy: r.acknowledged_by,
    };
}

export function queryErrors(q: ErrorQuery = {}): { entries: ErrorEntry[]; total: number; page: number; limit: number } {
    const page = Math.max(1, q.page || 1);
    const limit = Math.min(200, Math.max(1, q.limit || 50));
    const where: string[] = [];
    const params: any[] = [];

    const state = q.state || 'open';
    if (state === 'open') where.push('acknowledged = 0');
    else if (state === 'acked') where.push('acknowledged = 1');

    if (q.severity) { where.push('severity = ?'); params.push(q.severity); }
    if (q.source) { where.push('source = ?'); params.push(q.source); }
    if (q.search) { where.push('(message LIKE ? OR stack LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    try {
        const total = (db().query<{ n: number }, any[]>(`SELECT COUNT(*) AS n FROM error_events ${clause}`).get(...params))?.n || 0;
        const rows = db().query<Row, any[]>(
            `SELECT * FROM error_events ${clause} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
        ).all(...params, limit, (page - 1) * limit);
        return { entries: rows.map(toEntry), total, page, limit };
    } catch {
        return { entries: [], total: 0, page, limit };
    }
}

export interface ErrorStats {
    openErrors: number;
    openWarnings: number;
    /** Distinct sources with at least one open entry, most recent first. */
    sources: Array<{ source: string; open: number }>;
    lastErrorAt: number | null;
    /** Newest unacknowledged error — lets the UI toast on first appearance. */
    latestId: number | null;
}

export function getErrorStats(): ErrorStats {
    try {
        const d = db();
        const openErrors = d.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM error_events WHERE acknowledged = 0 AND severity = 'error'`).get()?.n || 0;
        const openWarnings = d.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM error_events WHERE acknowledged = 0 AND severity = 'warn'`).get()?.n || 0;
        const sources = d.query<{ source: string; open: number }, []>(
            `SELECT source, COUNT(*) AS open FROM error_events WHERE acknowledged = 0 GROUP BY source ORDER BY open DESC`,
        ).all();
        const latest = d.query<{ id: number; last_seen: number }, []>(
            `SELECT id, last_seen FROM error_events WHERE acknowledged = 0 AND severity = 'error' ORDER BY last_seen DESC LIMIT 1`,
        ).get();
        return {
            openErrors,
            openWarnings,
            sources,
            lastErrorAt: latest?.last_seen ?? (_lastErrorAt || null),
            latestId: latest?.id ?? null,
        };
    } catch {
        return { openErrors: 0, openWarnings: 0, sources: [], lastErrorAt: null, latestId: null };
    }
}

export function getError(id: number): ErrorEntry | null {
    try {
        const r = db().query<Row, [number]>('SELECT * FROM error_events WHERE id = ?').get(id);
        return r ? toEntry(r) : null;
    } catch { return null; }
}

/** Acknowledge specific ids, or every open entry when `ids` is empty. */
export function ackErrors(ids: number[], by: string | null): number {
    try {
        const now = Date.now();
        if (!ids.length) {
            const before = getErrorStats();
            db().run('UPDATE error_events SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ? WHERE acknowledged = 0', [now, by]);
            return before.openErrors + before.openWarnings;
        }
        const placeholders = ids.map(() => '?').join(',');
        db().run(
            `UPDATE error_events SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ? WHERE id IN (${placeholders}) AND acknowledged = 0`,
            [now, by, ...ids],
        );
        return ids.length;
    } catch { return 0; }
}

/** Delete entries permanently. Empty `ids` clears the whole feed. */
export function clearErrors(ids: number[]): number {
    try {
        if (!ids.length) {
            const n = db().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM error_events').get()?.n || 0;
            db().run('DELETE FROM error_events');
            return n;
        }
        const placeholders = ids.map(() => '?').join(',');
        db().run(`DELETE FROM error_events WHERE id IN (${placeholders})`, ids);
        return ids.length;
    } catch { return 0; }
}
