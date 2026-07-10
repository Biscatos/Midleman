/**
 * Report Feed HTTP server — admin CRUD + consumer endpoints.
 *
 * Consumer endpoints (API-key protected):
 *   GET  /reports/:name            → JSON array of projected rows (pagination + filtering)
 *   GET  /reports/:name/:id        → filtered rows matching detail.idField === id
 *   GET  /reports/:name/:id/audio  → stream audio file referenced by that row
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
import { getReadonlyData, getCachedRawRows, forceRefresh, startAutoRefresh, stopAutoRefresh, reprojectFeedCache, evictFeed, initFeeds, getFeedCacheStatus, projectRows, subscribeCacheEvents } from './cache';
import type { CacheEvent } from './cache';
import { streamAudio } from './audio-session';
import type { ReportFeed, FieldFilterConfig } from './types';
import { loadInstances, saveInstances, getInstances, findInstance, validateInstanceInput } from '../gocontact/instances';
import type { GoContactInstance } from '../gocontact/instances';
import { timingSafeEqual } from 'crypto';

// ─── State ───────────────────────────────────────────────────────────────────

let feeds: ReportFeed[] = [];

export function initReportFeeds(): void {
    loadInstances();
    feeds = loadPersistedReportFeeds();
    initFeeds(feeds);
    log.info(`[reports] loaded ${feeds.length} feed(s), ${getInstances().length} GoContact instance(s)`);
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

    // ── GoContact Instances CRUD ──────────────────────────────────────────────
    if (pathname === '/admin/gocontact/instances' || pathname === '/admin/gocontact/instances/') {
        if (!auth) return json({ error: 'Unauthorized' }, 401);
        if (req.method === 'GET') return json(getInstances().map(sanitizeInstance));
        if (req.method === 'POST') return createInstance(req);
        return json({ error: 'Method not allowed' }, 405);
    }
    const instMatch = pathname.match(/^\/admin\/gocontact\/instances\/([^/]+)$/);
    if (instMatch) {
        if (!auth) return json({ error: 'Unauthorized' }, 401);
        const instName = instMatch[1].toLowerCase();
        if (req.method === 'PUT') return updateInstance(req, instName);
        if (req.method === 'DELETE') return deleteInstance(instName);
        return json({ error: 'Method not allowed' }, 405);
    }

    // ── Admin routes ──────────────────────────────────────────────────────────
    if (pathname === '/admin/reports' || pathname === '/admin/reports/') {
        if (!auth) return json({ error: 'Unauthorized' }, 401);
        if (req.method === 'GET') return json(feeds.map(sanitizeForAdmin));
        if (req.method === 'POST') return createFeed(req);
        return json({ error: 'Method not allowed' }, 405);
    }

    // SSE stream — must match before the generic :name pattern
    if (pathname === '/admin/reports/stream') {
        if (!auth) return json({ error: 'Unauthorized' }, 401);
        return handleSseStream(req);
    }

    // Preview — fetch columns + sample rows without saving anything
    if (pathname === '/admin/reports/preview') {
        if (!auth) return json({ error: 'Unauthorized' }, 401);
        if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        return handlePreview(req);
    }

    const adminMatch = pathname.match(/^\/admin\/reports\/([^/]+)(\/status|\/refresh|\/data|\/clear-cache)?$/);
    if (adminMatch) {
        if (!auth) return json({ error: 'Unauthorized' }, 401);
        const name = adminMatch[1].toLowerCase();
        const suffix = adminMatch[2] ?? '';
        if (suffix === '/status') return getFeedStatus(name);
        if (suffix === '/data') return getFeedData(req, name);
        if (suffix === '/refresh') {
            if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
            const feed = feeds.find(f => f.name === name);
            if (!feed) return json({ error: 'Feed not found' }, 404);
            const already = getFeedCacheStatus(name);
            if (already.refreshing) return json({ message: 'Already refreshing' }, 202);
            // Fire in background — SSE broadcasts fetch_start / fetch_done / fetch_error
            forceRefresh(feed).catch(err =>
                log.error(`[reports] manual refresh "${name}" failed: ${err instanceof Error ? err.message : err}`)
            );
            return json({ message: 'Refresh started' }, 202);
        }
        if (suffix === '/clear-cache') {
            if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
            const feed = feeds.find(f => f.name === name);
            if (!feed) return json({ error: 'Feed not found' }, 404);
            evictFeed(name);
            startAutoRefresh(feed);
            return json({ cleared: true });
        }
        if (req.method === 'PUT') return updateFeed(req, name);
        if (req.method === 'DELETE') return deleteFeed(name);
        return json({ error: 'Method not allowed' }, 405);
    }

    // ── Consumer routes ───────────────────────────────────────────────────────
    // Supported patterns (flat):
    //   /reports/:name
    //   /reports/:name/:id
    //   /reports/:name/:id/audio
    //
    // Supported patterns (grouped, when feed has group+slug):
    //   /reports/:group/openapi.json
    //   /reports/:group/docs
    //   /reports/:group/:slug
    //   /reports/:group/:slug/:id
    //   /reports/:group/:slug/:id/audio
    if (!pathname.startsWith('/reports/')) return null;
    const segments = pathname.slice('/reports/'.length).split('/').filter(Boolean);
    if (segments.length === 0) return null;

    // Global special routes (first segment is the keyword)
    if (segments[0] === 'openapi.json') {
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        return handleOpenApiSpec(req, null);
    }
    if (segments[0] === 'docs') {
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        return handleSwaggerDocs(req, null);
    }

    const seg0 = segments[0].toLowerCase();

    // Determine if group routing applies (any feed has this group name)
    const groupFeeds = feeds.filter(f => f.group && f.group.toLowerCase() === seg0);
    const isGroupRoute = groupFeeds.length > 0 && segments.length >= 2;

    if (isGroupRoute) {
        const seg1 = segments[1];

        // Group-scoped special routes
        if (seg1 === 'openapi.json') {
            if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
            return handleOpenApiSpec(req, seg0);
        }
        if (seg1 === 'docs') {
            if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
            return handleSwaggerDocs(req, seg0);
        }

        const slug = seg1.toLowerCase();
        const feed = groupFeeds.find(f => f.slug && f.slug.toLowerCase() === slug);
        if (!feed) return json({ error: 'Feed not found' }, 404);
        // Group auth: key must match at least one feed in the group (allows one shared key for the whole group)
        const groupKeyOk = groupFeeds.some(f => checkApiKey(req, f));
        if (!groupKeyOk) return json({ error: 'Unauthorized' }, 401);

        // /reports/:group/:slug/:id/audio
        if (segments.length === 4 && segments[3] === 'audio') {
            if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
            if (!feed.audio?.enabled) return json({ error: 'Audio streaming not enabled for this feed' }, 400);
            return streamAudioForRow(feed, decodeURIComponent(segments[2]));
        }

        // /reports/:group/:slug/:id
        if (segments.length === 3) {
            if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
            if (!feed.detail) return json({ error: 'Detail route not configured for this feed' }, 400);
            return getDetailRows(feed, decodeURIComponent(segments[2]));
        }

        // /reports/:group/:slug (list)
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        const entry = getReadonlyData(feed.name);
        if (!entry) return json({ error: 'Data is not yet available. Please try again later.' }, 503);
        const params = new URL(req.url).searchParams;
        return applyPagination(applyFilters(entry.rows, feed, params), params, entry.fetchedAt);
    }

    // Flat routing: /reports/:name[/:id[/audio]]
    const feed = feeds.find(f => f.name === seg0);
    if (!feed) return json({ error: 'Feed not found' }, 404);
    if (!checkApiKey(req, feed)) return json({ error: 'Unauthorized' }, 401);

    // GET /reports/:name/:id/audio
    if (segments.length === 3 && segments[2] === 'audio') {
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        if (!feed.audio?.enabled) return json({ error: 'Audio streaming not enabled for this feed' }, 400);
        return streamAudioForRow(feed, decodeURIComponent(segments[1]));
    }

    // GET /reports/:name/:id
    if (segments.length === 2 && segments[1] !== 'refresh') {
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        if (!feed.detail) return json({ error: 'Detail route not configured for this feed' }, 400);
        return getDetailRows(feed, decodeURIComponent(segments[1]));
    }

    // GET /reports/:name  (main list — reads from cache/SQLite, never triggers GoContact fetch)
    if (segments.length === 1) {
        if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        const entry = getReadonlyData(feed.name);
        if (!entry) return json({ error: 'Data is not yet available. Please try again later.' }, 503);
        const params = new URL(req.url).searchParams;
        return applyPagination(applyFilters(entry.rows, feed, params), params, entry.fetchedAt);
    }

    return null;
}

/**
 * Resolve a raw GoContact column name to its projected API name via a fieldMap.
 * If idField is already an API name (no entry in fieldMap), returns it unchanged.
 * This handles both feeds saved before and after the raw-column UI fix.
 */
