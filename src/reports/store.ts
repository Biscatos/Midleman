import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import type { ReportFeed, DateRangeConfig } from './types';

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const FEEDS_FILE = resolve(DATA_DIR, 'report-feeds.json');

function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadPersistedReportFeeds(): ReportFeed[] {
    try {
        if (!existsSync(FEEDS_FILE)) return [];
        const raw = readFileSync(FEEDS_FILE, 'utf-8');
        const feeds: ReportFeed[] = JSON.parse(raw);
        return feeds
            .filter(f => f.name && f.baseUrl && f.username && f.password && f.templateId)
            .map(f => ({ ...f, name: f.name.toLowerCase() }));
    } catch (err) {
        console.warn('⚠️  Could not load report-feeds.json:', err instanceof Error ? err.message : err);
        return [];
    }
}

export function persistReportFeeds(feeds: ReportFeed[]): void {
    try {
        ensureDataDir();
        writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Could not save report-feeds.json:', err instanceof Error ? err.message : err);
        throw err;
    }
}

export function validateReportFeedInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';
    const f = input as Record<string, unknown>;

    if (!f.name || typeof f.name !== 'string') return '"name" is required (string)';
    if (!/^[a-z0-9_-]+$/.test(f.name)) return '"name" must only contain lowercase letters, numbers, hyphens and underscores';
    if (f.name.length < 2 || f.name.length > 48) return '"name" must be 2–48 characters';

    if (!f.baseUrl || typeof f.baseUrl !== 'string') return '"baseUrl" is required (string)';
    try { new URL(f.baseUrl as string); } catch { return '"baseUrl" must be a valid URL'; }

    if (!f.username || typeof f.username !== 'string') return '"username" is required (string)';
    if (!f.password || typeof f.password !== 'string') return '"password" is required (string)';
    if (!f.templateId || typeof f.templateId !== 'string') return '"templateId" is required (string)';

    if (!f.ownerType || !['campaign', 'queue', 'user'].includes(f.ownerType as string))
        return '"ownerType" must be "campaign", "queue" or "user"';

    if (!Array.isArray(f.ownerIds) || f.ownerIds.length === 0)
        return '"ownerIds" must be a non-empty array of strings';
    if (f.ownerIds.some((id: unknown) => typeof id !== 'string'))
        return '"ownerIds" entries must be strings';

    // dateRange
    if (!f.dateRange || typeof f.dateRange !== 'object') return '"dateRange" is required';
    const dr = f.dateRange as Record<string, unknown>;
    if (dr.type === 'relative') {
        if (typeof dr.days !== 'number' || dr.days < 1 || dr.days > 3650)
            return '"dateRange.days" must be 1–3650';
    } else if (dr.type === 'fixed') {
        if (!dr.startDate || !dr.endDate || typeof dr.startDate !== 'string' || typeof dr.endDate !== 'string')
            return '"dateRange.startDate" and "dateRange.endDate" are required for fixed range';
    } else {
        return '"dateRange.type" must be "relative" or "fixed"';
    }

    if (typeof f.ttlSeconds !== 'number' || f.ttlSeconds < 0 || f.ttlSeconds > 86400)
        return '"ttlSeconds" must be 0–86400';

    if (f.autoRefreshInterval !== undefined) {
        if (typeof f.autoRefreshInterval !== 'number' || f.autoRefreshInterval < 0 || f.autoRefreshInterval > 86400)
            return '"autoRefreshInterval" must be 0–86400';
    }

    if (!Array.isArray(f.apiKeys) || f.apiKeys.length === 0)
        return '"apiKeys" must be a non-empty array of strings';
    if (f.apiKeys.some((k: unknown) => typeof k !== 'string' || (k as string).length < 8))
        return '"apiKeys" entries must be strings of at least 8 characters';

    if (f.fieldMap !== undefined) {
        if (typeof f.fieldMap !== 'object' || Array.isArray(f.fieldMap)) return '"fieldMap" must be an object';
        for (const [k, v] of Object.entries(f.fieldMap as object)) {
            if (typeof v !== 'string') return `"fieldMap.${k}" value must be a string`;
        }
    }

    if (f.audio !== undefined) {
        if (typeof f.audio !== 'object' || f.audio === null) return '"audio" must be an object';
        const a = f.audio as Record<string, unknown>;
        if (typeof a.enabled !== 'boolean') return '"audio.enabled" must be a boolean';
        if (typeof a.addressField !== 'string' || !a.addressField)
            return '"audio.addressField" must be a non-empty string';
    }

    return null;
}

/** Compute start/end date strings for the report job body. */
export function resolveDateRange(dr: DateRangeConfig): { startDate: string; endDate: string } {
    if (dr.type === 'fixed') {
        return { startDate: dr.startDate, endDate: dr.endDate };
    }
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - dr.days);
    const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 00:00:00`;
    const fmtEnd = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 24:00:00`;
    return { startDate: fmt(start), endDate: fmtEnd(now) };
}
