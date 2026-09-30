// Request-log settings: retention, default capture mode and per-resource
// overrides. Persisted to <DATA_DIR>/log-settings.json so admins can change
// them from the dashboard without touching env vars or restarting.
//
// Capture modes:
//   full        — log every request (current behaviour)
//   errors-only — only keep rows with res_status >= 400 or an error message
//                 (evidence of failures + material to re-send), everything
//                 else is dropped before it reaches SQLite
//   off         — log nothing for that resource
//
// Resolution order for a given row: per-resource mode (profile / webhook /
// connector) → global default from settings → 'full'.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

export type LogMode = 'full' | 'errors-only' | 'off';
export const LOG_MODES: readonly LogMode[] = ['full', 'errors-only', 'off'];

export function isLogMode(v: unknown): v is LogMode {
    return typeof v === 'string' && (LOG_MODES as readonly string[]).includes(v);
}

export interface LogSettings {
    /** Retention in days. null = fall back to REQUEST_LOG_RETENTION_DAYS env (default 7). */
    retentionDays: number | null;
    /** Global default capture mode when a resource has no override. */
    defaultMode: LogMode;
}

export type LogResourceKind = 'profile' | 'webhook' | 'connector';

const DEFAULTS: LogSettings = { retentionDays: null, defaultMode: 'full' };

let dataDir = process.env.DATA_DIR || resolve(process.cwd(), 'data');
let filePath = resolve(dataDir, 'log-settings.json');
let settings: LogSettings = { ...DEFAULTS };
let resolver: ((kind: LogResourceKind, name: string) => LogMode | undefined) | null = null;

export function initLogSettings(dir: string): void {
    dataDir = dir;
    filePath = resolve(dataDir, 'log-settings.json');
    try {
        if (existsSync(filePath)) {
            const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<LogSettings>;
            settings = {
                retentionDays: typeof parsed.retentionDays === 'number' && parsed.retentionDays > 0 ? Math.floor(parsed.retentionDays) : null,
                defaultMode: isLogMode(parsed.defaultMode) ? parsed.defaultMode : 'full',
            };
        }
    } catch (err) {
        console.error('⚠️  Failed to read log-settings.json, using defaults:', err);
        settings = { ...DEFAULTS };
    }
}

export function getLogSettings(): LogSettings {
    return { ...settings };
}

export function saveLogSettings(patch: Partial<LogSettings>): LogSettings {
    const next: LogSettings = { ...settings };
    if ('retentionDays' in patch) {
        const v = patch.retentionDays;
        next.retentionDays = typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
    }
    if (patch.defaultMode !== undefined && isLogMode(patch.defaultMode)) next.defaultMode = patch.defaultMode;
    settings = next;
    try {
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
        console.error('⚠️  Failed to persist log-settings.json:', err);
    }
    return { ...settings };
}

/** index.ts registers a lookup over the live profile/webhook/connector lists
 *  so the log layer never has to import them. */
export function registerLogModeResolver(fn: (kind: LogResourceKind, name: string) => LogMode | undefined): void {
    resolver = fn;
}

/** Effective mode for a resource (per-resource override → global default). */
export function resolveLogMode(kind: LogResourceKind | null, name: string | undefined | null): LogMode {
    if (kind && name && resolver) {
        try {
            const m = resolver(kind, name);
            if (m) return m;
        } catch { /* fall through to default */ }
    }
    return settings.defaultMode;
}