function resolveIdField(idField: string, fieldMap?: Record<string, string>): string {
    return fieldMap?.[idField] ?? idField;
}

/** Filter cached rows by the detail idField, optionally from a linked source feed. */
async function getDetailRows(feed: ReportFeed, id: string): Promise<Response> {
    const detail = feed.detail!;

    if (detail.sourceFeed) {
        const srcFeed = feeds.find(f => f.name === detail.sourceFeed);
        let rawRows = getCachedRawRows(detail.sourceFeed);
        if (rawRows === null) {
            if (!srcFeed) return json({ error: 'Data is not yet available. Please try again later.' }, 503);
            const srcEntry = getReadonlyData(srcFeed.name);
            if (!srcEntry) return json({ error: 'Data is not yet available. Please try again later.' }, 503);
            rawRows = srcEntry.rawRows;
        }
        const projected = srcFeed
            ? projectRows(rawRows!, srcFeed.fieldMap, srcFeed.includeUnmapped)
            : rawRows!;

        // sourceIdField (if set) is already a projected name for the source feed.
        // Otherwise fall back to resolving detail.idField through srcFeed.fieldMap.
        const srcIdField = detail.sourceIdField
            ?? resolveIdField(detail.idField, srcFeed?.fieldMap);
        const matched = projected.filter(row => row[srcIdField] === id);

        // mergeParent: also include the matching row from this (parent) feed as `summary`
        let summary: Record<string, string> | null = null;
        if (detail.mergeParent) {
            const parentEntry = getReadonlyData(feed.name);
            if (parentEntry) {
                const parentProjected = projectRows(parentEntry.rawRows, feed.fieldMap, feed.includeUnmapped);
                const parentIdField = resolveIdField(detail.idField, feed.fieldMap);
                summary = parentProjected.find(row => row[parentIdField] === id) ?? null;
            }
        }

        const resp: Record<string, unknown> = { id, idField: srcIdField, rowCount: matched.length, rows: matched };
        if (detail.mergeParent) resp.summary = summary;
        return json(resp);
    }

    // Use this feed's own cached data
    const entry = getReadonlyData(feed.name);
    if (!entry) return json({ error: 'Data is not yet available. Please try again later.' }, 503);

    const projected = projectRows(entry.rawRows, feed.fieldMap, feed.includeUnmapped);
    const parentIdField = resolveIdField(detail.idField, feed.fieldMap);
    const matched = projected.filter(row => row[parentIdField] === id);
    return json({ id, idField: parentIdField, rowCount: matched.length, rows: matched });
}

