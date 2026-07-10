import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import type { ReportFeed, DateRangeConfig, GoContactOwnerType, FieldFilterOperator } from './types';

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
            .filter(f => f.name && (f.instanceName || (f.baseUrl && f.username && f.password)) && f.templateId)
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

    if (f.group !== undefined) {
        if (typeof f.group !== 'string' || !/^[a-z0-9_-]+$/.test(f.group))
            return '"group" must be a lowercase slug (letters, numbers, hyphens, underscores)';
    }
    if (f.slug !== undefined) {
        if (typeof f.slug !== 'string' || !/^[a-z0-9_-]+$/.test(f.slug))
            return '"slug" must be a lowercase slug (letters, numbers, hyphens, underscores)';
    }

    // Credentials: either instanceName (reference) OR inline baseUrl/username/password
    const hasInstance = f.instanceName && typeof f.instanceName === 'string';
    if (hasInstance) {
        if (!/^[a-z0-9_-]+$/.test(f.instanceName as string)) return '"instanceName" must be a valid slug (lowercase, hyphens, underscores)';
    } else {
        if (!f.baseUrl || typeof f.baseUrl !== 'string') return '"baseUrl" is required when "instanceName" is not set';
        try { new URL(f.baseUrl as string); } catch { return '"baseUrl" must be a valid URL'; }
        if (!f.username || typeof f.username !== 'string') return '"username" is required when "instanceName" is not set';
        if (!f.password || typeof f.password !== 'string') return '"password" is required when "instanceName" is not set';
    }
    if (!f.templateId || typeof f.templateId !== 'string') return '"templateId" is required (string)';

    const validOwnerTypes: GoContactOwnerType[] = [
        'campaign', 'queue', 'ticket', 'ivr_campaigns', 'assisted_transfer',
        'callbacks', 'agents', 'webchat', 'webchat_sessions', 'ticket_agent_times',
        'on_hook_attempt', 'quality', 'elearning', 'scripts',
    ];
    if (!f.ownerType || !validOwnerTypes.includes(f.ownerType as GoContactOwnerType))
        return `"ownerType" must be one of: ${validOwnerTypes.join(', ')}`;

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

    // ttlSeconds kept for backward compat but no longer enforced (API reads from SQLite, not cache-gated)

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

    if (f.fieldFilters !== undefined) {
        if (typeof f.fieldFilters !== 'object' || Array.isArray(f.fieldFilters))
            return '"fieldFilters" must be an object';
        const validTypes = ['string', 'number', 'date', 'boolean'];
        const validOps: FieldFilterOperator[] = ['equals','notEquals','contains','startsWith','gt','gte','lt','lte'];
        for (const [k, v] of Object.entries(f.fieldFilters as object)) {
            const fc = v as Record<string, unknown>;
            if (!fc || typeof fc !== 'object') return `"fieldFilters.${k}" must be an object`;
            if (!validTypes.includes(fc.type as string)) return `"fieldFilters.${k}.type" must be one of: ${validTypes.join(', ')}`;
            if (fc.operators !== undefined) {
                if (!Array.isArray(fc.operators)) return `"fieldFilters.${k}.operators" must be an array`;
                for (const op of fc.operators as unknown[]) {
                    if (!validOps.includes(op as FieldFilterOperator))
                        return `"fieldFilters.${k}.operators" contains invalid operator "${op}"`;
                }
            }
        }
    }

    if (f.detail !== undefined) {
        if (typeof f.detail !== 'object' || f.detail === null) return '"detail" must be an object';
        const d = f.detail as Record<string, unknown>;
        if (typeof d.idField !== 'string' || !d.idField)
            return '"detail.idField" must be a non-empty string';
        if (d.sourceFeed !== undefined && (typeof d.sourceFeed !== 'string' || !d.sourceFeed))
            return '"detail.sourceFeed" must be a non-empty string when provided';
    }

    if (f.audio !== undefined) {
        if (typeof f.audio !== 'object' || f.audio === null) return '"audio" must be an object';
        const a = f.audio as Record<string, unknown>;
        if (typeof a.enabled !== 'boolean') return '"audio.enabled" must be a boolean';
        if (typeof a.addressField !== 'string' || !a.addressField)
            return '"audio.addressField" must be a non-empty string';
        if (a.idField !== undefined && (typeof a.idField !== 'string' || !a.idField))
            return '"audio.idField" must be a non-empty string when provided';
        if (a.enabled && !f.detail && typeof a.idField !== 'string')
            return '"audio.idField" is required when "detail" is not configured';
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
