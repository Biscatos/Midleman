/**
 * Report Feed HTTP server — admin CRUD + consumer endpoints.
 *
 * Consumer endpoints (API-key protected):
 *   GET  /reports/:name            → JSON array of projected rows
 *   POST /reports/:name/refresh    → force re-fetch, return new data
 *   GET  /reports/:name/audio?path=/recordings/... → stream audio
 *
 * Admin endpoints (dashboard session or X-Forward-Token):
 *   GET    /admin/reports                 → list all feeds
 *   POST   /admin/reports                 → create feed
 *   PUT    /admin/reports/:name           → update feed
 *   DELETE /admin/reports/:name           → delete feed
 *   GET    /admin/reports/:name/status    → cache status + last fetch info
 */

import { log } from '../core/logger';
import { loadPersistedReportFeeds, persistReportFeeds, validateReportFeedInput } from './store';
import { getCachedData, forceRefresh, startAutoRefresh, evictFeed, initFeeds, getFeedCacheStatus } from './cache';
import { streamAudio } from './audio-session';
import type { ReportFeed } from './types';
import { timingSafeEqual } from 'crypto';

// ─── State ───────────────────────────────────────────────────────────────────

let feeds: ReportFeed[] = [];

export function initReportFeeds(): void {
    feeds = loadPersistedReportFeeds();
    initFeeds(feeds);
    log.info(`[reports] loaded ${feeds.length} feed(s)`);
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function checkAdminAuth(req: Request, adminToken: string | undefined): boolean {
    if (adminToken) {
        const provided = req.headers.get('x-forward-token') ?? '';
        if (provided && safeEqual(provided, adminToken)) return true;
    }
    // Session cookie auth is handled by the caller in index.ts
    return false;
}

function checkApiKey(req: Request, feed: ReportFeed): boolean {
    const provided =
        req.headers.get('x-api-key') ??
        req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
        new URL(req.url).searchParams.get('apiKey') ??
        '';
    if (!provided) return false;
    return feed.apiKeys.some(k => safeEqual(provided, k));
}

function safeEqual(a: string, b: string): boolean {
    try {
        const ba = Buffer.from(a), bb = Buffer.from(b);
        if (ba.length !== bb.length) {
            // Prevent length-timing leak: still do the comparison on equal-length slices
            timingSafeEqual(ba.subarray(0, 1), ba.subarray(0, 1));
            return false;
        }
        return timingSafeEqual(ba, bb);
    } catch { return false; }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * Handle a report-related request. Returns a Response or null if no route matched.
 * `isAdmin` is set by the caller after checking the dashboard session.
 */
export async function handleReportRequest(
    req: Request,
    pathname: string,
    isAdmin: boolean,
    adminToken?: string,
): Promise<Response | null> {
    const auth = isAdmin || checkAdminAuth(req, adminToken);

    // ── Admin routes ──────────────────────────────────────────────────────────
    if (pathname === '/admin/reports' || pathname === '/admin/reports/') {
        if (!auth) return json({ error: 'Unauthorized' }, 401);
        if (req.method === 'GET') return json(feeds.map(sanitizeForAdmin));
        if (req.method === 'POST') return createFeed(req);
        return json({ error: 'Method not allowed' }, 405);
    }

    const adminMatch = pathname.match(/^\/admin\/reports\/([^/]+)(\/status|\/refresh)?$/);
    if (adminMatch) {
        if (!auth) return json({ error: 'Unauthorized' }, 401);
        const name = adminMatch[1].toLowerCase();
        const suffix = adminMatch[2] ?? '';
        if (suffix === '/status') return getFeedStatus(name);
        if (suffix === '/refresh') {
            if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
            const feed = feeds.find(f => f.name === name);
            if (!feed) return json({ error: 'Feed not found' }, 404);
            try {
                const entry = await forceRefresh(feed);
                return json({ rowCount: entry.rowCount, fetchedAt: entry.fetchedAt });
            } catch (err) {
                return json({ error: 'Refresh failed', detail: err instanceof Error ? err.message : String(err) }, 502);
            }
        }
        if (req.method === 'PUT') return updateFeed(req, name);
        if (req.method === 'DELETE') return deleteFeed(name);
        return json({ error: 'Method not allowed' }, 405);
    }

    // ── Consumer routes ───────────────────────────────────────────────────────
    const consumerMatch = pathname.match(/^\/reports\/([^/]+)(\/refresh|\/audio)?$/);
    if (!consumerMatch) return null;

    const name = consumerMatch[1].toLowerCase();
    const suffix = consumerMatch[2] ?? '';
    const feed = feeds.find(f => f.name === name);
    if (!feed) return json({ error: 'Feed not found' }, 404);
    if (!checkApiKey(req, feed)) return json({ error: 'Unauthorized' }, 401);

    // Audio streaming
    if (suffix === '/audio') {
        if (!feed.audio?.enabled) return json({ error: 'Audio streaming not enabled for this feed' }, 400);
        const audioPath = new URL(req.url).searchParams.get('path') ?? '';
        if (!audioPath) return json({ error: '"path" query parameter is required' }, 400);
        return streamAudio(feed.baseUrl, feed.username, feed.password, audioPath);
    }

    // Force refresh
    if (suffix === '/refresh') {
        if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        try {
            const entry = await forceRefresh(feed);
            return json({ rowCount: entry.rowCount, fetchedAt: entry.fetchedAt, rows: entry.rows });
        } catch (err) {
            log.error(`[reports] consumer refresh "${name}" failed: ${err instanceof Error ? err.message : err}`);
            return json({ error: 'Failed to fetch report', detail: err instanceof Error ? err.message : String(err) }, 502);
        }
    }

    // Main data endpoint
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    try {
        const entry = await getCachedData(feed);
        const res = json({ rowCount: entry.rowCount, fetchedAt: entry.fetchedAt, rows: entry.rows });
        return res;
    } catch (err) {
        log.error(`[reports] consumer GET "${name}" failed: ${err instanceof Error ? err.message : err}`);
        return json({ error: 'Failed to fetch report', detail: err instanceof Error ? err.message : String(err) }, 502);
    }
}

// ─── Admin CRUD ───────────────────────────────────────────────────────────────

async function createFeed(req: Request): Promise<Response> {
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

    const err = validateReportFeedInput(body);
    if (err) return json({ error: err }, 400);

    const input = body as ReportFeed;
    const name = input.name.toLowerCase();
    if (feeds.some(f => f.name === name)) return json({ error: `Feed "${name}" already exists` }, 409);

    const feed: ReportFeed = { ...input, name };
    feeds.push(feed);
    persistReportFeeds(feeds);
    startAutoRefresh(feed);
    log.info(`[reports] created feed "${name}"`);
    return json(sanitizeForAdmin(feed), 201);
}

async function updateFeed(req: Request, name: string): Promise<Response> {
    const idx = feeds.findIndex(f => f.name === name);
    if (idx === -1) return json({ error: 'Feed not found' }, 404);

    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

    // Allow partial update: merge with existing, then validate the merged result
    const merged = { ...feeds[idx], ...(body as object), name };
    const err = validateReportFeedInput(merged);
    if (err) return json({ error: err }, 400);

    evictFeed(name);
    feeds[idx] = merged as ReportFeed;
    persistReportFeeds(feeds);
    startAutoRefresh(feeds[idx]);
    log.info(`[reports] updated feed "${name}"`);
    return json(sanitizeForAdmin(feeds[idx]));
}

async function deleteFeed(name: string): Promise<Response> {
    const idx = feeds.findIndex(f => f.name === name);
    if (idx === -1) return json({ error: 'Feed not found' }, 404);
    evictFeed(name);
    feeds.splice(idx, 1);
    persistReportFeeds(feeds);
    log.info(`[reports] deleted feed "${name}"`);
    return json({ deleted: name });
}

async function getFeedStatus(name: string): Promise<Response> {
    const feed = feeds.find(f => f.name === name);
    if (!feed) return json({ error: 'Feed not found' }, 404);
    const status = getFeedCacheStatus(name);
    return json({
        name: feed.name,
        ...status,
        autoRefreshInterval: feed.autoRefreshInterval ?? 0,
        ttlSeconds: feed.ttlSeconds,
    });
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sanitizeForAdmin(f: ReportFeed): object {
    return {
        name: f.name,
        baseUrl: f.baseUrl,
        username: f.username,
        // password omitted from API responses
        templateId: f.templateId,
        ownerType: f.ownerType,
        ownerIds: f.ownerIds,
        dataType: f.dataType,
        language: f.language,
        includeAllOwners: f.includeAllOwners,
        dateRange: f.dateRange,
        ttlSeconds: f.ttlSeconds,
        autoRefreshInterval: f.autoRefreshInterval,
        maxPollAttempts: f.maxPollAttempts,
        apiKeys: f.apiKeys,
        fieldMap: f.fieldMap,
        includeUnmapped: f.includeUnmapped,
        audio: f.audio,
    };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
