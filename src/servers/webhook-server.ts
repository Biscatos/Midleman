import type { WebhookDistributor, WebhookRetryConfig, WebhookPersistentRetry } from '../core/types';
import { logRequest, headersToRecord, getLastWebhookActivity } from '../telemetry/request-log';
import { isIpAllowed } from '../core/ip-filter';
import {
    loadPersistedDlq, persistDlq, type StoredFailedFanout,
    loadPersistedPendingRetry, persistPendingRetry, type StoredPendingRetry,
} from '../core/store';
import { sendMail, isSmtpConfigured } from '../core/smtp';
import { emitNotificationEvent } from '../core/notifications';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookServer {
    webhook: WebhookDistributor;
    server: ReturnType<typeof Bun.serve>;
    activeRequests: number;
    isShuttingDown: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────────

const servers = new Map<string, WebhookServer>();

// ─── Dead Letter Queue ──────────────────────────────────────────────────────

const DLQ_MAX_SIZE = 500;

export interface FailedFanout {
    id: string;
    webhookName: string;
    requestId: string;
    targetUrl: string;
    method: string;
    headers: Record<string, string>;
    body: ArrayBuffer | string | null;
    bodyPreview: string | null;
    bodySize: number;
    path: string;
    clientIp: string;
    retryConfig: import('../core/types').WebhookRetryConfig | undefined;
    lastError: string;
    totalAttempts: number;
    failedAt: number; // Unix ms
    retrying: boolean;
}

// ─── DLQ helpers ────────────────────────────────────────────────────────────

function serializeDlqEntry(e: FailedFanout): StoredFailedFanout {
    let body: string | null = null;
    let bodyEncoding: StoredFailedFanout['bodyEncoding'] = 'none';
    if (e.body instanceof ArrayBuffer) {
        body = Buffer.from(e.body).toString('base64');
        bodyEncoding = 'base64';
    } else if (typeof e.body === 'string') {
        body = e.body;
        bodyEncoding = 'text';
    }
    const { retrying: _r, ...rest } = e;
    return { ...rest, body, bodyEncoding };
}

function deserializeDlqEntry(s: StoredFailedFanout): FailedFanout {
    let body: ArrayBuffer | string | null = null;
    if (s.bodyEncoding === 'base64' && s.body !== null) {
        body = Buffer.from(s.body, 'base64').buffer as ArrayBuffer;
    } else if (s.bodyEncoding === 'text') {
        body = s.body;
    }
    return { ...s, body, retryConfig: s.retryConfig as WebhookRetryConfig | undefined, retrying: false };
}

// Load from disk on startup
const deadLetterQueue: FailedFanout[] = loadPersistedDlq().map(deserializeDlqEntry);

// Immediate synchronous flush (used for new failures and shutdown)
export function flushDlqSync(): void {
    if (_dlqFlushTimer) { clearTimeout(_dlqFlushTimer); _dlqFlushTimer = null; }
    persistDlq(deadLetterQueue.map(serializeDlqEntry));
}

// Debounced flush — for non-critical updates (dismiss, retry metadata)
let _dlqFlushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDlqFlush(): void {
    if (_dlqFlushTimer) clearTimeout(_dlqFlushTimer);
    _dlqFlushTimer = setTimeout(() => {
        persistDlq(deadLetterQueue.map(serializeDlqEntry));
        _dlqFlushTimer = null;
    }, 500);
}

export function getDeadLetterQueue(): FailedFanout[] {
    return deadLetterQueue;
}

export function dismissFailedFanout(id: string): boolean {
    const idx = deadLetterQueue.findIndex(e => e.id === id);
    if (idx === -1) return false;
    deadLetterQueue.splice(idx, 1);
    scheduleDlqFlush();
    return true;
}

export async function retryFailedFanout(id: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    const entry = deadLetterQueue.find(e => e.id === id);
    if (!entry) return { ok: false, error: 'Not found' };
    if (entry.retrying) return { ok: false, error: 'Already retrying' };

    entry.retrying = true;
    try {
        const headers = new Headers(entry.headers);
        const body = entry.body ?? undefined;
        const { res } = await fetchWithRetry(
            entry.targetUrl,
            { method: entry.method, headers, body },
            entry.retryConfig,
            `DLQ:${entry.webhookName} → ${entry.targetUrl}`,
        );

        if (res.status >= 200 && res.status < 300) {
            dismissFailedFanout(id);
            console.log(`✅ [DLQ] Delivered ${entry.targetUrl} (${res.status}) — removed from queue`);
            return { ok: true, status: res.status };
        }

        entry.lastError = `HTTP ${res.status}`;
        entry.failedAt = Date.now();
        entry.retrying = false;
        scheduleDlqFlush();
        return { ok: false, status: res.status, error: entry.lastError };
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        entry.lastError = errorMsg;
        entry.failedAt = Date.now();
        entry.retrying = false;
        scheduleDlqFlush();
        return { ok: false, error: errorMsg };
    }
}

export async function retryAllFailedFanouts(webhookName?: string): Promise<{ retried: number; succeeded: number; failed: number }> {
    const targets = webhookName
        ? deadLetterQueue.filter(e => e.webhookName === webhookName && !e.retrying)
        : deadLetterQueue.filter(e => !e.retrying);

    const results = await Promise.all(targets.map(e => retryFailedFanout(e.id)));
    const succeeded = results.filter(r => r.ok).length;
    return { retried: targets.length, succeeded, failed: targets.length - succeeded };
}

// ─── Pending-Retry Queue ────────────────────────────────────────────────────
//
// Persistent retry: destinations with persistentRetry.enabled go here when their
// in-line retries are exhausted. They are retried forever at a throttled rate
// until either a 2xx is received or the user dismisses them.

export interface PendingRetry {
    id: string;
    webhookName: string;
    requestId: string;
    targetUrl: string;
    method: string;
    headers: Record<string, string>;
    body: ArrayBuffer | string | null;
    bodyPreview: string | null;
    bodySize: number;
    path: string;
    clientIp: string;
    retryConfig: WebhookRetryConfig | undefined;
    persistentRetry: WebhookPersistentRetry;
    lastError: string;
    attempts: number;             // count of persistent attempts so far
    enqueuedAt: number;
    lastAttemptAt: number | null;
    nextAttemptAt: number;
    notified: boolean;
    running: boolean;             // in-memory only — true while an attempt is in flight
}

function serializePending(e: PendingRetry): StoredPendingRetry {
    let body: string | null = null;
    let bodyEncoding: StoredPendingRetry['bodyEncoding'] = 'none';
    if (e.body instanceof ArrayBuffer) {
        body = Buffer.from(e.body).toString('base64');
        bodyEncoding = 'base64';
    } else if (typeof e.body === 'string') {
        body = e.body;
        bodyEncoding = 'text';
    }
    return {
        id: e.id,
        webhookName: e.webhookName,
        requestId: e.requestId,
        targetUrl: e.targetUrl,
        method: e.method,
        headers: e.headers,
        body, bodyEncoding,
        bodyPreview: e.bodyPreview,
        bodySize: e.bodySize,
        path: e.path,
        clientIp: e.clientIp,
        retryConfig: e.retryConfig,
        persistentRetry: e.persistentRetry,
        lastError: e.lastError,
        attempts: e.attempts,
        enqueuedAt: e.enqueuedAt,
        lastAttemptAt: e.lastAttemptAt,
        nextAttemptAt: e.nextAttemptAt,
        notified: e.notified,
    };
}

function deserializePending(s: StoredPendingRetry): PendingRetry {
    let body: ArrayBuffer | string | null = null;
    if (s.bodyEncoding === 'base64' && s.body !== null) {
        body = Buffer.from(s.body, 'base64').buffer as ArrayBuffer;
    } else if (s.bodyEncoding === 'text') {
        body = s.body;
    }
    return {
        ...s,
        body,
        retryConfig: s.retryConfig as WebhookRetryConfig | undefined,
        persistentRetry: s.persistentRetry as WebhookPersistentRetry,
        running: false,
    };
}

const pendingRetryQueue: PendingRetry[] = loadPersistedPendingRetry().map(deserializePending);

let _pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePendingFlush(): void {
    if (_pendingFlushTimer) clearTimeout(_pendingFlushTimer);
    _pendingFlushTimer = setTimeout(() => {
        persistPendingRetry(pendingRetryQueue.map(serializePending));
        _pendingFlushTimer = null;
    }, 500);
}
function flushPendingSync(): void {
    if (_pendingFlushTimer) { clearTimeout(_pendingFlushTimer); _pendingFlushTimer = null; }
    persistPendingRetry(pendingRetryQueue.map(serializePending));
}

export function getPendingRetryQueue(): PendingRetry[] {
    return pendingRetryQueue;
}

export function dismissPendingRetry(id: string): boolean {
    const idx = pendingRetryQueue.findIndex(e => e.id === id);
    if (idx === -1) return false;
    pendingRetryQueue.splice(idx, 1);
    flushPendingSync();
    return true;
}

function pendingMinInterval(pr: WebhookPersistentRetry): number {
    const perMin = Math.max(1, Math.min(600, pr.maxAttemptsPerMinute ?? 10));
    return Math.ceil(60_000 / perMin); // ms between attempts
}

function enqueuePendingRetry(input: {
    webhookName: string; requestId: string; targetUrl: string; method: string;
    headers: Record<string, string>; body: ArrayBuffer | string | null;
    bodyPreview: string | null; bodySize: number; path: string; clientIp: string;
    retryConfig: WebhookRetryConfig | undefined; persistentRetry: WebhookPersistentRetry;
    lastError: string; initialAttempts: number;
}) {
    const now = Date.now();
    // Cap body size identically to the DLQ to avoid disk bloat
    let body = input.body;
    if (body instanceof ArrayBuffer && body.byteLength > DLQ_MAX_BODY_SIZE) {
        body = body.slice(0, DLQ_MAX_BODY_SIZE);
    } else if (typeof body === 'string' && body.length > DLQ_MAX_BODY_SIZE) {
        body = body.slice(0, DLQ_MAX_BODY_SIZE);
    }
    const entry: PendingRetry = {
        id: crypto.randomUUID(),
        webhookName: input.webhookName,
        requestId: input.requestId,
        targetUrl: input.targetUrl,
        method: input.method,
        headers: input.headers,
        body,
        bodyPreview: input.bodyPreview,
        bodySize: input.bodySize,
        path: input.path,
        clientIp: input.clientIp,
        retryConfig: input.retryConfig,
        persistentRetry: input.persistentRetry,
        lastError: input.lastError,
        attempts: input.initialAttempts,
        enqueuedAt: now,
        lastAttemptAt: now,
        nextAttemptAt: now + pendingMinInterval(input.persistentRetry),
        notified: false,
        running: false,
    };
    pendingRetryQueue.push(entry);
    flushPendingSync();
    console.warn(`📌 [pending-retry] Enqueued ${input.targetUrl} (${input.webhookName}) — ${pendingRetryQueue.length} pending`);
    // Kick the scheduler so it picks the new entry up promptly
    runSchedulerSoon();
}

async function sendPendingNotification(entry: PendingRetry, kind: 'failure' | 'recovery'): Promise<void> {
    const subject = kind === 'failure'
        ? `Persistent fanout failing — ${entry.webhookName} → ${entry.targetUrl}`
        : `Persistent fanout recovered — ${entry.webhookName} → ${entry.targetUrl}`;
    const body = [
        kind === 'failure'
            ? `Webhook "${entry.webhookName}" has failed to deliver to ${entry.targetUrl} after ${entry.attempts} persistent attempt(s).`
            : `Webhook "${entry.webhookName}" finally delivered to ${entry.targetUrl} after ${entry.attempts} persistent attempt(s).`,
        ``,
        `Request ID: ${entry.requestId}`,
        `Method:     ${entry.method}`,
        `Target:     ${entry.targetUrl}`,
        `Last error: ${entry.lastError}`,
        `Enqueued:   ${new Date(entry.enqueuedAt).toISOString()}`,
        kind === 'failure'
            ? `\nThe system will keep retrying. Open the dashboard to inspect or cancel: /admin#webhooks`
            : `\nThe entry has been removed from the pending-retry queue.`,
    ].join('\n');

    // Route through the notifications pipeline. Rules with category
    // "webhook.retry_exhausted" / "webhook.recovered" (or wildcards) decide
    // which group + channels get this. Critical severity defaults to email+SMS.
    const category = kind === 'failure' ? 'webhook.retry_exhausted' : 'webhook.recovered';
    const severity = kind === 'failure' ? 'critical' : 'info';
    try {
        await emitNotificationEvent({
            category,
            severity,
            subject,
            body,
            payload: {
                webhookName: entry.webhookName,
                targetUrl: entry.targetUrl,
                requestId: entry.requestId,
                method: entry.method,
                attempts: entry.attempts,
                lastError: entry.lastError,
            },
        });
    } catch (e) {
        console.warn(`📧 [pending-retry] notification pipeline error:`, e);
    }

    // Back-compat: if the target still has a literal notifyEmail set (no group
    // assigned in the new pipeline), also send the legacy direct email.
    const legacyEmail = entry.persistentRetry.notifyEmail;
    if (legacyEmail && isSmtpConfigured()) {
        const html = `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#111">${body.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}</pre>`;
        const r = await sendMail({ to: legacyEmail, subject: `[Midleman] ${subject}`, html, text: body });
        if (!r.ok) console.warn(`📧 [pending-retry] legacy notify ${kind} failed: ${r.error}`);
        else console.log(`📧 [pending-retry] legacy notify ${kind} sent to ${legacyEmail}`);
    }
}

async function attemptPendingRetry(entry: PendingRetry): Promise<void> {
    if (entry.running) return;
    entry.running = true;
    try {
        const headers = new Headers(entry.headers);
        const body = entry.body ?? undefined;
        const label = `pending:${entry.webhookName} → ${entry.targetUrl}`;
        // Single-shot attempt — no inner retries, the scheduler IS the retry loop
        const res = await fetch(entry.targetUrl, {
            method: entry.method,
            headers,
            body: body as any,
            tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
        } as RequestInit);
        entry.attempts += 1;
        entry.lastAttemptAt = Date.now();
        if (res.status >= 200 && res.status < 300) {
            console.log(`✅ [${label}] Delivered (${res.status}) after ${entry.attempts} persistent attempt(s)`);
            // Recovery notification (only if a failure notification was previously sent)
            if (entry.notified) {
                try { await sendPendingNotification(entry, 'recovery'); } catch (e) { console.warn('notify recovery err', e); }
            }
            dismissPendingRetry(entry.id);
            return;
        }
        entry.lastError = `HTTP ${res.status}`;
    } catch (err) {
        entry.attempts += 1;
        entry.lastAttemptAt = Date.now();
        entry.lastError = err instanceof Error ? err.message : String(err);
    } finally {
        // schedule the next attempt
        const interval = pendingMinInterval(entry.persistentRetry);
        entry.nextAttemptAt = Date.now() + interval;
        entry.running = false;
    }

    // Notification on first cross of the threshold
    const threshold = Math.max(1, entry.persistentRetry.notifyAfterAttempts ?? 10);
    if (!entry.notified && entry.attempts >= threshold) {
        entry.notified = true;
        try { await sendPendingNotification(entry, 'failure'); }
        catch (e) { console.warn('notify failure err', e); }
    }
    schedulePendingFlush();
}

let _schedulerTimer: ReturnType<typeof setTimeout> | null = null;
function runSchedulerSoon(): void {
    if (_schedulerTimer) return;
    _schedulerTimer = setTimeout(() => {
        _schedulerTimer = null;
        pendingRetryTick();
    }, 100);
}

async function pendingRetryTick(): Promise<void> {
    const now = Date.now();
    const due = pendingRetryQueue.filter(e => !e.running && e.nextAttemptAt <= now);
    // Limit parallel attempts to avoid swamping CPU/network
    const batch = due.slice(0, 25);
    await Promise.allSettled(batch.map(e => attemptPendingRetry(e)));
}

let _schedulerInterval: ReturnType<typeof setInterval> | null = null;
export function startPendingRetryScheduler(): void {
    if (_schedulerInterval) return;
    _schedulerInterval = setInterval(() => { void pendingRetryTick(); }, 1000);
    console.log(`📌 [pending-retry] Scheduler started — ${pendingRetryQueue.length} entries restored`);
}

export function stopPendingRetryScheduler(): void {
    if (_schedulerInterval) { clearInterval(_schedulerInterval); _schedulerInterval = null; }
    if (_schedulerTimer) { clearTimeout(_schedulerTimer); _schedulerTimer = null; }
    flushPendingSync();
}

/** Force an immediate attempt on a specific entry (used by the "Retry now" UI). */
export async function retryPendingNow(id: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    const entry = pendingRetryQueue.find(e => e.id === id);
    if (!entry) return { ok: false, error: 'Not found' };
    if (entry.running) return { ok: false, error: 'Already retrying' };
    entry.nextAttemptAt = 0; // make it due
    await attemptPendingRetry(entry);
    // If still in queue, surface the last error; otherwise it succeeded.
    const still = pendingRetryQueue.find(e => e.id === id);
    return still ? { ok: false, error: still.lastError } : { ok: true };
}

const DLQ_MAX_BODY_SIZE = 256 * 1024; // 256KB per entry body

function enqueueFailedFanout(entry: Omit<FailedFanout, 'id' | 'failedAt' | 'retrying'>) {
    if (deadLetterQueue.length >= DLQ_MAX_SIZE) {
        deadLetterQueue.shift(); // drop oldest
    }
    // Cap body size to prevent large payloads bloating the DLQ
    let body = entry.body;
    if (body instanceof ArrayBuffer && body.byteLength > DLQ_MAX_BODY_SIZE) {
        body = body.slice(0, DLQ_MAX_BODY_SIZE);
    } else if (typeof body === 'string' && body.length > DLQ_MAX_BODY_SIZE) {
        body = body.slice(0, DLQ_MAX_BODY_SIZE);
    }
    deadLetterQueue.push({ ...entry, body, id: crypto.randomUUID(), failedAt: Date.now(), retrying: false });
    flushDlqSync(); // write immediately — a crash right after a failure must not lose the entry
}

// ─── Retry Helper ───────────────────────────────────────────────────────────

const DEFAULT_RETRY_ON = [429, 502, 503, 504];

async function fetchWithRetry(
    url: string,
    init: RequestInit,
    retry: WebhookRetryConfig | undefined,
    label: string,
): Promise<{ res: Response; resText: string | null; attempts: number; attemptLog: import('../telemetry/request-log').AttemptRecord[] }> {
    const maxRetries = retry?.maxRetries ?? 0;
    const baseDelay = retry?.retryDelayMs ?? 1000;
    const retryOn = retry?.retryOn ?? DEFAULT_RETRY_ON;
    const backoff = retry?.backoff ?? 'exponential';
    const retryUntilSuccess = retry?.retryUntilSuccess ?? false;

    function shouldRetry(status: number): boolean {
        if (retryUntilSuccess) return status < 200 || status >= 300;
        return retryOn.includes(status);
    }

    const attemptLog: import('../telemetry/request-log').AttemptRecord[] = [];
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let delay = 0;
        if (attempt > 0) {
            delay = backoff === 'exponential'
                ? baseDelay * Math.pow(2, attempt - 1)
                : baseDelay;
            console.warn(`🔁 [${label}] Retry ${attempt}/${maxRetries} in ${delay}ms…`);
            await Bun.sleep(delay);
        }

        const attemptStart = performance.now();
        try {
            const res = await fetch(url, { ...init, tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' } } as RequestInit);
            // Cap fanout response capture at 4KB for logging — skip for large/unknown-size responses.
            const resContentLength = parseInt(res.headers.get('content-length') || '-1', 10);
            const resText = resContentLength < 0 || resContentLength <= 4096
                ? await res.text().catch(() => null)
                : `[response not captured: ${resContentLength} bytes]`;

            const attemptDuration = performance.now() - attemptStart;
            attemptLog.push({
                attempt: attempt + 1,
                status: res.status,
                statusText: res.statusText,
                durationMs: attemptDuration,
                delayMs: delay,
            });

            if (attempt < maxRetries && shouldRetry(res.status)) {
                console.warn(`🔁 [${label}] Got ${res.status}${retryUntilSuccess ? ' (retryUntilSuccess)' : ''}, will retry (${attempt + 1}/${maxRetries})`);
                lastError = new Error(`HTTP ${res.status}`);
                continue;
            }

            if (retryUntilSuccess && (res.status < 200 || res.status >= 300)) {
                // Exhausted all retries without a 2xx — log as critical
                console.error(`🚨 [${label}] All ${maxRetries + 1} attempt(s) failed — last status: ${res.status}`);
            }

            return { res, resText, attempts: attempt + 1, attemptLog };
        } catch (err) {
            const attemptDuration = performance.now() - attemptStart;
            const errMsg = err instanceof Error ? err.message : String(err);
            attemptLog.push({
                attempt: attempt + 1,
                durationMs: attemptDuration,
                delayMs: delay,
                error: errMsg,
            });
            lastError = err;
            if (attempt >= maxRetries) {
                (err as any).__attemptLog = attemptLog;
                throw err;
            }
        }
    }

    if (lastError && typeof lastError === 'object') (lastError as any).__attemptLog = attemptLog;
    throw lastError;
}

// ─── Silence Alert Scheduler ────────────────────────────────────────────────
//
// Per-webhook inactivity watchdog. Every tick we ask the request log for the
// latest inbound webhook timestamp and compare it to the configured threshold.
// `alerted` lives only in memory: webhooks recover naturally on the next
// payload and a process restart at worst re-sends one alert, which is fine.

interface SilenceState {
    /** True once we've sent the silence email for the current episode. */
    alerted: boolean;
    /** Timestamp (ms) of the activity that triggered the alert — used in the recovery email. */
    silentSince: number | null;
}
const silenceStates = new Map<string, SilenceState>();

async function sendSilenceNotification(webhookName: string, email: string, kind: 'silent' | 'recovered', lastActivity: number, thresholdMinutes: number): Promise<void> {
    if (!isSmtpConfigured()) {
        console.warn(`📧 [silence-alert] SMTP not configured — cannot notify ${email}`);
        return;
    }
    const lastIso = new Date(lastActivity).toISOString();
    const subject = kind === 'silent'
        ? `[Midleman] Webhook silent — ${webhookName}`
        : `[Midleman] Webhook resumed — ${webhookName}`;
    const body = kind === 'silent'
        ? [
            `Webhook "${webhookName}" has not received any payload in the last ${thresholdMinutes} minute(s).`,
            ``,
            `Last activity: ${lastIso}`,
            `Threshold:     ${thresholdMinutes} min`,
            ``,
            `You will not get another alert for this episode. Open the dashboard to inspect: /admin#webhooks`,
        ].join('\n')
        : [
            `Webhook "${webhookName}" started receiving payloads again.`,
            ``,
            `Previous last activity: ${lastIso}`,
        ].join('\n');
    const html = `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#111">${body.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}</pre>`;
    const r = await sendMail({ to: email, subject, html, text: body });
    if (!r.ok) console.warn(`📧 [silence-alert] notify ${kind} failed: ${r.error}`);
    else console.log(`📧 [silence-alert] notify ${kind} sent to ${email} (${webhookName})`);
}

async function silenceTick(): Promise<void> {
    for (const ws of servers.values()) {
        const cfg = ws.webhook.silenceAlert;
        if (!cfg || !cfg.enabled || !cfg.notifyEmail) {
            // If config was turned off, drop any in-flight state so the next
            // enable starts fresh.
            silenceStates.delete(ws.webhook.name);
            continue;
        }
        const last = getLastWebhookActivity(ws.webhook.name);
        // Never received a payload — don't alert until the first delivery arrives.
        if (last === null) continue;

        const ageMs = Date.now() - last;
        const thresholdMs = Math.max(1, cfg.thresholdMinutes) * 60_000;
        const state = silenceStates.get(ws.webhook.name) || { alerted: false, silentSince: null };

        if (ageMs >= thresholdMs && !state.alerted) {
            state.alerted = true;
            state.silentSince = last;
            silenceStates.set(ws.webhook.name, state);
            try { await sendSilenceNotification(ws.webhook.name, cfg.notifyEmail, 'silent', last, cfg.thresholdMinutes); }
            catch (e) { console.warn('silence notify err', e); }
        } else if (ageMs < thresholdMs && state.alerted) {
            // Recovered — fresh activity arrived since the alert.
            const prevLast = state.silentSince ?? last;
            silenceStates.delete(ws.webhook.name);
            try { await sendSilenceNotification(ws.webhook.name, cfg.notifyEmail, 'recovered', prevLast, cfg.thresholdMinutes); }
            catch (e) { console.warn('silence notify err', e); }
        }
    }
}

let _silenceInterval: ReturnType<typeof setInterval> | null = null;
export function startSilenceAlertScheduler(): void {
    if (_silenceInterval) return;
    // 60s tick — minute granularity is the right resolution for "X minutes silent"
    _silenceInterval = setInterval(() => { void silenceTick(); }, 60_000);
    console.log(`👂 [silence-alert] Scheduler started`);
}

export function stopSilenceAlertScheduler(): void {
    if (_silenceInterval) { clearInterval(_silenceInterval); _silenceInterval = null; }
    silenceStates.clear();
}

/** Drop any silence state when a webhook is reconfigured or removed. */
export function resetSilenceState(webhookName: string): void {
    silenceStates.delete(webhookName);
}

// ─── Request Fan-out Logic ──────────────────────────────────────────────────

async function handleWebhookFanout(
    req: Request,
    webhook: WebhookDistributor,
    ws: WebhookServer,
): Promise<Response> {
    const startTime = performance.now();
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();
    const url = new URL(req.url);

    // Meta (Facebook) Webhook Verification Handshake
    if (req.method === 'GET' && url.searchParams.get('hub.mode') === 'subscribe') {
        const verifyToken = url.searchParams.get('hub.verify_token');
        if (webhook.authToken && verifyToken !== webhook.authToken) {
             console.warn(`❌ [webhook:${webhook.name}] Meta Verification failed: Invalid hub.verify_token`);
             return new Response('Invalid verify_token', { status: 403 });
        }
        const challenge = url.searchParams.get('hub.challenge');
        console.log(`✅ [webhook:${webhook.name}] Answered Meta Webhook Verification challenge`);
        return new Response(challenge || '', { status: 200 });
    }

    // Auth check (per-webhook token)
    if (webhook.authToken) {
        const providedToken = req.headers.get('X-Forward-Token') || url.searchParams.get('token') || url.searchParams.get('hub.verify_token');
        if (providedToken !== webhook.authToken) {
            console.warn(`❌ [webhook:${webhook.name}] Unauthorized ${req.method} from ${req.headers.get('X-Forwarded-For') || 'unknown'}`);
            return jsonResponse(401, {
                error: 'Unauthorized',
                message: 'Valid X-Forward-Token header or ?token=xxx query parameter is required',
            });
        }
    }

    // Read the body fully into memory once, so we can dispatch it N times
    // (We only support methods that can carry bodies, but fetch allows body for POST/PUT/PATCH/DELETE)
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let bodyBuffer: ArrayBuffer | undefined = undefined;
    let bodyStringPreview: string | null = null;
    
    if (hasBody) {
        try {
            bodyBuffer = await req.arrayBuffer();
            // Store a text preview for the logs (up to 64KB, which is safe to decode)
            if (bodyBuffer.byteLength < 64 * 1024) {
                const decoder = new TextDecoder('utf-8');
                bodyStringPreview = decoder.decode(bodyBuffer);
            } else {
                bodyStringPreview = `[large body: ${bodyBuffer.byteLength} bytes]`;
            }
        } catch (err) {
            console.error(`❌ [webhook:${webhook.name}] Failed to read request body:`, err);
            return jsonResponse(400, { error: 'Bad Request', message: 'Failed to read request body' });
        }
    }

    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';

    if (!isIpAllowed(clientIp, webhook.allowedIps)) {
        console.warn(`🚫 [webhook:${webhook.name}]: blocked IP ${clientIp}`);
        return jsonResponse(401, { error: 'Unauthorized', message: 'Your IP address is not allowed.' });
    }

    // Prepare headers (strip Midleman auth, set request ID)
    const forwardHeaders = new Headers();
    req.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'host') {
            forwardHeaders.set(key, value);
        }
    });
    forwardHeaders.delete('X-Forward-Token');
    forwardHeaders.set('X-Request-ID', requestId);

    // Attempt to parse incoming JSON for interpolations
    let payloadObj: any = null;
    if (bodyStringPreview && (req.headers.get('content-type')?.includes('application/json'))) {
        try { payloadObj = JSON.parse(bodyStringPreview); } catch {}
    }

    function renderTemplate(template: string, data: any): string {
        if (!data) return template;
        const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
        const resolvePath = (path: string): any => {
            const parts = path.split('.');
            if (parts.length > 5) return undefined;
            let val: any = data;
            for (const k of parts) {
                if (BLOCKED_KEYS.has(k) || val === undefined || val === null) return undefined;
                if (!Object.prototype.hasOwnProperty.call(val, k)) return undefined;
                val = val[k];
            }
            return val;
        };
        // Supports {{path}}, {{path || other.path}}, {{path || "literal"}} (chained).
        return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, expr) => {
            const operands = String(expr).split(/\s*\|\|\s*/);
            for (const raw of operands) {
                const op = raw.trim();
                if (!op) continue;
                // String literal: "..." or '...'
                const litMatch = op.match(/^(['"])(.*)\1$/);
                if (litMatch) return litMatch[2].slice(0, 4096);
                // Path lookup
                if (!/^[a-zA-Z0-9_.-]+$/.test(op)) continue; // ignore malformed segments
                const val = resolvePath(op);
                if (val === undefined || val === null || val === '') continue;
                if (typeof val === 'object') return JSON.stringify(val).slice(0, 4096);
                return String(val).slice(0, 4096);
            }
            return '';
        });
    }

    function stripEmptyDeep(value: any): any {
        if (Array.isArray(value)) {
            return value
                .map(stripEmptyDeep)
                .filter(v => v !== undefined && v !== null && v !== '');
        }
        if (value && typeof value === 'object') {
            const out: Record<string, any> = {};
            for (const [k, v] of Object.entries(value)) {
                const cleaned = stripEmptyDeep(v);
                if (cleaned === undefined || cleaned === null || cleaned === '') continue;
                if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
                if (Array.isArray(cleaned) && cleaned.length === 0) continue;
                out[k] = cleaned;
            }
            return out;
        }
        return value;
    }

    // Fire-and-forget background execution
    Promise.allSettled(webhook.targets.map(async (target) => {
        const fetchStart = performance.now();
        
        let tUrl: string;
        let tMethod = 'POST';
        let tHeaders = new Headers(forwardHeaders);
        let tBody: ArrayBuffer | string | undefined = bodyBuffer;
        let tBodySize = bodyBuffer?.byteLength || 0;
        let tBodyStringPreview = bodyStringPreview;

        if (typeof target === 'string') {
            tUrl = target;
        } else {
            tUrl = renderTemplate(target.url, payloadObj);
            
            if (!target.forwardHeaders) {
                tHeaders = new Headers();
            }

            if (target.method) tMethod = target.method;
            if (target.customHeaders) {
                for (const [k, v] of Object.entries(target.customHeaders)) {
                    // Only render templates if it's dynamic
                    tHeaders.set(k, renderTemplate(v, payloadObj));
                }
            }
            if (target.bodyTemplate) {
                let rendered = renderTemplate(target.bodyTemplate, payloadObj);
                if (target.dropEmpty) {
                    try {
                        const parsed = JSON.parse(rendered);
                        rendered = JSON.stringify(stripEmptyDeep(parsed));
                    } catch { /* not valid JSON — deliver as-is */ }
                }
                tBody = rendered;
                tBodyStringPreview = rendered;
                tBodySize = new TextEncoder().encode(rendered).byteLength;
                tHeaders.set('content-type', 'application/json');
            }
        }

        const persistent = (typeof target !== 'string' && target.persistentRetry?.enabled)
            ? target.persistentRetry
            : null;

        // Resolve effective in-line retry config. When persistent retry is on,
        // we skip the bounded in-line retry loop entirely — the pending-retry
        // queue IS the retry mechanism, and stacking the two would just delay
        // the first persistent attempt (e.g. exponential backoff on a 10-retry
        // distributor default can mean ~40min before the first queue attempt).
        const effectiveRetry = persistent
            ? undefined
            : ((typeof target !== 'string' && target.retry)
                ? target.retry
                : webhook.retry);

        try {
            const { res, resText, attempts, attemptLog } = await fetchWithRetry(
                tUrl,
                { method: tMethod, headers: tHeaders, body: tBody },
                effectiveRetry,
                `webhook:${webhook.name} → ${tUrl}`,
            );

            const fetchDuration = performance.now() - fetchStart;
            if (attempts > 1) {
                console.log(`✅ [webhook:${webhook.name}] Delivered to ${tUrl} after ${attempts} attempt(s)`);
            }

            // If the inline retries finished without a 2xx and this destination
            // is persistent, push it to the pending-retry queue so it keeps trying.
            if (persistent && (res.status < 200 || res.status >= 300)) {
                enqueuePendingRetry({
                    webhookName: webhook.name,
                    requestId,
                    targetUrl: tUrl,
                    method: tMethod,
                    headers: headersToRecord(tHeaders),
                    body: tBody ?? null,
                    bodyPreview: tBodyStringPreview,
                    bodySize: tBodySize,
                    path: url.pathname + url.search,
                    clientIp,
                    retryConfig: effectiveRetry,
                    persistentRetry: persistent,
                    lastError: `HTTP ${res.status}`,
                    initialAttempts: attempts,
                });
            }

            logRequest({
                requestId,
                type: 'webhook-fanout',
                targetName: webhook.name,
                method: tMethod,
                path: url.pathname + url.search,
                targetUrl: tUrl,
                clientIp,
                reqHeaders: headersToRecord(tHeaders),
                reqBody: tBodyStringPreview,
                reqBodySize: tBodySize,
                resStatus: res.status,
                resStatusText: res.statusText,
                resHeaders: headersToRecord(res.headers as unknown as Headers),
                resBody: resText,
                resBodySize: resText?.length || 0,
                durationMs: fetchDuration,
                attempts: attemptLog,
            });

        } catch (err) {
            const fetchDuration = performance.now() - fetchStart;
            const errorMsg = err instanceof Error ? err.message : String(err);
            const attemptLog = (err && typeof err === 'object' && (err as any).__attemptLog) || undefined;
            console.error(`❌ [webhook:${webhook.name}] Action to ${tUrl} failed (all attempts exhausted):`, errorMsg);

            if (persistent) {
                enqueuePendingRetry({
                    webhookName: webhook.name,
                    requestId,
                    targetUrl: tUrl,
                    method: tMethod,
                    headers: headersToRecord(tHeaders),
                    body: tBody ?? null,
                    bodyPreview: tBodyStringPreview,
                    bodySize: tBodySize,
                    path: url.pathname + url.search,
                    clientIp,
                    retryConfig: effectiveRetry,
                    persistentRetry: persistent,
                    lastError: errorMsg,
                    initialAttempts: (effectiveRetry?.maxRetries ?? 0) + 1,
                });
            } else {
                enqueueFailedFanout({
                    webhookName: webhook.name,
                    requestId,
                    targetUrl: tUrl,
                    method: tMethod,
                    headers: headersToRecord(tHeaders),
                    body: tBody ?? null,
                    bodyPreview: tBodyStringPreview,
                    bodySize: tBodySize,
                    path: url.pathname + url.search,
                    clientIp,
                    retryConfig: effectiveRetry,
                    lastError: errorMsg,
                    totalAttempts: (effectiveRetry?.maxRetries ?? 0) + 1,
                });
            }

            logRequest({
                requestId,
                type: 'webhook-fanout',
                targetName: webhook.name,
                method: tMethod,
                path: url.pathname + url.search,
                targetUrl: tUrl,
                clientIp,
                reqHeaders: headersToRecord(tHeaders),
                reqBody: tBodyStringPreview,
                reqBodySize: tBodySize,
                resStatus: 502,
                resStatusText: 'Bad Gateway',
                durationMs: fetchDuration,
                error: errorMsg,
                attempts: attemptLog,
            });
        }
    }));

    // Return immediate 202 Accepted to the caller
    const processingMs = performance.now() - startTime;
    console.log(`📡 [webhook:${webhook.name}] 202 Accepted fan-out to ${webhook.targets.length} targets (${processingMs.toFixed(2)}ms) - ${requestId}`);

    const resJson = {
        status: 'Accepted',
        message: 'Webhook payload accepted and is being fanned out.',
        targetsCount: webhook.targets.length,
        requestId,
    };

    const resPayload = JSON.stringify(resJson);

    logRequest({
        requestId,
        type: 'webhook',
        targetName: webhook.name,
        method: req.method,
        path: url.pathname + url.search,
        targetUrl: 'self',
        clientIp,
        reqHeaders: headersToRecord(req.headers),
        reqBody: bodyStringPreview,
        reqBodySize: bodyBuffer?.byteLength || 0,
        resStatus: 202,
        resStatusText: 'Accepted',
        resHeaders: { 'Content-Type': 'application/json' },
        resBody: resPayload,
        resBodySize: resPayload.length,
        durationMs: processingMs,
    });

    return new Response(resPayload, {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
    });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ─── Server Lifecycle ───────────────────────────────────────────────────────

export function startWebhookServer(webhook: WebhookDistributor): WebhookServer {
    const ws: WebhookServer = {
        webhook,
        server: null!,
        activeRequests: 0,
        isShuttingDown: false,
    };

    const server = Bun.serve({
        port: webhook.port, // 0 = OS auto-assigns
        idleTimeout: 0,
        maxRequestBodySize: 50 * 1024 * 1024, // 50MB

        async fetch(req: Request): Promise<Response> {
            if (ws.isShuttingDown) {
                return jsonResponse(503, { error: 'Service Unavailable', message: 'Server is shutting down' });
            }

            ws.activeRequests++;
            try {
                return await handleWebhookFanout(req, webhook, ws);
            } catch (error) {
                console.error(`❌ [webhook:${webhook.name}] Error:`, error);
                return jsonResponse(500, {
                    error: 'Internal Server Error',
                    message: error instanceof Error ? error.message : 'Unknown error',
                });
            } finally {
                ws.activeRequests--;
            }
        },

        error(error) {
            console.error(`[webhook:${webhook.name}] Server error:`, error);
            return jsonResponse(500, { error: 'Internal Server Error', message: 'An unexpected error occurred' });
        },
    });

    ws.server = server;
    servers.set(webhook.name, ws);

    console.log(`📡 Webhook "${webhook.name}" on :${server.port} fanning out to ${webhook.targets.length} targets`);

    return ws;
}

export async function stopWebhookServer(name: string, graceful: boolean = true): Promise<void> {
    const ws = servers.get(name);
    if (!ws) return;

    ws.isShuttingDown = true;

    if (graceful) {
        // Wait for active bounds
        const maxWait = 5000;
        const start = Date.now();
        while (ws.activeRequests > 0 && Date.now() - start < maxWait) {
            await Bun.sleep(200);
        }
    }

    ws.server.stop();
    servers.delete(name);
    console.log(`🛑 Webhook "${name}" stopped${graceful ? ' gracefully' : ' immediately'}`);
}

export async function stopAllWebhooks(): Promise<void> {
    const names = Array.from(servers.keys());
    await Promise.all(names.map(name => stopWebhookServer(name)));
}

export async function restartWebhook(webhook: WebhookDistributor): Promise<WebhookServer> {
    // For restart, we stop immediately to minimize downtime on the port
    await stopWebhookServer(webhook.name, false);
    return startWebhookServer(webhook);
}

export function getWebhookServers(): Map<string, WebhookServer> {
    return servers;
}

export function getWebhookStatus(): { name: string; port: number; targets: any[]; active: number; running: boolean; hasAuth: boolean }[] {
    return Array.from(servers.values()).map(ws => ({
        name: ws.webhook.name,
        port: ws.server.port ?? ws.webhook.port,
        targets: ws.webhook.targets,
        active: ws.activeRequests,
        running: !ws.isShuttingDown,
        hasAuth: !!ws.webhook.authToken,
    }));
}
