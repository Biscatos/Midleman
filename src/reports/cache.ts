/**
 * In-memory report cache + SQLite persistence + background refresh scheduler.
 *
 * Data flow:
 *   startup      → load SQLite → warm in-memory slots
 *   consumer GET → read from slot (never triggers GoContact fetch)
 *   admin refresh / auto-timer → fetch GoContact → update slot → save to SQLite
 *
 * Consumers always get the last known good data.  GoContact is only queried
 * on explicit refresh (admin button, POST /refresh) or the auto-refresh timer.
 */

import { log } from '../core/logger';
import { fetchReport } from './report-client';
import { loadFeedFromDb, saveFeedToDb, deleteFeedFromDb } from './report-db';
import { findInstance } from '../gocontact/instances';
import type { ReportFeed, ReportCacheEntry } from './types';

interface CacheSlot {
    entry: ReportCacheEntry | null;
    inflight: Promise<ReportCacheEntry> | null;
    timer: ReturnType<typeof setInterval> | null;
}

const slots = new Map<string, CacheSlot>();

// ─── Event system ─────────────────────────────────────────────────────────────

export type CacheEvent =
    | { type: 'fetch_start'; feed: string; at: number }
    | { type: 'fetch_done';  feed: string; rowCount: number; durationMs: number; at: number }
    | { type: 'fetch_error'; feed: string; error: string; at: number };

type CacheEventListener = (event: CacheEvent) => void;
const eventListeners = new Set<CacheEventListener>();

export function subscribeCacheEvents(fn: CacheEventListener): () => void {
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
}

function emitCacheEvent(event: CacheEvent): void {
    for (const fn of eventListeners) {
        try { fn(event); } catch {}
    }
}

/** Resolve credentials from a named instance if instanceName is set. */
function resolveCredentials(feed: ReportFeed): ReportFeed {
    if (!feed.instanceName) return feed;
    const inst = findInstance(feed.instanceName);
    if (!inst) throw new Error(`GoContact instance "${feed.instanceName}" not found — check GoContact Instances settings`);
    return { ...feed, baseUrl: inst.baseUrl, username: inst.username, password: inst.password };
}

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
    const resolved = resolveCredentials(feed);
    const startedAt = Date.now();
    log.info(`[reports] fetching "${feed.name}" (template ${feed.templateId})`);
    emitCacheEvent({ type: 'fetch_start', feed: feed.name, at: startedAt });
    try {
        const rawRows = await fetchReport(resolved);
        const rows = projectRows(rawRows, feed.fieldMap, feed.includeUnmapped);
        const entry: ReportCacheEntry = {
            rows,
            rawRows,
            fetchedAt: Date.now(),
            rowCount: rows.length,
        };
        const durationMs = entry.fetchedAt - startedAt;
        log.info(`[reports] "${feed.name}" fetched ${rows.length} rows in ${durationMs}ms`);
        // Persist to SQLite so data survives restarts
        saveFeedToDb(feed.name, entry);
        emitCacheEvent({ type: 'fetch_done', feed: feed.name, rowCount: rows.length, durationMs, at: entry.fetchedAt });
        return entry;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitCacheEvent({ type: 'fetch_error', feed: feed.name, error: msg, at: Date.now() });
        throw err;
    }
}

/**
 * Return the current cached entry for a feed — reads from memory first,
 * falls back to SQLite. Never triggers a GoContact fetch.
 * Returns null if no data exists yet (server just started, never refreshed).
 */
export function getReadonlyData(name: string): ReportCacheEntry | null {
    const slot = slots.get(name);
    if (slot?.entry) return slot.entry;
    // Try SQLite
    const persisted = loadFeedFromDb(name);
    if (persisted) {
        // Warm the in-memory slot
        getSlot(name).entry = persisted;
        return persisted;
    }
    return null;
}

/**
 * Force an immediate refresh from GoContact regardless of TTL.
 * This is the ONLY path that triggers a GoContact report job.
 * Used by: admin refresh button, auto-refresh timer.
 */
export async function forceRefresh(feed: ReportFeed): Promise<ReportCacheEntry> {
    const slot = getSlot(feed.name);
    if (slot.inflight) return slot.inflight;

    slot.inflight = doFetch(feed)
        .then(entry => { slot.entry = entry; return entry; })
        .catch(err => {
            log.error(`[reports] "${feed.name}" refresh failed: ${err instanceof Error ? err.message : err}`);
            throw err;
        })
        .finally(() => { slot.inflight = null; });

    return slot.inflight;
}

/**
 * Start the background auto-refresh timer for a feed.
 * The timer calls forceRefresh on schedule — consumers read the result from cache.
 */
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

/** Stop the auto-refresh timer without touching cached data (called on feed update). */
export function stopAutoRefresh(name: string): void {
    const slot = slots.get(name);
    if (!slot) return;
    if (slot.timer) { clearInterval(slot.timer); slot.timer = null; }
}

/**
 * Re-project cached rows after a fieldMap change.
 * Keeps rawRows intact, rebuilds entry.rows from rawRows + new fieldMap.
 * No-op if there is no cached entry.
 */
export function reprojectFeedCache(
    name: string,
    fieldMap: Record<string, string> | undefined,
    includeUnmapped: boolean | undefined,
): void {
    const slot = slots.get(name);
    if (!slot?.entry) return;
    const rows = projectRows(slot.entry.rawRows, fieldMap, includeUnmapped);
    slot.entry = { ...slot.entry, rows, rowCount: rows.length };
    saveFeedToDb(name, slot.entry);
}

/** Stop auto-refresh, evict memory cache, and remove from SQLite (called on feed delete or manual cache clear). */
export function evictFeed(name: string): void {
    const slot = slots.get(name);
    if (!slot) return;
    if (slot.timer) clearInterval(slot.timer);
    slots.delete(name);
    deleteFeedFromDb(name);
}

/**
 * Called at startup: load all feeds from SQLite into memory slots,
 * then start auto-refresh timers.
 */
export function initFeeds(feeds: ReportFeed[]): void {
    for (const feed of feeds) {
        const persisted = loadFeedFromDb(feed.name);
        if (persisted) {
            getSlot(feed.name).entry = persisted;
            log.info(`[reports] "${feed.name}" restored ${persisted.rowCount} rows from SQLite (fetched ${new Date(persisted.fetchedAt).toISOString()})`);
        }
        startAutoRefresh(feed);
    }
}

export interface FeedCacheStatus {
    cached: boolean;
    rowCount: number | null;
    fetchedAt: number | null;
    refreshing: boolean;
}

export function getCachedRawRows(name: string): Record<string, string>[] | null {
    // Check memory first, then SQLite
    const slot = slots.get(name);
    if (slot?.entry) return slot.entry.rawRows;
    const persisted = loadFeedFromDb(name);
    if (persisted) { getSlot(name).entry = persisted; return persisted.rawRows; }
    return null;
}

export function getFeedCacheStatus(name: string): FeedCacheStatus {
    const slot = slots.get(name);
    // Include SQLite data even if not yet in memory
    const entry = slot?.entry ?? loadFeedFromDb(name);
    return {
        cached: !!entry,
        rowCount: entry?.rowCount ?? null,
        fetchedAt: entry?.fetchedAt ?? null,
        refreshing: !!slot?.inflight,
    };
}