/** Look up the audio path for a given row ID from cached data and stream it. */
async function streamAudioForRow(feed: ReportFeed, id: string): Promise<Response> {
    const audio = feed.audio!;
    const idField = audio.idField ?? feed.detail?.idField;
    if (!idField) return json({ error: 'audio.idField not configured' }, 500);

    const audioEntry = getReadonlyData(feed.name);
    if (!audioEntry) return json({ error: 'Data is not yet available. Please try again later.' }, 503);

    const row = audioEntry.rawRows.find(r => r[idField] === id);
    if (!row) return json({ error: `No row found with ${idField} = "${id}"` }, 404);

    const audioPath = row[audio.addressField];
    if (!audioPath) return json({ error: `Row has no value for audio field "${audio.addressField}"` }, 404);

    let baseUrl = feed.baseUrl, username = feed.username, password = feed.password;
    if (feed.instanceName) {
        const inst = findInstance(feed.instanceName);
        if (!inst) return json({ error: 'Internal configuration error' }, 500);
        baseUrl = inst.baseUrl; username = inst.username; password = inst.password;
    }
    return streamAudio(baseUrl!, username!, password!, audioPath);
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

    stopAutoRefresh(name);
    feeds[idx] = merged as ReportFeed;
    persistReportFeeds(feeds);
    reprojectFeedCache(name, feeds[idx].fieldMap, feeds[idx].includeUnmapped);
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

// ─── Preview ─────────────────────────────────────────────────────────────────

async function handlePreview(req: Request): Promise<Response> {
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

    const f = body as Record<string, unknown>;

    // Resolve credentials: instanceName > request fields > stored feed password
    let resolvedBaseUrl = f.baseUrl ? String(f.baseUrl) : undefined;
    let resolvedUsername = f.username ? String(f.username) : undefined;
    let resolvedPassword = f.password ? String(f.password) : undefined;

    if (f.instanceName) {
        const inst = findInstance(String(f.instanceName));
        if (!inst) return json({ error: `GoContact instance "${f.instanceName}" not found` }, 400);
        resolvedBaseUrl = inst.baseUrl;
        resolvedUsername = inst.username;
        resolvedPassword = inst.password;
    } else if (!resolvedPassword && f.feedName) {
        const stored = feeds.find(x => x.name === String(f.feedName).toLowerCase());
        if (stored) {
            resolvedPassword = stored.password ?? (stored.instanceName ? findInstance(stored.instanceName)?.password : undefined);
            if (!resolvedBaseUrl) resolvedBaseUrl = stored.baseUrl ?? (stored.instanceName ? findInstance(stored.instanceName)?.baseUrl : undefined);
            if (!resolvedUsername) resolvedUsername = stored.username ?? (stored.instanceName ? findInstance(stored.instanceName)?.username : undefined);
        }
    }

    if (!resolvedBaseUrl || !resolvedUsername || !resolvedPassword || !f.templateId || !f.ownerType)
        return json({ error: 'baseUrl, username, password (or instanceName), templateId and ownerType are required' }, 400);

    // Always use 1 day for preview — minimises rows fetched from GoContact
    const dateRange = { type: 'relative' as const, days: 1 };

    const tmpFeed: ReportFeed = {
        name:            '__preview__',
        baseUrl:         resolvedBaseUrl,
        username:        resolvedUsername,
        password:        resolvedPassword,
        templateId:      String(f.templateId),
        ownerType:       f.ownerType as any,
        ownerIds:        Array.isArray(f.ownerIds) ? f.ownerIds : ['allOwners'],
        dataType:        f.dataType as any,
        language:        String(f.language ?? 'en'),
        includeAllOwners: f.includeAllOwners === true || (Array.isArray(f.ownerIds) && f.ownerIds.includes('allOwners')),
        dateRange,
        ttlSeconds:      0,
        apiKeys:         [],
    };

    try {
        const { fetchReport } = await import('./report-client') as any;
        const rawRows = await fetchReport(tmpFeed);
        const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
        const sampleRows = rawRows.slice(0, 5);
        return json({ columns, sampleRows, totalRows: rawRows.length });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: 'Preview fetch failed', detail: msg }, 502);
    }
}

