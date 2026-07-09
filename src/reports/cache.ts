/**
 * In-memory report cache + background refresh scheduler.
 *
 * Each feed has one cache slot. A fetch in progress (inflight) is a single
 * shared Promise so concurrent consumer requests don't fan out into multiple
 * report jobs against GoContact.
 */

import { log } from '../core/logger';
import { fetchReport } from './report-client';
import type { ReportFeed, ReportCacheEntry } from './types';

interface CacheSlot {
    entry: ReportCacheEntry | null;
    inflight: Promise<ReportCacheEntry> | null;
    timer: ReturnType<typeof setInterval> | null;
}

const slots = new Map<string, CacheSlot>();

function getSlot(name: string): CacheSlot {
    let s = slots.get(name);
    if (!s) { s = { entry: null, inflight: null, timer: null }; slots.set(name, s); }
    return s;
}

/** Apply field projection to raw rows. */
export function projectRows(
    rawRows: Record<string, string>[],
    fieldMap?: Record<string, string>,
    includeUnmapped?: boolean,
): Record<string, string>[] {
    if (!fieldMap || Object.keys(fieldMap).length === 0) return rawRows;
    return rawRows.map(row => {
        const out: Record<string, string> = {};
        for (const [src, dest] of Object.entries(fieldMap)) {
            if (src in row) out[dest] = row[src];
        }
        if (includeUnmapped) {
            const mapped = new Set(Object.keys(fieldMap));
            for (const [k, v] of Object.entries(row)) {
                if (!mapped.has(k)) out[k] = v;
            }
        }
        return out;
    });
}

async function doFetch(feed: ReportFeed): Promise<ReportCacheEntry> {
    log.info(`[reports] fetching "${feed.name}" (template ${feed.templateId})`);
    const rawRows = await fetchReport(feed);
    const rows = projectRows(rawRows, feed.fieldMap, feed.includeUnmapped);
    const entry: ReportCacheEntry = {
        rows,
        rawRows,
        fetchedAt: Date.now(),
        rowCount: rows.length,
    };
    log.info(`[reports] "${feed.name}" fetched ${rows.length} rows`);
    return entry;
}

/**
 * Get (or fetch) the cached data for a feed.
 * Returns null if a fetch is in progress and there is no stale data to serve.
 */
export async function getCachedData(feed: ReportFeed): Promise<ReportCacheEntry> {
    const slot = getSlot(feed.name);

    // Serve from cache if fresh
    if (slot.entry) {
        const ageMs = Date.now() - slot.entry.fetchedAt;
        const ttlMs = feed.ttlSeconds * 1000;
        if (ttlMs === 0 || ageMs < ttlMs) {
            // If a background refresh is in progress, return stale while it finishes
            return slot.entry;
        }
    }

    // Coalesce concurrent requests
    if (slot.inflight) {
        // If we have stale data, return it while the refresh runs
        if (slot.entry) return slot.entry;
        return slot.inflight;
    }

    slot.inflight = doFetch(feed)
        .then(entry => { slot.entry = entry; return entry; })
        .catch(err => {
            log.error(`[reports] "${feed.name}" fetch failed: ${err instanceof Error ? err.message : err}`);
            throw err;
        })
        .finally(() => { slot.inflight = null; });

    // If we have stale data, return it immediately and let the fetch run in background
    if (slot.entry) return slot.entry;
    return slot.inflight;
}

/** Force an immediate refresh regardless of TTL. */
export async function forceRefresh(feed: ReportFeed): Promise<ReportCacheEntry> {
    const slot = getSlot(feed.name);
    if (slot.inflight) return slot.inflight;

    slot.inflight = doFetch(feed)
        .then(entry => { slot.entry = entry; return entry; })
        .catch(err => {
            log.error(`[reports] "${feed.name}" force-refresh failed: ${err instanceof Error ? err.message : err}`);
            throw err;
        })
        .finally(() => { slot.inflight = null; });

    return slot.inflight;
}

/** Start the background auto-refresh timer for a feed. */
export function startAutoRefresh(feed: ReportFeed): void {
    if (!feed.autoRefreshInterval || feed.autoRefreshInterval <= 0) return;
    const slot = getSlot(feed.name);
    if (slot.timer) clearInterval(slot.timer);
    slot.timer = setInterval(() => {
        if (!slot.inflight) {
            slot.inflight = doFetch(feed)
                .then(entry => { slot.entry = entry; return entry; })
                .catch(err => log.error(`[reports] "${feed.name}" auto-refresh failed: ${err instanceof Error ? err.message : err}`))
                .finally(() => { slot.inflight = null; }) as any;
        }
    }, feed.autoRefreshInterval * 1000);
}

/** Stop auto-refresh and evict cache for a feed (called on delete). */
export function evictFeed(name: string): void {
    const slot = slots.get(name);
    if (!slot) return;
    if (slot.timer) clearInterval(slot.timer);
    slots.delete(name);
}

/** Called at startup to warm caches for all feeds that have a short TTL. */
export function initFeeds(feeds: ReportFeed[]): void {
    for (const feed of feeds) {
        startAutoRefresh(feed);
    }
}

export interface FeedCacheStatus {
    cached: boolean;
    rowCount: number | null;
    fetchedAt: number | null;
    refreshing: boolean;
}

export function getFeedCacheStatus(name: string): FeedCacheStatus {
    const s = slots.get(name);
    return {
        cached: !!s?.entry,
        rowCount: s?.entry?.rowCount ?? null,
        fetchedAt: s?.entry?.fetchedAt ?? null,
        refreshing: !!s?.inflight,
    };
}
