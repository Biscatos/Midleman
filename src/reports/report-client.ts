/**
 * GoContact Report Designer API client.
 *
 * Flow:
 *   1. Obtain bearer token via Basic Auth (reuses the shared token-manager).
 *   2. POST generateReport → receive { job_id } (async job).
 *   3. Poll GET …/{jobId}/download every POLL_INTERVAL_MS until the response
 *      is a CSV body (2xx with non-JSON content-type) or MAX_ATTEMPTS reached.
 *   4. Return raw CSV text for the caller to parse.
 *
 * Token management uses the existing GoContact shared token-manager so that
 * the same GoContact user credentials (webchat + reports) share one live token
 * and never invalidate each other.
 */

import { getSharedToken, refreshIfCurrent } from '../gocontact/token-manager';
import type { GoToken } from '../gocontact/client';
import { resolveDateRange } from './store';
import type { ReportFeed } from './types';
import { parseCsv } from './csv-parser';

const POLL_INTERVAL_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;

export class ReportClientError extends Error {
    constructor(step: string, detail: string, public readonly status?: number) {
        super(`ReportClient ${step} failed: ${detail}`);
        this.name = 'ReportClientError';
    }
}

function base(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function tokenKey(feed: ReportFeed): string {
    return `${base(feed.baseUrl)}|${feed.username}`;
}

async function fetchToken(feed: ReportFeed): Promise<GoToken> {
    const basic = Buffer.from(`${feed.username}:${feed.password}`).toString('base64');
    const res = await fetch(`${base(feed.baseUrl)}/poll/auth/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, Connection: 'Keep-Alive' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
    } as RequestInit);
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new ReportClientError('token', `HTTP ${res.status} ${text.slice(0, 200)}`);
    let data: any;
    try { data = JSON.parse(text); } catch { throw new ReportClientError('token', `invalid JSON: ${text.slice(0, 200)}`); }
    if (!data?.token) throw new ReportClientError('token', data?.message ?? 'no token in response');
    const expire = typeof data.expire_timestamp === 'number'
        ? data.expire_timestamp
        : Math.floor(Date.now() / 1000) + (typeof data.expire_in === 'number' ? data.expire_in : 3600);
    return { token: data.token, expireTimestamp: expire };
}

async function getToken(feed: ReportFeed): Promise<GoToken> {
    return getSharedToken(tokenKey(feed), () => fetchToken(feed));
}

async function authedFetch(
    feed: ReportFeed,
    path: string,
    init: RequestInit,
): Promise<Response> {
    const send = async (tok: GoToken): Promise<Response> => {
        const headers = new Headers(init.headers as HeadersInit | undefined);
        headers.set('Authorization', `Bearer ${tok.token}`);
        return fetch(`${base(feed.baseUrl)}${path}`, {
            ...init, headers,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
        } as RequestInit);
    };
    let tok = await getToken(feed);
    let res = await send(tok);
    if (res.status === 401) {
        tok = await refreshIfCurrent(tokenKey(feed), tok, () => fetchToken(feed));
        res = await send(tok);
    }
    return res;
}

/** Submit the report generation job, return the job id string. */
async function generateReportJob(feed: ReportFeed): Promise<string> {
    const { startDate, endDate } = resolveDateRange(feed.dateRange);
    const body = {
        api_download: false,
        ownerType: feed.ownerType,
        ownerId: feed.ownerIds,
        startDate,
        endDate,
        dataType: feed.dataType ?? 0,
        templateId: feed.templateId,
        includeALLOwners: feed.includeAllOwners ?? false,
        language: feed.language ?? 'en',
    };

    const res = await authedFetch(feed, '/poll/api/reportdesigner/generateReport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) throw new ReportClientError('generateReport', `HTTP ${res.status} ${text.slice(0, 300)}`, res.status);

    let data: any;
    try { data = JSON.parse(text); } catch { throw new ReportClientError('generateReport', `non-JSON response: ${text.slice(0, 300)}`); }

    // GoContact typically returns { job_id: "..." } or { id: "..." } or similar.
    const jobId = data?.job_id ?? data?.id ?? data?.jobId ?? data?.reportJobId;
    if (!jobId) throw new ReportClientError('generateReport', `no job id in response: ${text.slice(0, 300)}`);
    return String(jobId);
}

/** Poll the download endpoint until the CSV is ready. Returns raw CSV text. */
async function downloadReport(feed: ReportFeed, jobId: string, maxAttempts: number): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await authedFetch(feed, `/poll/api/reportdesigner/${encodeURIComponent(jobId)}/download`, {
            method: 'GET',
        });

        if (res.status === 202 || res.status === 204) {
            // Job still processing — wait and retry
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        if (res.status === 200) {
            const contentType = res.headers.get('content-type') ?? '';
            const text = await res.text();
            // Distinguish a ready CSV from a JSON "still processing" body
            if (!contentType.includes('application/json') || !text.trim().startsWith('{')) {
                return text;
            }
            // JSON response may mean the job isn't done yet
            let data: any;
            try { data = JSON.parse(text); } catch { return text; }
            if (data?.status === 'pending' || data?.status === 'processing' || data?.ready === false) {
                await sleep(POLL_INTERVAL_MS);
                continue;
            }
            // If the JSON doesn't indicate pending, treat the body as CSV (unusual edge case)
            return text;
        }

        if (res.status === 404) {
            // Job not found or still queued — wait and retry
            if (attempt < maxAttempts) { await sleep(POLL_INTERVAL_MS); continue; }
        }

        const text = await res.text().catch(() => '');
        throw new ReportClientError('download', `HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    throw new ReportClientError('download', `timed out after ${maxAttempts} poll attempts (~${Math.round(maxAttempts * POLL_INTERVAL_MS / 1000)}s)`);
}

/** Full flow: submit job → poll until ready → parse CSV → return rows. */
export async function fetchReport(feed: ReportFeed): Promise<Record<string, string>[]> {
    const maxAttempts = feed.maxPollAttempts ?? 30;
    const jobId = await generateReportJob(feed);
    // Give the server a moment before first poll
    await sleep(POLL_INTERVAL_MS);
    const csv = await downloadReport(feed, jobId, maxAttempts);
    return parseCsv(csv);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