// ─── SSE stream ───────────────────────────────────────────────────────────────

function handleSseStream(req: Request): Response {
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const stream = new ReadableStream({
        start(controller) {
            const enc = new TextEncoder();
            const send = (event: CacheEvent) => {
                if (closed) return;
                try {
                    controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
                } catch { closed = true; }
            };

            // Send current status of all feeds as initial snapshot
            const snapshot = feeds.map(f => {
                const s = getFeedCacheStatus(f.name);
                return { feed: f.name, cached: s.cached, rowCount: s.rowCount, fetchedAt: s.fetchedAt, refreshing: s.refreshing };
            });
            try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'snapshot', feeds: snapshot, at: Date.now() })}\n\n`));
            } catch {}

            unsubscribe = subscribeCacheEvents(send);
        },
        cancel() {
            closed = true;
            if (unsubscribe) unsubscribe();
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}

// ─── Data viewer ──────────────────────────────────────────────────────────────

async function getFeedData(req: Request, name: string): Promise<Response> {
    const feed = feeds.find(f => f.name === name);
    if (!feed) return json({ error: 'Feed not found' }, 404);

    const url = new URL(req.url);
    const page   = Math.max(1, parseInt(url.searchParams.get('page')  ?? '1',  10) || 1);
    const limit  = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100));
    const query  = (url.searchParams.get('q') ?? '').toLowerCase().trim();
    const useRaw = url.searchParams.get('raw') === '1';

    const entry = getReadonlyData(feed.name);
    if (!entry) return json({ error: 'No data yet', detail: 'Trigger a refresh first.' }, 503);

    const source = useRaw ? entry.rawRows : entry.rows;
    const columns = source.length > 0 ? Object.keys(source[0]) : [];

    const filtered = query
        ? source.filter(row => Object.values(row).some(v => v.toLowerCase().includes(query)))
        : source;

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const rows = filtered.slice(offset, offset + limit);

    return json({
        feed: feed.name,
        columns,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        rows,
        fetchedAt: entry.fetchedAt,
    });
}

// ─── GoContact Instances CRUD ─────────────────────────────────────────────────

async function createInstance(req: Request): Promise<Response> {
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
    const err = validateInstanceInput(body);
    if (err) return json({ error: err }, 400);
    const input = body as GoContactInstance;
    const name = input.name.toLowerCase();
    const list = getInstances();
    if (list.some(i => i.name === name)) return json({ error: `Instance "${name}" already exists` }, 409);
    const inst: GoContactInstance = { ...input, name };
    saveInstances([...list, inst]);
    log.info(`[instances] created "${name}"`);
    return json(sanitizeInstance(inst), 201);
}

async function updateInstance(req: Request, name: string): Promise<Response> {
    const list = getInstances();
    const idx = list.findIndex(i => i.name === name);
    if (idx === -1) return json({ error: 'Instance not found' }, 404);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
    const merged = { ...list[idx], ...(body as object), name };
    // If password is blank, keep the stored one
    if (!(merged as any).password) (merged as any).password = list[idx].password;
    const err = validateInstanceInput(merged);
    if (err) return json({ error: err }, 400);
    list[idx] = merged as GoContactInstance;
    saveInstances(list);
    log.info(`[instances] updated "${name}"`);
    return json(sanitizeInstance(list[idx]));
}

async function deleteInstance(name: string): Promise<Response> {
    const list = getInstances();
    const idx = list.findIndex(i => i.name === name);
    if (idx === -1) return json({ error: 'Instance not found' }, 404);
    // Check if any feed references this instance
    const using = feeds.filter(f => f.instanceName === name).map(f => f.name);
    if (using.length > 0) return json({ error: `Cannot delete: feeds still using this instance: ${using.join(', ')}` }, 409);
    list.splice(idx, 1);
    saveInstances(list);
    log.info(`[instances] deleted "${name}"`);
    return json({ deleted: name });
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sanitizeInstance(i: GoContactInstance): object {
    return { name: i.name, label: i.label, baseUrl: i.baseUrl, username: i.username };
    // password omitted
}

function sanitizeForAdmin(f: ReportFeed): object {
    return {
        name: f.name,
        group: f.group,
        slug: f.slug,
        instanceName: f.instanceName,
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
        fieldFilters: f.fieldFilters,
        detail: f.detail,
        audio: f.audio,
    };
}

// ─── Filtering & Pagination ───────────────────────────────────────────────────

const RESERVED_PARAMS = new Set(['page', 'limit', 'apiKey']);

const DEFAULT_OPERATORS: Record<string, string[]> = {
    string:  ['equals', 'contains', 'startsWith'],
    number:  ['equals', 'gte', 'lte', 'gt', 'lt'],
    date:    ['gte', 'lte'],
    boolean: ['equals'],
};

function compareTyped(a: string, b: string, type: string): number {
    if (type === 'number') return parseFloat(a) - parseFloat(b);
    if (type === 'date')   return Date.parse(a) - Date.parse(b);
    return a.localeCompare(b);
}

function applyFilters(rows: Record<string, string>[], feed: ReportFeed, params: URLSearchParams): Record<string, string>[] {
    let result = rows;
    const fieldFilters = feed.fieldFilters ?? {};

    for (const [rawKey, value] of params.entries()) {
        if (RESERVED_PARAMS.has(rawKey)) continue;

        // Parse ?field=value (equals) and ?field__op=value (explicit operator)
        const dunder = rawKey.indexOf('__');
        const fieldName = dunder > -1 ? rawKey.slice(0, dunder) : rawKey;
        const operator  = dunder > -1 ? rawKey.slice(dunder + 2) : 'equals';

        const config = fieldFilters[fieldName];
        const type = config?.type ?? 'string';

        result = result.filter(row => {
            const rowVal = row[fieldName];
            if (rowVal === undefined || rowVal === null) return true;
            switch (operator) {
                case 'equals':     return rowVal === value;
                case 'notEquals':  return rowVal !== value;
                case 'contains':   return rowVal.toLowerCase().includes(value.toLowerCase());
                case 'startsWith': return rowVal.toLowerCase().startsWith(value.toLowerCase());
                case 'gt':  return compareTyped(rowVal, value, type) > 0;
                case 'gte': return compareTyped(rowVal, value, type) >= 0;
                case 'lt':  return compareTyped(rowVal, value, type) < 0;
                case 'lte': return compareTyped(rowVal, value, type) <= 0;
                default:    return rowVal === value;
            }
        });
    }

    return result;
}

function applyPagination(rows: Record<string, string>[], params: URLSearchParams, fetchedAt: number): Response {
    const pageParam  = params.get('page');
    const limitParam = params.get('limit');

    if (!pageParam && !limitParam) {
        // Backward-compat: no pagination params → return all
        return json({ rowCount: rows.length, fetchedAt, rows });
    }

    const limit  = Math.min(Math.max(parseInt(limitParam ?? '50') || 50, 1), 1000);
    const page   = Math.max(parseInt(pageParam ?? '1') || 1, 1);
    const offset = (page - 1) * limit;
    const sliced = rows.slice(offset, offset + limit);

    return json({ total: rows.length, page, limit, returned: sliced.length, fetchedAt, rows: sliced });
}

// ─── OpenAPI spec generator ───────────────────────────────────────────────────

const OWNER_TYPE_LABELS: Record<string, string> = {
    campaign:           'Outbound Voice',
    queue:              'Inbound Voice',
    ticket:             'Ticket Queues',
    ivr_campaigns:      'IVR Campaigns',
    assisted_transfer:  'Assisted Transfer',
    callbacks:          'Voice Callbacks',
    agents:             'Events Log',
    webchat:            'Webchat Messages',
    webchat_sessions:   'Webchat Sessions',
    ticket_agent_times: 'Ticket Agent Times',
    on_hook_attempt:    'On-Hook Attempts',
    quality:            'Quality',
    elearning:          'E-Learning',
    scripts:            'Scripts',
};

function getApiKey(req: Request): string {
    return (
        req.headers.get('x-api-key') ??
        req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
        new URL(req.url).searchParams.get('apiKey') ??
        ''
    );
}

/** Build per-field filter query parameters for the OpenAPI spec. */
function buildFilterParams(fieldNames: string[] | null, fieldFilters: Record<string, FieldFilterConfig> | undefined): unknown[] {
    if (!fieldNames) return [];
    const params: unknown[] = [];
    for (const field of fieldNames) {
        const config = fieldFilters?.[field];
        const type = config?.type ?? 'string';
        const ops = config?.operators ?? DEFAULT_OPERATORS[type] ?? ['equals'];

        if (ops.includes('equals')) {
            const schema = type === 'number' ? { type: 'number' } : type === 'boolean' ? { type: 'boolean' } : { type: 'string' };
            params.push({ name: field, in: 'query', schema, description: `Filter: \`${field}\` equals value.` });
        }
        const opMap: Record<string, string> = { gte: '≥', lte: '≤', gt: '>', lt: '<', contains: 'contains', startsWith: 'starts with', notEquals: '≠' };
        for (const op of ops) {
            if (op === 'equals') continue;
            const fmt = type === 'date' ? 'date-time' : type === 'number' ? undefined : undefined;
            const schema: Record<string, unknown> = type === 'number' ? { type: 'number' } : { type: 'string' };
            if (fmt) schema.format = fmt;
            params.push({ name: `${field}__${op}`, in: 'query', schema, description: `Filter: \`${field}\` ${opMap[op] ?? op} value.` });
        }
    }
    return params;
}

