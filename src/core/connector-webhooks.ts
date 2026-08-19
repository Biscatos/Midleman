/**
 * Outbound delivery of connector agent events.
 *
 * Shared by the GoContact and Five9 connectors, which used to carry
 * line-for-line copies of this logic — meaning every fix had to be made twice.
 *
 * A target is delivered one of two ways:
 *
 *   • kind 'url'     — POST straight to the receiver, with optional auth and
 *                      a bounded retry/backoff loop.
 *   • kind 'webhook' — handed to a Webhook Distributor of this same Midleman,
 *                      which owns delivery from that point on (its own retry,
 *                      persistent retry, filters, templates and DLQ). This is
 *                      the durable route, and the one to prefer for a bot.
 */

import { log } from './logger';
import { logRequest, headersToRecord } from '../telemetry/request-log';
import { assertResolvedHostAllowed, type SsrfPolicyOverride } from './ssrf-guard';
import { dispatchToWebhook, enqueueFailedFanout } from '../servers/webhook-server';
import { targetKind, targetLabel, type ConnectorWebhookTarget, type ConnectorTargetAuth } from './connector-types';

/** The event shape both connectors emit. Kept structural so neither has to
 *  import the other's copy. */
export interface ConnectorAgentEvent {
    connector: string;
    channel: string;
    event: 'agent_message' | 'agent_joined' | 'chat_closed';
    reason?: 'agent' | 'admin' | 'expired';
    chatId: string;
    displayName: string;
    phoneNumberId?: string;
    message: {
        uuid: string;
        text: string | null;
        timestamp: number;
        agentName: string;
        userType?: string;
        file: { url: string; filename: string; mimetype: string; size: number | string } | null;
    } | null;
}

const FETCH_TIMEOUT_MS = 30_000;

/** Translate a target's auth into request headers. Returns an empty object when
 *  the target has none, so callers can spread it unconditionally. */
export function authHeaders(auth: ConnectorTargetAuth | undefined): Record<string, string> {
    if (!auth) return {};
    switch (auth.type) {
        case 'bearer':
            return { Authorization: `Bearer ${auth.token}` };
        case 'basic':
            return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
        case 'header':
            return { [auth.name]: auth.value };
    }
}

/**
 * Deliver one event to one target. Throws on failure so the caller can decide
 * between retrying, parking in the DLQ, or letting the poller pick it up again.
 */
export async function deliverConnectorEvent(opts: {
    connectorName: string;
    target: ConnectorWebhookTarget;
    event: ConnectorAgentEvent;
    ssrf: SsrfPolicyOverride;
    maxAttempts?: number;
}): Promise<void> {
    const { connectorName, target, event, ssrf } = opts;
    const body = JSON.stringify(event);

    if (targetKind(target) === 'webhook') {
        // The distributor takes ownership of delivery, so one attempt here is
        // right: a failure means it could not ACCEPT the event (not running),
        // which a retry loop of ours would not fix.
        await dispatchToWebhook(target.webhookName!, body, { 'X-Connector': connectorName });
        return;
    }

    const url = target.url;
    if (!url) throw new Error(`Target of connector "${connectorName}" has no url`);
    await assertResolvedHostAllowed(url, ssrf);

    const maxAttempts = opts.maxAttempts ?? 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) await Bun.sleep(1000 * Math.pow(2, attempt - 2));
        const started = performance.now();
        try {
            const headers = new Headers({ 'Content-Type': 'application/json', 'X-Connector': connectorName });
            for (const [k, v] of Object.entries(target.customHeaders || {})) headers.set(k, v);
            for (const [k, v] of Object.entries(authHeaders(target.auth))) headers.set(k, v);
            const res = await fetch(url, {
                method: target.method || 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
            } as RequestInit);
            const resText = await res.text().catch(() => null);
            logRequest({
                requestId: event.message?.uuid || crypto.randomUUID(),
                type: 'connector-fanout',
                targetName: connectorName,
                method: target.method || 'POST',
                path: `/${event.event}`,
                targetUrl: url,
                reqHeaders: headersToRecord(headers), // redacts Authorization
                reqBody: body,
                reqBodySize: body.length,
                resStatus: res.status,
                resStatusText: res.statusText,
                resBody: resText && resText.length <= 4096 ? resText : null,
                durationMs: performance.now() - started,
            });
            if (res.status >= 200 && res.status < 300) return;
            lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * How hard to try, per event kind. `agent_message` used to get a single attempt
 * everywhere, on the reasoning that the poller re-reads unacknowledged messages
 * — true in poll mode, and false in any push mode, where GoContact/Five9 hand
 * us each agent reply exactly once. There, a receiver that is down for a couple
 * of seconds silently loses the message. Push modes therefore get real retries
 * and a DLQ entry.
 */
export function attemptsFor(event: ConnectorAgentEvent['event'], pushMode: boolean): number {
    if (event === 'chat_closed') return 3;   // fire-once: the session is already gone
    if (event === 'agent_message') return pushMode ? 3 : 1;
    return 1;                                 // agent_joined is informational
}

/** True when a failed delivery of this event should be parked for manual replay
 *  rather than dropped. Same reasoning as attemptsFor. */
export function shouldParkInDlq(event: ConnectorAgentEvent['event'], pushMode: boolean): boolean {
    return event === 'chat_closed' || (event === 'agent_message' && pushMode);
}

/**
 * Park a failed delivery in the shared DLQ. The target's credential is stored
 * BY REFERENCE, never by value: request-log redaction would otherwise put the
 * literal string "[redacted]" in the headers and the replay would fail, and
 * dlq.json is plain text on disk.
 *
 * The reference carries the destination URL, and that is what the resolver
 * matches on — the index alone would drift if the target list is edited while
 * an entry waits in the queue, and could hand one receiver's secret to another.
 */
export function parkFailedDelivery(opts: {
    connectorName: string;
    target: ConnectorWebhookTarget;
    targetIndex: number;
    event: ConnectorAgentEvent;
    error: unknown;
    attempts: number;
}): void {
    const { connectorName, target, targetIndex, event } = opts;
    const body = JSON.stringify(event);
    const errMsg = opts.error instanceof Error ? opts.error.message : String(opts.error);
    enqueueFailedFanout({
        webhookName: `connector:${connectorName}`,
        requestId: crypto.randomUUID(),
        targetUrl: target.url || targetLabel(target),
        method: target.method || 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Connector': connectorName, ...(target.customHeaders || {}) },
        body,
        bodyPreview: body,
        bodySize: body.length,
        path: `/${event.event}`,
        clientIp: 'internal',
        retryConfig: undefined,
        lastError: errMsg,
        totalAttempts: opts.attempts,
        authRef: target.auth
            ? { kind: 'connector', connector: connectorName, targetIndex, targetUrl: target.url || '' }
            : undefined,
    });
    log.warn(`📥 [connector:${connectorName}] ${event.event} → ${targetLabel(target)} failed (${errMsg}) — parked in DLQ for replay`);
}
