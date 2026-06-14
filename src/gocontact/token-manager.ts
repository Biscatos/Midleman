/**
 * Shared GoContact bearer-token cache.
 *
 * GoContact issues ONE valid token per login user — every `poll/auth/token`
 * call invalidates the previous token for that user. So a per-session token
 * (the naive approach) self-destructs under concurrency: a new session's token
 * request kills the tokens every other session is still using, and they then
 * 401 on their next poll.
 *
 * Fix: one token per user, shared across all sessions AND all connectors that
 * use the same credentials, refreshed in single-flight. If two callers notice
 * the token is stale at the same instant, only ONE `requestToken` fires — the
 * other awaits it — so the two never invalidate each other.
 *
 * Scope caveat: this is in-memory, so it only coordinates within a single
 * process. Running two Midleman processes against the same GoContact user
 * (horizontal replicas, or a deploy where old+new containers overlap) brings
 * the token war back. See gocontact-connector memory note.
 */

import { log } from '../core/logger';
import type { GoToken } from './client';

interface Entry {
    token: GoToken | null;
    inflight: Promise<GoToken> | null;
}

const cache = new Map<string, Entry>();

// Generous freshness margin: refreshing a little early is cheap, refreshing too
// late is a 401. Clock skew has bitten us before, so we lean early.
const FRESH_MARGIN_S = 120;

function entryFor(key: string): Entry {
    let e = cache.get(key);
    if (!e) { e = { token: null, inflight: null }; cache.set(key, e); }
    return e;
}

function isFresh(t: GoToken): boolean {
    return t.expireTimestamp - FRESH_MARGIN_S > Math.floor(Date.now() / 1000);
}

function refresh(e: Entry, fetchFn: () => Promise<GoToken>): Promise<GoToken> {
    if (e.inflight) return e.inflight; // single-flight — coalesce concurrent refreshes
    const p = (async () => {
        const t = await fetchFn();
        e.token = t; // only poison-free: set on success only
        return t;
    })();
    e.inflight = p;
    // Clear the in-flight slot on settle (success or failure) so a failed
    // refresh (429, network) doesn't wedge the entry; the cached token is left
    // untouched on failure.
    p.then(() => { e.inflight = null; }, () => { e.inflight = null; });
    return p;
}

/** A usable token for `key`, refreshing (single-flight) only when stale. */
export function getSharedToken(key: string, fetchFn: () => Promise<GoToken>): Promise<GoToken> {
    const e = entryFor(key);
    if (e.token && isFresh(e.token)) return Promise.resolve(e.token);
    return refresh(e, fetchFn);
}

/**
 * Refresh after a 401 — but only if the cached token is still the one that
 * failed. If another caller already rotated it, return the new one without
 * hitting the auth endpoint (prevents a refresh stampede on mass invalidation).
 */
export function refreshIfCurrent(key: string, failed: GoToken, fetchFn: () => Promise<GoToken>): Promise<GoToken> {
    const e = entryFor(key);
    if (e.token && !e.inflight && e.token.token !== failed.token) return Promise.resolve(e.token);
    return refresh(e, fetchFn);
}