function handleOpenApiSpec(req: Request, groupFilter: string | null): Response {
    const key = getApiKey(req);
    if (!key) return json({ error: 'API key required (?apiKey= or x-api-key header)' }, 401);

    let accessible: ReportFeed[];
    if (groupFilter) {
        // Group-scoped: key must match at least one feed in the group → expose ALL feeds in the group.
        // All feeds in the group should share the same API key for data routes to work uniformly.
        const groupFeeds = feeds.filter(f => f.group?.toLowerCase() === groupFilter);
        if (!groupFeeds.some(f => f.apiKeys.some(k => safeEqual(key, k))))
            return json({ error: 'No feeds accessible with this API key' }, 401);
        accessible = groupFeeds;
    } else {
        accessible = feeds.filter(f => f.apiKeys.some(k => safeEqual(key, k)));
    }
    if (accessible.length === 0) return json({ error: 'No feeds accessible with this API key' }, 401);

    const tagSet = new Set(accessible.map(f => f.ownerType));
    const tags = [...tagSet].map(t => ({
        name: t,
        description: OWNER_TYPE_LABELS[t] ?? t,
    }));

    const securityRef = [{ ApiKeyHeader: [] }, { BearerToken: [] }, { ApiKeyQuery: [] }];
    const paths: Record<string, unknown> = {};

    for (const feed of accessible) {
        const entry = getReadonlyData(feed.name);
        const fieldNames = entry?.rows.length ? Object.keys(entry.rows[0]) : null;

        const rowSchema: unknown = fieldNames
            ? { type: 'object', properties: Object.fromEntries(fieldNames.map(f => [f, { type: 'string' }])) }
            : { type: 'object', additionalProperties: { type: 'string' } };

        const drDesc = feed.dateRange.type === 'relative'
            ? `last ${(feed.dateRange as any).days} day(s)`
            : `${(feed.dateRange as any).startDate} – ${(feed.dateRange as any).endDate}`;

        // Base path: use group/slug if applicable, else flat name
        const basePath = groupFilter && feed.slug
            ? `/reports/${groupFilter}/${feed.slug}`
            : `/reports/${feed.name}`;

        const listParams: unknown[] = [
            { name: 'page',  in: 'query', schema: { type: 'integer', minimum: 1 }, description: 'Page number (1-based). Omit to return all rows.' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 50 }, description: 'Rows per page (only when ?page or ?limit is set).' },
            ...buildFilterParams(fieldNames, feed.fieldFilters),
        ];

        const paginatedSchema = {
            type: 'object',
            properties: {
                total:     { type: 'integer', description: 'Total rows after filtering' },
                page:      { type: 'integer' },
                limit:     { type: 'integer' },
                returned:  { type: 'integer', description: 'Rows in this page' },
                fetchedAt: { type: 'integer', description: 'Unix ms timestamp of the last data update' },
                rows:      { type: 'array', items: rowSchema },
            },
        };
        const unpaginatedSchema = {
            type: 'object',
            properties: {
                rowCount:  { type: 'integer' },
                fetchedAt: { type: 'integer' },
                rows:      { type: 'array', items: rowSchema },
            },
        };

        paths[basePath] = {
            get: {
                operationId: `list_${feed.name}`,
                summary: feed.slug ? `${feed.slug}` : feed.name,
                description: `Returns cached rows from the **${feed.slug ?? feed.name}** report.\n\n**Data window**: ${drDesc}.\n\nData is refreshed automatically${feed.autoRefreshInterval ? ` every ${feed.autoRefreshInterval}s` : ' (manual only)'}. The \`fetchedAt\` field indicates when the snapshot was last taken.\n\n### Filtering\nUse \`?field=value\` (equals) or \`?field__op=value\` for typed operators (e.g. \`?startDate__gte=2026-01-01\`).`,
                tags: [feed.ownerType],
                security: securityRef,
                parameters: listParams,
                responses: {
                    '200': {
                        description: 'Without `?page`/`?limit` returns all rows; with pagination params returns a paged subset.',
                        content: { 'application/json': { schema: { oneOf: [unpaginatedSchema, paginatedSchema] } } },
                    },
                    '401': { description: 'Missing or invalid API key' },
                    '503': { description: 'No data cached yet' },
                },
            },
        };

        if (feed.detail) {
            const idDesc = feed.detail.idField;
            const merge = feed.detail.mergeParent && feed.detail.sourceFeed;
            const detailDesc = merge
                ? `Returns the session **summary** and all conversation **messages** for the given \`${idDesc}\`.\n\n- \`summary\` — the session row (metadata: start/end time, agent, status, etc.)\n- \`rows\` — all messages belonging to this conversation, in order.`
                : feed.detail.sourceFeed
                    ? `Returns all messages where \`${idDesc}\` equals the given id.`
                    : `Returns rows where \`${idDesc}\` equals the given id.`;

            const detailResponseProps: Record<string, unknown> = {
                id:       { type: 'string' },
                idField:  { type: 'string' },
                rowCount: { type: 'integer', description: 'Number of messages/rows returned' },
                rows:     { type: 'array', items: rowSchema },
            };
            if (merge) {
                detailResponseProps.summary = {
                    description: 'Session metadata row. `null` if no matching session found.',
                    oneOf: [rowSchema, { type: 'null' }],
                };
            }

            paths[`${basePath}/{id}`] = {
                get: {
                    operationId: `detail_${feed.name}`,
                    summary: merge ? `${feed.slug ?? feed.name} — conversation by ${idDesc}` : `${feed.slug ?? feed.name} detail by ${idDesc}`,
                    description: detailDesc,
                    tags: [feed.ownerType],
                    security: securityRef,
                    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: idDesc }],
                    responses: {
                        '200': { description: merge ? 'Session summary + messages' : 'Matching rows', content: { 'application/json': { schema: { type: 'object', properties: detailResponseProps } } } },
                        '400': { description: 'Detail route not configured on this feed' },
                        '401': { description: 'Unauthorized' },
                        '503': { description: 'Data not yet available' },
                    },
                },
            };
        }

        if (feed.audio?.enabled) {
            const audioIdField = feed.audio.idField ?? feed.detail?.idField ?? 'id';
            paths[`${basePath}/{id}/audio`] = {
                get: {
                    operationId: `audio_${feed.name}`,
                    summary: `Stream audio for ${feed.slug ?? feed.name}`,
                    description: `Streams the call recording audio file for the row identified by \`${audioIdField}\`.`,
                    tags: [feed.ownerType],
                    security: securityRef,
                    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: audioIdField }],
                    responses: {
                        '200': { description: 'Audio stream', content: { 'audio/*': {} } },
                        '400': { description: 'Audio not enabled on this feed' },
                        '401': { description: 'Unauthorized' },
                        '404': { description: 'Row or audio file not found' },
                    },
                },
            };
        }
    }

    const origin = new URL(req.url).origin;
    const spec = {
        openapi: '3.0.3',
        info: {
            title: groupFilter ? `Report API — ${groupFilter}` : 'Report API',
            version: '1.0.0',
            description: [
                '## Authentication',
                'Pass your API key using **one** of:',
                '- `x-api-key: <key>` header',
                '- `Authorization: Bearer <key>` header',
                '- `?apiKey=<key>` query parameter',
                '',
                '## Data freshness',
                'All endpoints read from a cached snapshot. The `fetchedAt` field (Unix ms) indicates the timestamp of the last data update.',
                'Data is refreshed automatically on a schedule configured by the provider.',
                '',
                '## Pagination',
                'By default, list endpoints return **all rows**. Pass `?page=1&limit=50` to paginate. The response shape changes accordingly.',
                '',
                '## Filtering',
                'Use `?field=value` for exact-match, or `?field__op=value` for typed operators:',
                '- **String**: `?field__contains=text`, `?field__startsWith=prefix`',
                '- **Number/Date**: `?field__gte=val`, `?field__lte=val`, `?field__gt=val`, `?field__lt=val`',
                '- **Boolean**: `?field=true` / `?field=false`',
            ].join('\n'),
        },
        servers: [{ url: origin }],
        tags,
        paths,
        components: {
            securitySchemes: {
                ApiKeyHeader: { type: 'apiKey', in: 'header',  name: 'x-api-key',     description: 'API key in x-api-key header' },
                BearerToken:  { type: 'http',   scheme: 'bearer',                      description: 'API key as Bearer token' },
                ApiKeyQuery:  { type: 'apiKey', in: 'query',   name: 'apiKey',         description: 'API key in ?apiKey= query param' },
            },
        },
    };

    return new Response(JSON.stringify(spec, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

function handleSwaggerDocs(req: Request, groupFilter: string | null): Response {
    const url = new URL(req.url);
    const apiKey = url.searchParams.get('apiKey') ?? '';
    const specBase = groupFilter ? `/reports/${groupFilter}/openapi.json` : '/reports/openapi.json';
    const specUrl = `${specBase}${apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : ''}`;
    const title = groupFilter ? `Report API — ${groupFilter}` : 'Report API Docs';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
<script>
  const API_KEY = ${JSON.stringify(apiKey)};
  SwaggerUIBundle({
    url: ${JSON.stringify(specUrl)},
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
    deepLinking: true,
    requestInterceptor: function(req) {
      if (API_KEY) req.headers['x-api-key'] = API_KEY;
      return req;
    }
  });
</script>
</body>
</html>`;

    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
