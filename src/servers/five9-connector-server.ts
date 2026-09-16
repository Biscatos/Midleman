/**
 * Five9 Digital Engagement connector server.
 *
 * Per connector:
 *   • An inbound HTTP listener (dedicated port) accepting customer messages in
 *     Meta WhatsApp Cloud API format, generic JSON, or Smooch webhook format —
 *     injected into a Five9 conversation (created on first message, then reused).
 *   • No poller — Five9 is push-only. Agent replies arrive at /five9/callback.
 *   • /five9/transfer endpoint for bot→human handover (pre-seeds the conversation).
 *
 * Token strategy: Five9 uses anonymous tokens issued per conversation. There is
 * no shared token and no token-war risk. Each session stores its own auth data.
 */

import { log } from '../core/logger';
import { deliverConnectorEvent, attemptsFor, shouldParkInDlq, parkFailedDelivery } from '../core/connector-webhooks';
import { registerDlqSsrfPolicy } from './webhook-server';
import type { Five9Connector } from '../core/connector-types-five9';
import type { NormalizedInboundMessage, MetaSettings, SmoochSettings } from '../core/connector-types';
import { Five9ApiClient, Five9Error, type Five9SessionAuth, FETCH_TIMEOUT_MS } from '../five9/client';
import {
    getFive9Session, upsertFive9Session, touchFive9Session, deleteFive9Session,
    updateFive9SessionLastInbound, markFive9SessionAutoReplied, purgeFive9ExpiredSessions,
    getFive9SessionByCorrelation, type Five9Session,
} from '../five9/sessions';
import { logRequest, headersToRecord } from '../telemetry/request-log';
import { isIpAllowed, resolveClientIp, getTrustProxyConfig } from '../core/ip-filter';
import { assertResolvedHostAllowed } from '../core/ssrf-guard';
import { timingSafeEqualStr } from '../auth/auth';
import { createHmac, createHash } from 'crypto';

// ─── Types & State ────────────────────────────────────────────────────────────

export interface Five9ConnectorServer {
    connector: Five9Connector;
    client: Five9ApiClient;
    server: ReturnType<typeof Bun.serve> | null;
    ttlTimer: ReturnType<typeof setInterval> | null;
    activeRequests: number;
    isShuttingDown: boolean;
    stats: {
        inboundMessages: number;
        agentMessages: number;
        deliveryFailures: number;
        lastInboundAt: number | null;
        lastAgentMessageAt: number | null;
        lastError: string | null;
    };
}

const servers = new Map<string, Five9ConnectorServer>();

// Per-session locks: serialize inbound handling per customer so two concurrent
// messages can't race to create duplicate Five9 conversations.
const sessionLocks = new Map<string, Promise<unknown>>();
function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (sessionLocks.get(key) ?? Promise.resolve()).catch(() => {});
    const result = prev.then(fn);
    const tail = result.catch(() => {});
    sessionLocks.set(key, tail);
    tail.then(() => { if (sessionLocks.get(key) === tail) sessionLocks.delete(key); });
    return result;
}

const reqPeerIp = new WeakMap<Request, string>();

// ─── Utilities ────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function ssrfPolicy(c: Five9Connector) {
    return { allowPrivate: c.allowPrivateTargets, allowedCidrs: c.targetAllowedCidrs };
}

function directReplyEnabled(c: Five9Connector): boolean {
    return c.directReply === true;
}

function isHttpUrl(url: string | undefined): boolean {
    if (!url) return false;
    try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch { return false; }
}

// ─── Meta WhatsApp adapter ────────────────────────────────────────────────────

const DEFAULT_GRAPH_VERSION = 'v21.0';

function graphBase(meta: MetaSettings | undefined): string {
    return `https://graph.facebook.com/${meta?.graphVersion || DEFAULT_GRAPH_VERSION}`;
}

function extensionForMime(mime: string): string {
    const base = mime.split(';')[0].trim().toLowerCase();
    const map: Record<string, string> = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
        'video/mp4': '.mp4', 'video/3gpp': '.3gp',
        'audio/aac': '.aac', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/amr': '.amr',
        'audio/ogg': '.ogg', 'audio/opus': '.ogg',
        'application/pdf': '.pdf', 'text/plain': '.txt',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.ms-excel': '.xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.ms-powerpoint': '.ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    };
    return map[base] || '';
}

function isMetaMediaHost(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'lookaside.fbsbx.com'
            || host === 'graph.facebook.com'
            || host.endsWith('.fbcdn.net')
            || host.endsWith('.whatsapp.net');
    } catch { return false; }
}

async function downloadMetaMedia(c: Five9Connector, mediaId: string): Promise<{ bytes: Uint8Array; mimetype: string; filename?: string }> {
    if (!c.meta?.accessToken) throw new Error('Meta accessToken not configured — cannot download media');
    const auth = { 'Authorization': `Bearer ${c.meta.accessToken}` };
    const metaRes = await fetch(`${graphBase(c.meta)}/${encodeURIComponent(mediaId)}`, {
        headers: auth, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!metaRes.ok) throw new Error(`Meta media lookup failed: HTTP ${metaRes.status}`);
    const meta = await metaRes.json() as any;
    if (!meta?.url) throw new Error('Meta media lookup returned no URL');
    const binRes = await fetch(meta.url, { headers: auth, signal: AbortSignal.timeout(120_000) });
    if (!binRes.ok) throw new Error(`Meta media download failed: HTTP ${binRes.status}`);
    const bytes = new Uint8Array(await binRes.arrayBuffer());
    return { bytes, mimetype: String(meta.mime_type || 'application/octet-stream') };
}

async function downloadDirectUrl(c: Five9Connector, url: string): Promise<{ bytes: Uint8Array; mimetype: string }> {
    await assertResolvedHostAllowed(url, ssrfPolicy(c));
    const headers: Record<string, string> = {};
    if (c.meta?.accessToken && isMetaMediaHost(url)) {
        headers['Authorization'] = `Bearer ${c.meta.accessToken}`;
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`File download failed: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, mimetype: res.headers.get('content-type') || 'application/octet-stream' };
}

/** Parse the full Meta webhook envelope (nested or bare value object or array). */
function parseMetaPayload(payload: any): NormalizedInboundMessage[] {
    const out: NormalizedInboundMessage[] = [];
    const values: any[] = [];
    const items: any[] = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
        if (Array.isArray(item?.entry)) {
            for (const entry of item.entry) {
                const changes = Array.isArray(entry?.changes) ? entry.changes : [];
                for (const change of changes) {
                    if (change?.value) values.push(change.value);
                }
            }
        } else if (Array.isArray(item?.messages)) {
            values.push(item);
        } else if (item?.value && Array.isArray(item.value.messages)) {
            values.push(item.value);
        }
    }
    for (const value of values) {
        const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
        const messages = Array.isArray(value?.messages) ? value.messages : [];
        const phoneNumberId = value?.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : undefined;
        for (const msg of messages) {
            const from = String(msg.from || '');
            if (!from) continue;
            const contact = contacts.find((ct: any) => ct?.wa_id === from);
            const displayName = String(contact?.profile?.name || from);
            const norm: NormalizedInboundMessage = {
                chatId: from, displayName, phoneNumberId,
                messageId: msg.id ? String(msg.id) : undefined,
            };
            switch (msg.type) {
                case 'text':
                    norm.text = String(msg.text?.body ?? '');
                    break;
                case 'button':
                    norm.text = String(msg.button?.text ?? '');
                    break;
                case 'interactive':
                    norm.text = String(msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '');
                    break;
                case 'image': case 'video': case 'audio': case 'sticker': case 'document': {
                    const media = msg[msg.type] || {};
                    const mimetype = String(media.mime_type || 'application/octet-stream');
                    norm.file = {
                        url: media.url ? String(media.url) : undefined,
                        metaMediaId: String(media.id || ''),
                        mimetype,
                        filename: String(media.filename || `${msg.type}-${Date.now()}${extensionForMime(mimetype)}`),
                    };
                    if (media.caption) norm.text = String(media.caption);
                    break;
                }
                case 'location':
                    norm.text = `📍 ${msg.location?.latitude},${msg.location?.longitude}` +
                        (msg.location?.name ? ` (${msg.location.name})` : '');
                    break;
                default:
                    continue;
            }
            if (norm.text || norm.file) out.push(norm);
        }
    }
    return out;
}

function parseGenericPayload(payload: any): NormalizedInboundMessage[] {
    const items = Array.isArray(payload?.messages) ? payload.messages : [payload];
    const out: NormalizedInboundMessage[] = [];
    for (const m of items) {
        const chatId = String(m?.chatId || m?.idChat || m?.from || '');
        if (!chatId) continue;
        const norm: NormalizedInboundMessage = {
            chatId,
            displayName: String(m?.name || m?.displayName || chatId),
        };
        if (m?.text || m?.message || m?.mensagem) norm.text = String(m.text ?? m.message ?? m.mensagem);
        if (m?.file && typeof m.file === 'object' && m.file.url) {
            norm.file = {
                url: String(m.file.url),
                filename: m.file.filename ? String(m.file.filename) : undefined,
                mimetype: m.file.mimetype ? String(m.file.mimetype) : undefined,
                size: typeof m.file.size === 'number' ? m.file.size : undefined,
            };
        }
        if (norm.text || norm.file) out.push(norm);
    }
    return out;
}

function parseSmoochPayload(payload: any): NormalizedInboundMessage[] {
    const out: NormalizedInboundMessage[] = [];
    // v1.x
    if (Array.isArray(payload?.messages) && !Array.isArray(payload?.events)) {
        const conversationId = String(payload?.conversation?._id ?? payload?.conversation?.id ?? '');
        const appUserName = [payload?.appUser?.givenName, payload?.appUser?.surname].filter(Boolean).join(' ').trim();
        if (!conversationId) return out;
        for (const m of payload.messages) {
            if (String(m?.role || '').toLowerCase() !== 'appuser') continue;
            const norm: NormalizedInboundMessage = {
                chatId: conversationId,
                displayName: String(m?.name || appUserName || conversationId),
                messageId: String(m?._id || ''),
            };
            const type = String(m?.type || '').toLowerCase();
            if (type === 'text') { norm.text = String(m?.text ?? ''); }
            else if (type === 'image' || type === 'file') {
                if (m?.mediaUrl) { norm.file = { url: String(m.mediaUrl), mimetype: m.mediaType ? String(m.mediaType) : undefined, filename: m.altText ? String(m.altText) : undefined }; }
                if (m?.text) norm.text = String(m.text);
            } else { continue; }
            if (norm.text || norm.file) out.push(norm);
        }
        return out;
    }
    // v2
    const events = Array.isArray(payload?.events) ? payload.events : [];
    for (const ev of events) {
        if (ev?.type && ev.type !== 'conversation:message') continue;
        const p = ev?.payload ?? ev;
        const conversationId = String(p?.conversation?.id ?? p?.conversation?._id ?? '');
        const message = p?.message ?? p;
        const author = message?.author ?? {};
        if (String(author.type || '').toLowerCase() !== 'user') continue;
        if (!conversationId) continue;
        const norm: NormalizedInboundMessage = {
            chatId: conversationId,
            displayName: String(author.displayName || author.userId || conversationId),
            messageId: message?.id ? String(message.id) : undefined,
        };
        const content = message?.content ?? {};
        const type = String(content.type || '').toLowerCase();
        if (type === 'text') { norm.text = String(content.text ?? ''); }
        else if (type === 'image' || type === 'file') {
            if (content.mediaUrl) { norm.file = { url: String(content.mediaUrl), mimetype: content.mediaType ? String(content.mediaType) : undefined, filename: content.altText ? String(content.altText) : undefined }; }
            if (content.text) norm.text = String(content.text);
        } else { continue; }
        if (norm.text || norm.file) out.push(norm);
    }
    return out;
}

// ─── Smooch adapter ───────────────────────────────────────────────────────────

function smoochBase(c: Five9Connector): string {
    return (c.smooch?.baseUrl || 'https://api.smooch.io').replace(/\/$/, '');
}

function smoochAuthHeader(c: Five9Connector): string {
    const s = c.smooch!;
    if (s.bearerToken) return `Bearer ${s.bearerToken}`;
    return 'Basic ' + Buffer.from(`${s.keyId}:${s.keySecret}`).toString('base64');
}

function verifySmoochSignature(secret: string, rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
    return timingSafeEqualStr(expected, signature.trim());
}

// ─── Outbound channel sends ───────────────────────────────────────────────────

async function sendToMeta(
    c: Five9Connector,
    chatId: string,
    text: string | null,
    file: { url: string; mimetype: string; filename?: string } | null,
    sessionPhoneNumberId?: string,
): Promise<void> {
    const phoneNumberId = sessionPhoneNumberId || c.meta?.phoneNumberId;
    if (!c.meta?.accessToken || !phoneNumberId) throw new Error('Meta credentials not configured (accessToken + phone_number_id)');
    if (file && !isHttpUrl(file.url)) {
        text = text || (file.filename ? `📎 ${file.filename}` : text);
        file = null;
    }
    let body: Record<string, unknown>;
    if (file) {
        const kind = file.mimetype.startsWith('image/') ? 'image'
            : file.mimetype.startsWith('audio/') ? 'audio'
            : file.mimetype.startsWith('video/') ? 'video'
            : 'document';
        const media: Record<string, unknown> = { link: file.url };
        if (text) media.caption = text;
        if (kind === 'document' && file.filename) media.filename = file.filename;
        body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: chatId, type: kind, [kind]: media };
    } else {
        body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: chatId, type: 'text', text: { body: text ?? '' } };
    }
    const metaUrl = `${graphBase(c.meta)}/${phoneNumberId}/messages`;
    const reqBody = JSON.stringify(body);
    const started = performance.now();
    const res = await fetch(metaUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.meta.accessToken}`, 'Content-Type': 'application/json' },
        body: reqBody,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const resText = await res.text().catch(() => '');
    logRequest({
        requestId: crypto.randomUUID(), type: 'connector-fanout', targetName: c.name,
        method: 'POST', path: '/meta/reply', targetUrl: metaUrl,
        reqHeaders: { 'Content-Type': 'application/json' }, reqBody, reqBodySize: reqBody.length,
        resStatus: res.status, resStatusText: res.statusText,
        resBody: resText.slice(0, 2000), durationMs: performance.now() - started,
    });
    if (!res.ok) throw new Error(`Meta send failed: HTTP ${res.status} ${resText.slice(0, 300)}`);
}

async function sendMetaReadReceipt(c: Five9Connector, phoneNumberId: string, messageId: string): Promise<void> {
    if (!c.meta?.accessToken) return;
    const res = await fetch(`${graphBase(c.meta)}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.meta.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`Meta read receipt failed: HTTP ${res.status} ${err.slice(0, 200)}`);
    }
}

function markCustomerReadOnMeta(cs: Five9ConnectorServer, session: Five9Session): void {
    const c = cs.connector;
    if (c.channel === 'meta-whatsapp' && directReplyEnabled(c) && session.lastInboundMsgId && session.phoneNumberId) {
        sendMetaReadReceipt(c, session.phoneNumberId, session.lastInboundMsgId)
            .then(() => { updateFive9SessionLastInbound(c.name, session.chatId, ''); })
            .catch(err => log.warn(`⚠️ [five9:${c.name}] read receipt failed:`, err instanceof Error ? err.message : err));
    }
}

async function sendToSmooch(
    c: Five9Connector,
    conversationId: string,
    text: string | null,
    file: { url: string; mimetype: string; filename?: string } | null,
): Promise<void> {
    const s = c.smooch;
    if (!s?.appId || (!s.bearerToken && !(s.keyId && s.keySecret))) throw new Error('Smooch credentials not configured');
    let content: Record<string, unknown>;
    if (file && isHttpUrl(file.url)) {
        content = {
            type: file.mimetype.startsWith('image/') ? 'image' : 'file',
            mediaUrl: file.url,
            ...(file.filename ? { altText: file.filename } : {}),
            ...(text ? { text } : {}),
        };
    } else {
        const body = text || (file?.filename ? `📎 ${file.filename}` : '');
        if (!body) throw new Error('Nothing to send (no text and no usable media URL)');
        content = { type: 'text', text: body };
    }
    const url = `${smoochBase(c)}/v2/apps/${encodeURIComponent(s.appId)}/conversations/${encodeURIComponent(conversationId)}/messages`;
    const reqBody = JSON.stringify({ author: { type: 'business' }, content });
    const started = performance.now();
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': smoochAuthHeader(c), 'Content-Type': 'application/json' },
        body: reqBody,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const resText = await res.text().catch(() => '');
    logRequest({
        requestId: crypto.randomUUID(), type: 'connector-fanout', targetName: c.name,
        method: 'POST', path: '/smooch/reply', targetUrl: url,
        reqHeaders: { 'Content-Type': 'application/json' }, reqBody, reqBodySize: reqBody.length,
        resStatus: res.status, resStatusText: res.statusText,
        resBody: resText.slice(0, 2000), durationMs: performance.now() - started,
    });
    if (!res.ok) throw new Error(`Smooch send failed: HTTP ${res.status} ${resText.slice(0, 300)}`);
}

// ─── AgentEvent + fan-out ─────────────────────────────────────────────────────

interface AgentEvent {
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

/** Five9 sends timestamps as ISO-8601 strings ("2026-09-15T18:22:53.707Z") or epoch ms. */
function parseFive9Timestamp(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
        const d = Date.parse(v);
        if (Number.isFinite(d)) return d;
    }
    return Date.now();
}

/** Per-leg timings of the last fan-out, for latency diagnosis in logs. */
interface FanoutTimings { meta_ms?: number; smooch_ms?: number; webhook_ms?: number; total_ms: number }

function timed(job: Promise<void>, sink: (ms: number) => void): Promise<void> {
    const t = performance.now();
    return job.finally(() => sink(Math.round(performance.now() - t)));
}

async function fanoutFive9Event(cs: Five9ConnectorServer, session: Five9Session | null, event: AgentEvent, timings?: FanoutTimings): Promise<void> {
    const c = cs.connector;
    const jobs: Promise<void>[] = [];
    const t0 = performance.now();
    const tm: FanoutTimings = timings ?? { total_ms: 0 };

    if (directReplyEnabled(c) && event.event === 'agent_message' && event.message) {
        if (c.channel === 'meta-whatsapp') {
            jobs.push(timed(sendToMeta(c, event.chatId, event.message.text, event.message.file, session?.phoneNumberId || event.phoneNumberId), ms => { tm.meta_ms = ms; }));
        } else if (c.channel === 'smooch') {
            jobs.push(timed(sendToSmooch(c, event.chatId, event.message.text, event.message.file), ms => { tm.smooch_ms = ms; }));
        }
    }

    // Five9 is push-only — nothing re-reads an agent reply we failed to deliver,
    // so agent_message gets real retries and a DLQ entry, same as chat_closed.
    const allTargets = c.webhooksEnabled !== false ? c.webhookTargets || [] : [];
    allTargets.forEach((target, targetIndex) => {
        const attempts = attemptsFor(event.event, true);
        let job = deliverConnectorEvent({ connectorName: c.name, target, event, ssrf: ssrfPolicy(c), maxAttempts: attempts });
        if (shouldParkInDlq(event.event, true)) {
            job = job.catch(err => {
                parkFailedDelivery({ connectorName: c.name, target, targetIndex, event, error: err, attempts });
            });
        }
        jobs.push(timed(job, ms => { tm.webhook_ms = Math.max(tm.webhook_ms ?? 0, ms); }));
    });

    const results = await Promise.allSettled(jobs);
    tm.total_ms = Math.round(performance.now() - t0);
    const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
        cs.stats.deliveryFailures += failures.length;
        const msg = failures.map(f => f.reason instanceof Error ? f.reason.message : String(f.reason)).join('; ');
        throw new Error(`${failures.length}/${jobs.length} deliveries failed: ${msg}`);
    }
}

// ─── Structured logging ───────────────────────────────────────────────────────
//
// Every Five9 failure is emitted as ONE line with a fixed marker + key=value
// fields, so it can be found and parsed from system logs, e.g.:
//
//   ❌ FIVE9_ERROR connector=reomat step=anon-auth http_status=435 five9_error_code=500
//      five9_message="Internal Server Error" tenant=REOMAT five9_host=app.nld1.eu.five9.com
//      chat_id=244939609354 duration_ms=812 url=https://app.nld1.eu.five9.com/appsvcs/rs/svc/auth/anon
//
// grep tips:  grep FIVE9_ERROR | grep step=anon-auth
//             grep 'FIVE9_ERROR connector=reomat'

type LogFields = Record<string, string | number | boolean | undefined | null>;

function fmtFields(fields: LogFields): string {
    return Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => {
            const s = String(v);
            return /[\s"=]/.test(s) ? `${k}=${JSON.stringify(s)}` : `${k}=${s}`;
        })
        .join(' ');
}

function five9Host(c: Five9Connector): string {
    try { return new URL(c.five9.authBaseUrl).host; } catch { return c.five9.authBaseUrl; }
}

/** Base fields present on every Five9 log line for a connector. */
function baseFields(c: Five9Connector, msg?: NormalizedInboundMessage): LogFields {
    return {
        connector: c.name,
        tenant: c.five9.tenantName,
        campaign: c.five9.campaignName,
        five9_host: five9Host(c),
        chat_id: msg?.chatId,
        phone_number_id: msg?.phoneNumberId || undefined,
        msg_id: msg?.messageId || undefined,
    };
}

/** Classify an error into a stable `error_kind` for filtering/alerting. */
function classifyFive9Error(err: unknown): string {
    if (err instanceof Five9Error) {
        const d = err.detail;
        if (err.conversationGone) return 'conversation_gone';
        if (d.httpStatus === undefined && err.message.includes('network error')) return 'network';
        if (d.httpStatus === 435) return d.five9ErrorCode === 500 ? 'five9_internal_error' : 'five9_auth_rejected';
        if (d.httpStatus === 401 || d.httpStatus === 403) return 'five9_unauthorized';
        if (d.httpStatus !== undefined && d.httpStatus >= 500) return 'five9_server_error';
        if (d.httpStatus !== undefined && d.httpStatus >= 400) return 'five9_client_error';
        return 'five9_response_invalid';
    }
    if (err instanceof Error && /timed? ?out|abort/i.test(err.message)) return 'timeout';
    return 'unknown';
}

/** Emit the single structured FIVE9_ERROR line. */
function logFive9Error(c: Five9Connector, msg: NormalizedInboundMessage | undefined, err: unknown, extra: LogFields = {}): void {
    const errFields: LogFields = err instanceof Five9Error
        ? err.toLogFields()
        : { step: extra.step ?? 'unknown', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    const fields: LogFields = {
        ...baseFields(c, msg),
        error_kind: classifyFive9Error(err),
        ...errFields,
        ...extra,
    };
    log.error(`❌ FIVE9_ERROR ${fmtFields(fields)}`);
}

/** Emit a structured FIVE9_STEP line (info) for successful steps. */
function logFive9Step(c: Five9Connector, msg: NormalizedInboundMessage | undefined, step: string, extra: LogFields = {}): void {
    log.info(`🔷 FIVE9_STEP ${fmtFields({ ...baseFields(c, msg), step, ...extra })}`);
}

// ─── Session management ───────────────────────────────────────────────────────

function sessionKeyFor(msg: NormalizedInboundMessage): string {
    return msg.phoneNumberId ? `${msg.phoneNumberId}:${msg.chatId}` : msg.chatId;
}

/** Build the Five9 callbackUrl, appending the token if configured. */
function buildCallbackUrl(c: Five9Connector): string {
    const base = c.five9.callbackUrl;
    if (!c.five9.callbackToken) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}token=${encodeURIComponent(c.five9.callbackToken)}`;
}

/** Derive a stable contact number in E.164 (+prefix) from the chatId or msg.chatId. */
function toE164(phone: string): string {
    const raw = phone.includes(':') ? phone.split(':')[1] : phone;
    return raw.startsWith('+') ? raw : `+${raw}`;
}

async function ensureFive9Session(cs: Five9ConnectorServer, msg: NormalizedInboundMessage): Promise<Five9Session> {
    const c = cs.connector;
    const ttl = c.sessionTtlMinutes ?? 120;
    const key = sessionKeyFor(msg);

    const existing = getFive9Session(c.name, key);
    if (existing && Date.now() - existing.lastActivityAt < ttl * 60_000) {
        return existing;
    }
    if (existing) deleteFive9Session(c.name, key);

    // New session: anon auth → create conversation → poll until ACTIVE
    // Each step logs a FIVE9_STEP line on success; failures bubble up as
    // Five9Error (with step + Five9 error envelope) and are logged once by the
    // caller as FIVE9_ERROR.
    logFive9Step(c, msg, 'session-start', { session_key: key, reason: existing ? 'expired' : 'new' });

    let t = performance.now();
    const auth = await cs.client.anonAuth(c.five9.tenantName);
    logFive9Step(c, msg, 'anon-auth', {
        duration_ms: Math.round(performance.now() - t),
        farm_id: auth.farmId, org_id: auth.orgId, api_host: auth.apiHost,
    });

    const nameParts = msg.displayName.split(' ');
    const firstName = nameParts[0] || msg.chatId;
    const lastName = nameParts.slice(1).join(' ') || '';
    const number1 = toE164(msg.chatId);
    const question = msg.text || '(arquivo)';

    t = performance.now();
    const correlationId = await cs.client.createConversation(auth, {
        externalId: msg.chatId.replace(':', '_'), // Five9 externalId shouldn't contain colons
        campaignName: c.five9.campaignName,
        callbackUrl: buildCallbackUrl(c),
        contact: { firstName, lastName, number1 },
        question,
    });
    logFive9Step(c, msg, 'create-conversation', {
        duration_ms: Math.round(performance.now() - t),
        correlation_id: correlationId, callback_url: c.five9.callbackUrl, // token deliberately omitted
    });

    t = performance.now();
    await cs.client.waitForActive(auth, correlationId);
    logFive9Step(c, msg, 'wait-active', { duration_ms: Math.round(performance.now() - t), correlation_id: correlationId });

    const now = Date.now();
    const session: Five9Session = {
        connector: c.name,
        chatId: key,
        customerId: msg.chatId,
        displayName: msg.displayName,
        correlationId,
        tokenId: auth.tokenId,
        farmId: auth.farmId,
        apiHost: auth.apiHost,
        cloudClientUrl: auth.cloudClientUrl,
        orgId: auth.orgId,
        phoneNumberId: msg.phoneNumberId || '',
        lastInboundMsgId: msg.messageId || '',
        autoReplied: false,
        createdAt: now,
        lastActivityAt: now,
    };
    upsertFive9Session(session);
    log.info(`🤝 [five9:${c.name}] New session ${key} → Five9 conversation ${correlationId}`);
    return session;
}

// ─── Inbound injection ────────────────────────────────────────────────────────

function sessionToAuth(s: Five9Session): Five9SessionAuth {
    return {
        tokenId: s.tokenId,
        farmId: s.farmId,
        apiHost: s.apiHost,
        cloudClientUrl: s.cloudClientUrl,
        orgId: s.orgId,
    };
}

async function injectFive9Inbound(cs: Five9ConnectorServer, session: Five9Session, msg: NormalizedInboundMessage): Promise<void> {
    const c = cs.connector;
    const auth = sessionToAuth(session);

    if (msg.file) {
        // Download from source
        let bytes: Uint8Array;
        let mimetype: string;
        let filename = msg.file.filename || `file${extensionForMime(msg.file.mimetype || '')}`;

        if (msg.file.url) {
            try {
                const dl = await downloadDirectUrl(c, msg.file.url);
                bytes = dl.bytes; mimetype = dl.mimetype;
            } catch (err) {
                if (!msg.file.metaMediaId) throw err;
                log.warn(`⚠️ [five9:${c.name}] Direct URL download failed — falling back to Meta media id`);
                const dl = await downloadMetaMedia(c, msg.file.metaMediaId);
                bytes = dl.bytes; mimetype = dl.mimetype;
                if (dl.filename) filename = dl.filename;
            }
        } else if (msg.file.metaMediaId) {
            const dl = await downloadMetaMedia(c, msg.file.metaMediaId);
            bytes = dl.bytes; mimetype = dl.mimetype;
            if (dl.filename) filename = dl.filename;
        } else {
            // No downloadable source — send as text note
            const note = msg.text || (msg.file.filename ? `📎 ${msg.file.filename}` : '(arquivo)');
            await cs.client.sendText(auth, session.correlationId, note);
            return;
        }

        const fileDownloadId = await cs.client.uploadClientFile(auth, bytes, filename, mimetype || 'application/octet-stream');
        await cs.client.sendFileMessage(auth, session.correlationId, fileDownloadId, msg.text || '', filename);
        return;
    }

    if (msg.text) {
        await cs.client.sendText(auth, session.correlationId, msg.text);
    }
}

async function deliverFive9Inbound(cs: Five9ConnectorServer, msg: NormalizedInboundMessage): Promise<Five9Session> {
    const c = cs.connector;
    const key = sessionKeyFor(msg);

    return withSessionLock(`${c.name}:${key}`, async () => {
        let session = await ensureFive9Session(cs, msg);
        const sessionKey = session.chatId;

        // Track latest inbound message id for read receipts
        if (msg.messageId) updateFive9SessionLastInbound(c.name, sessionKey, msg.messageId);

        try {
            await injectFive9Inbound(cs, session, msg);
        } catch (err) {
            if (err instanceof Five9Error && err.conversationGone) {
                log.warn(`⚠️ FIVE9_WARN ${fmtFields({
                    ...baseFields(c, msg), ...err.toLogFields(),
                    correlation_id: session.correlationId, action: 'recreate-session',
                })}`);
                deleteFive9Session(c.name, sessionKey);
                session = await ensureFive9Session(cs, msg);
                await injectFive9Inbound(cs, session, msg);
            } else {
                throw err;
            }
        }

        // Auto-reply (once per session, first message only)
        const ar = c.autoReply;
        if (ar?.enabled && !session.autoReplied) {
            const expiresAt = ar.expiresAt ? new Date(ar.expiresAt).getTime() : Infinity;
            if (Date.now() <= expiresAt) {
                const event: AgentEvent = {
                    connector: c.name, channel: c.channel, event: 'agent_message',
                    chatId: session.customerId, displayName: session.displayName,
                    phoneNumberId: session.phoneNumberId || undefined,
                    message: {
                        uuid: crypto.randomUUID(), text: ar.text, timestamp: Date.now(),
                        agentName: 'Auto-reply', userType: 'BOT', file: null,
                    },
                };
                fanoutFive9Event(cs, session, event).catch(err =>
                    log.warn(`⚠️ [five9:${c.name}] auto-reply fan-out failed:`, err instanceof Error ? err.message : err));
                markFive9SessionAutoReplied(c.name, sessionKey);
            }
        }

        touchFive9Session(c.name, sessionKey);
        cs.stats.inboundMessages++;
        cs.stats.lastInboundAt = Date.now();
        return session;
    });
}

// ─── Five9 callback handler ───────────────────────────────────────────────────

/** Generate a stable dedup UUID from correlationId + a discriminator. */
function stableUuid(correlationId: string, discriminator: string): string {
    return createHash('sha256').update(`${correlationId}:${discriminator}`).digest('hex').slice(0, 32);
}

/** Extract the last path segment of a URL path string. */
function lastPathSegment(urlPath: string): string {
    return urlPath.replace(/\/$/, '').split('/').pop() || '';
}

async function handleFive9Callback(req: Request, cs: Five9ConnectorServer, clientIp: string): Promise<Response> {
    const c = cs.connector;
    const url = new URL(req.url);

    // Auth: callbackToken (appended to callbackUrl when creating conversations)
    const cbToken = c.five9.callbackToken;
    const provided = url.searchParams.get('token') || req.headers.get('x-callback-token');
    if (cbToken) {
        if (!timingSafeEqualStr(provided, cbToken)) {
            log.warn(`🚫 FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'rejected', reason: 'bad-token', token_present: !!provided, client_ip: clientIp, path: url.pathname })}`);
            return jsonResponse(401, { error: 'Unauthorized' });
        }
    } else if (!c.allowedIps || c.allowedIps.length === 0) {
        log.warn(`🚫 FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'rejected', reason: 'no-token-no-allowlist', client_ip: clientIp, path: url.pathname })}`);
        return jsonResponse(401, { error: 'Unauthorized', message: 'Configure five9.callbackToken or allowedIps' });
    }

    let body: any;
    let rawBody = '';
    try { rawBody = await req.text(); body = JSON.parse(rawBody); }
    catch {
        log.warn(`⚠️ FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'rejected', reason: 'invalid-json', path: url.pathname, client_ip: clientIp, payload: rawBody.slice(0, 1000) })}`);
        return jsonResponse(400, { error: 'Bad Request', message: 'Body must be valid JSON' });
    }

    // ── Resolve the event type ─────────────────────────────────────────────────
    // Five9 may deliver the callback in two shapes:
    //   (a) wrapped:  { query: { original_url: ".../message" }, body: {...} }
    //   (b) direct:   POST {callbackUrl}/<event>  with the event payload as body
    // For (b) the event is the path segment after the configured callbackUrl.
    const originalUrl: string = body?.query?.original_url ?? '';
    const inner: any = body?.body && typeof body.body === 'object' ? body.body : body ?? {};
    let cbBasePath = '';
    try { cbBasePath = new URL(c.five9.callbackUrl).pathname.replace(/\/$/, ''); } catch {}
    const reqPath = url.pathname.replace(/\/$/, '');
    const pathTail = cbBasePath && reqPath.startsWith(cbBasePath) ? reqPath.slice(cbBasePath.length) : reqPath;
    const pathSegment = lastPathSegment(pathTail);
    const bodyHint = String(inner?.eventType ?? inner?.event ?? inner?.type ?? body?.eventType ?? body?.event ?? '').toLowerCase();

    const segment: string = originalUrl ? lastPathSegment(originalUrl)
        : pathSegment && pathSegment !== lastPathSegment(cbBasePath) ? pathSegment
        : bodyHint;
    const looksLikeFile = !!inner?.fileData || segment === 'file' || segment === 'attachment' || segment === 'files';
    const cbCorrelationId = String(inner?.correlationId ?? body?.correlationId ?? '');

    log.info(`📥 FIVE9_CALLBACK ${fmtFields({
        connector: c.name, result: 'received',
        event: looksLikeFile ? 'file' : (segment || 'unknown'),
        path: url.pathname, original_url: originalUrl || undefined, shape: body?.body ? 'wrapped' : 'direct',
        correlation_id: cbCorrelationId || undefined, client_ip: clientIp,
        direct_reply: directReplyEnabled(c), webhook_targets: (c.webhookTargets || []).length,
        body_keys: Object.keys(inner || {}).slice(0, 20).join(','),
        payload: rawBody.slice(0, 2000),
    })}`);

    // ── File attachment ────────────────────────────────────────────────────────
    if (looksLikeFile) {
        const correlationId = cbCorrelationId;
        const fileUrl = String(inner?.text || '');
        const category = String(inner?.fileData?.category || 'document');
        const agentName = String(inner?.agentData?.displayName || 'Agent');
        const timestamp = parseFive9Timestamp(inner?.timestamp);

        if (!correlationId) {
            log.warn(`⚠️ FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'ignored', reason: 'no-correlationId', event: 'file', path: url.pathname })}`);
            return jsonResponse(200, { status: 'ignored', reason: 'no-correlationId' });
        }
        const session = getFive9SessionByCorrelation(c.name, correlationId);
        if (!session) {
            log.warn(`⚠️ FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'ignored', reason: 'unknown-conversation', event: 'file', correlation_id: correlationId })}`);
            return jsonResponse(200, { status: 'ignored', reason: 'unknown-conversation' });
        }

        const mimetype = category === 'image' ? 'image/jpeg'
            : category === 'video' ? 'video/mp4'
            : category === 'audio' ? 'audio/mpeg'
            : 'application/octet-stream';
        const event: AgentEvent = {
            connector: c.name, channel: c.channel, event: 'agent_message',
            chatId: session.customerId, displayName: session.displayName,
            phoneNumberId: session.phoneNumberId || undefined,
            message: {
                uuid: stableUuid(correlationId, String(timestamp)),
                text: null, timestamp,
                agentName, userType: 'AGENT',
                file: { url: fileUrl, filename: `${category}${extensionForMime(mimetype)}`, mimetype, size: 0 },
            },
        };
        try { await fanoutFive9Event(cs, session, event); }
        catch (err) {
            cs.stats.lastError = err instanceof Error ? err.message : String(err);
            log.warn(`⚠️ FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'fanout-failed', event: 'file', correlation_id: correlationId, chat_id: session.customerId, direct_reply: directReplyEnabled(c), meta_token: !!c.meta?.accessToken, error: cs.stats.lastError })}`);
            return jsonResponse(502, { error: 'fan-out failed' });
        }
        touchFive9Session(c.name, session.chatId);
        markCustomerReadOnMeta(cs, session);
        cs.stats.agentMessages++; cs.stats.lastAgentMessageAt = Date.now();
        return jsonResponse(200, { status: 'ok', event: 'agent_message', kind: 'file' });
    }

    // ── Routed events ──────────────────────────────────────────────────────────
    const correlationId = cbCorrelationId;

    if (!correlationId) {
        log.warn(`⚠️ FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'ignored', reason: 'no-correlationId', event: segment || 'unknown', path: url.pathname, body_keys: Object.keys(inner || {}).slice(0, 20).join(',') })}`);
        return jsonResponse(200, { status: 'ignored', reason: 'no-correlationId' });
    }

    // create → analytics only
    if (segment === 'create') {
        log.debug(`[five9:${c.name}] conversation created: ${correlationId}`);
        return jsonResponse(200, { status: 'ok', event: 'create' });
    }

    const session = getFive9SessionByCorrelation(c.name, correlationId);
    if (!session) {
        log.warn(`⚠️ FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'ignored', reason: 'unknown-conversation', event: segment, correlation_id: correlationId, hint: 'session expired/closed or created on another instance' })}`);
        return jsonResponse(200, { status: 'ignored', reason: 'unknown-conversation' });
    }

    const base = {
        connector: c.name, channel: c.channel,
        chatId: session.customerId, displayName: session.displayName,
        phoneNumberId: session.phoneNumberId || undefined,
    };

    // accept → agent_joined
    if (segment === 'accept') {
        const agentName = String(inner?.displayName || inner?.agentData?.displayName || 'Agent');
        const event: AgentEvent = {
            ...base, event: 'agent_joined',
            message: {
                uuid: stableUuid(correlationId, 'accept'),
                text: null, timestamp: Date.now(),
                agentName, userType: 'AGENT', file: null,
            },
        };
        fanoutFive9Event(cs, session, event).catch(err =>
            log.warn(`⚠️ [five9:${c.name}] agent_joined fan-out failed:`, err instanceof Error ? err.message : err));
        touchFive9Session(c.name, session.chatId);
        return jsonResponse(200, { status: 'ok', event: 'agent_joined' });
    }

    // message → agent text
    if (segment === 'message' || segment === 'messages') {
        const text = String(inner?.text ?? inner?.message ?? inner?.body?.text ?? '');
        const agentName = String(inner?.agentData?.displayName || inner?.displayName || 'Agent');
        const timestamp = parseFive9Timestamp(inner?.timestamp);
        const eventSerial = String(inner?.eventSerialNumber || timestamp);
        const event: AgentEvent = {
            ...base, event: 'agent_message',
            message: {
                uuid: stableUuid(correlationId, eventSerial),
                text: text || null, timestamp,
                agentName, userType: 'AGENT', file: null,
            },
        };
        // Latency legs: five9_lag_ms = agent typed (Five9 timestamp) → callback reached us.
        //                meta_ms / webhook_ms / total_ms = our fan-out. Whatever is left
        //                between "delivered" and the phone is on Meta's side.
        const receivedAt = Date.now();
        const tm: FanoutTimings = { total_ms: 0 };
        const lag = { five9_lag_ms: receivedAt - timestamp, event_serial: inner?.eventSerialNumber, msg_serial: inner?.messageSerialNumber };
        try { await fanoutFive9Event(cs, session, event, tm); }
        catch (err) {
            cs.stats.lastError = err instanceof Error ? err.message : String(err);
            log.warn(`⚠️ FIVE9_CALLBACK ${fmtFields({
                connector: c.name, result: 'fanout-failed', event: 'agent_message', correlation_id: correlationId,
                chat_id: session.customerId, phone_number_id: session.phoneNumberId || undefined,
                direct_reply: directReplyEnabled(c), meta_token: !!c.meta?.accessToken, error: cs.stats.lastError,
                ...lag, ...tm,
            })}`);
            return jsonResponse(502, { error: 'fan-out failed' });
        }
        touchFive9Session(c.name, session.chatId);
        markCustomerReadOnMeta(cs, session);
        cs.stats.agentMessages++; cs.stats.lastAgentMessageAt = Date.now();
        log.info(`📤 FIVE9_CALLBACK ${fmtFields({
            connector: c.name, result: 'delivered', event: 'agent_message', correlation_id: correlationId, chat_id: session.customerId,
            direct_reply: directReplyEnabled(c), webhook_targets: (c.webhookTargets || []).length,
            ...lag, ...tm,
        })}`);
        return jsonResponse(200, { status: 'ok', event: 'agent_message' });
    }

    // terminate → chat_closed
    if (segment === 'terminate') {
        const event: AgentEvent = { ...base, event: 'chat_closed', reason: 'agent', message: null };
        try { await fanoutFive9Event(cs, null, event); }
        catch (err) {
            log.warn(`⚠️ [five9:${c.name}] chat_closed fan-out failed:`, err instanceof Error ? err.message : err);
        }
        deleteFive9Session(c.name, session.chatId);
        log.info(`👋 [five9:${c.name}] Conversation ${correlationId} terminated for ${session.chatId}`);
        return jsonResponse(200, { status: 'ok', event: 'chat_closed' });
    }

    log.warn(`⚠️ FIVE9_CALLBACK ${fmtFields({ connector: c.name, result: 'ignored', reason: 'unhandled-event', event: segment || 'unknown', path: url.pathname, correlation_id: correlationId, body_keys: Object.keys(inner || {}).slice(0, 20).join(','), hint: 'known events: create, accept, message, terminate, file' })}`);
    return jsonResponse(200, { status: 'ignored', reason: `unhandled segment: ${segment}` });
}

// ─── Main request router ──────────────────────────────────────────────────────

async function handleFive9Request(req: Request, cs: Five9ConnectorServer): Promise<Response> {
    const c = cs.connector;
    const url = new URL(req.url);
    const startTime = performance.now();
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();

    // Health probe
    if (req.method === 'GET' && url.pathname === '/health') {
        return jsonResponse(200, { status: 'ok', connector: c.name, channel: c.channel });
    }

    // Meta hub challenge
    if (req.method === 'GET' && url.searchParams.get('hub.mode') === 'subscribe') {
        const verifyToken = url.searchParams.get('hub.verify_token');
        if (c.verifyToken && !timingSafeEqualStr(verifyToken, c.verifyToken)) {
            log.warn(`❌ [five9:${c.name}] Meta verification failed: invalid hub.verify_token`);
            return new Response('Invalid verify_token', { status: 403 });
        }
        log.info(`✅ [five9:${c.name}] Answered Meta webhook verification challenge`);
        return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
    }

    if (req.method !== 'POST') {
        return jsonResponse(405, { error: 'Method Not Allowed' });
    }

    const clientIp = resolveClientIp(reqPeerIp.get(req), req.headers.get('x-forwarded-for'), getTrustProxyConfig());
    if (!isIpAllowed(clientIp, c.allowedIps)) {
        log.warn(`🚫 [five9:${c.name}] blocked IP ${clientIp}`);
        return jsonResponse(401, { error: 'Unauthorized', message: 'Your IP address is not allowed.' });
    }

    // Five9 sends callbacks to varying paths — route everything that isn't root
    // to the callback handler (path is ignored).
    if (url.pathname !== '/') {
        return handleFive9Callback(req, cs, clientIp);
    }

    // Inbound message (root path = customer → Midleman)
    let payload: any;
    let rawBody = '';
    try {
        rawBody = await req.text();
        payload = JSON.parse(rawBody);
    } catch {
        return jsonResponse(400, { error: 'Bad Request', message: 'Body must be valid JSON' });
    }

    const smoochSecret = c.channel === 'smooch' ? c.smooch?.webhookSecret : undefined;
    if (c.verifyToken || smoochSecret) {
        const tokenOk = !!c.verifyToken &&
            timingSafeEqualStr(req.headers.get('X-Forward-Token') || url.searchParams.get('token'), c.verifyToken);
        const sigOk = !!smoochSecret &&
            verifySmoochSignature(smoochSecret, rawBody, req.headers.get('X-Smooch-Signature'));
        if (!tokenOk && !sigOk) {
            log.warn(`❌ [five9:${c.name}] Unauthorized POST from ${clientIp}`);
            return jsonResponse(401, { error: 'Unauthorized', message: 'Valid token or webhook signature is required' });
        }
    }

    let messages = c.channel === 'meta-whatsapp' ? parseMetaPayload(payload)
        : c.channel === 'smooch' ? parseSmoochPayload(payload)
        : parseGenericPayload(payload);

    if (c.phoneNumberFilter && c.phoneNumberFilter.length > 0) {
        const before = messages.length;
        messages = messages.filter(m => m.phoneNumberId && c.phoneNumberFilter!.includes(m.phoneNumberId));
        if (before > 0 && messages.length === 0) {
            return jsonResponse(200, { status: 'ignored', reason: 'phone_number_id not handled by this connector', requestId });
        }
    }

    if (messages.length === 0) {
        const isMetaStatus = c.channel === 'meta-whatsapp' && (
            Array.isArray(payload?.statuses) ||
            (Array.isArray(payload?.entry) && payload.entry.some((e: any) => e?.changes?.some((ch: any) => Array.isArray(ch?.value?.statuses)))));
        if (!isMetaStatus) {
            log.warn(`⚠️ [five9:${c.name}] Payload produced 0 messages (channel=${c.channel}). Preview: ${rawBody.slice(0, 300)}`);
        }
    }

    const correlationIds: string[] = [];
    const deliveryErrors: string[] = [];
    for (const msg of messages) {
        try {
            const session = await deliverFive9Inbound(cs, msg);
            correlationIds.push(session.correlationId);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            cs.stats.lastError = errMsg;
            deliveryErrors.push(errMsg);
            const existing = getFive9Session(c.name, sessionKeyFor(msg));
            logFive9Error(c, msg, err, {
                request_id: requestId,
                client_ip: clientIp,
                channel: c.channel,
                correlation_id: existing?.correlationId,
                session_state: existing ? 'existing' : 'none',
            });
            logRequest({
                requestId, type: 'connector', targetName: c.name,
                method: 'POST', path: url.pathname, targetUrl: c.five9.authBaseUrl, clientIp,
                reqHeaders: headersToRecord(req.headers),
                reqBody: rawBody.length <= 64 * 1024 ? rawBody : `[large body: ${rawBody.length} bytes]`,
                reqBodySize: rawBody.length,
                resStatus: 502, resStatusText: 'Bad Gateway',
                durationMs: performance.now() - startTime,
                error: errMsg,
            });
        }
    }

    const resJson: Record<string, unknown> = {
        status: deliveryErrors.length > 0 ? 'partial' : 'accepted',
        messages: correlationIds.length,
        requestId,
    };
    if (correlationIds.length === 1) {
        resJson.conversationId = correlationIds[0];
    } else if (correlationIds.length > 1) {
        resJson.conversationIds = correlationIds;
    }
    if (deliveryErrors.length > 0) resJson.errors = deliveryErrors;
    if (messages.length === 0) {
        resJson.hint = c.channel === 'meta-whatsapp'
            ? 'No messages extracted — send the Meta webhook envelope or a bare value object'
            : c.channel === 'smooch'
            ? 'No user messages extracted — expects Sunshine Conversations conversation:message with author.type "user"'
            : 'No messages extracted — expected {"chatId":"…","name":"…","text":"…"} or {"messages":[…]}';
    }
    const resPayload = JSON.stringify(resJson);
    logRequest({
        requestId, type: 'connector', targetName: c.name,
        method: req.method, path: url.pathname + url.search, targetUrl: 'self', clientIp,
        reqHeaders: headersToRecord(req.headers),
        reqBody: rawBody.length <= 64 * 1024 ? rawBody : `[large body: ${rawBody.length} bytes]`,
        reqBodySize: rawBody.length,
        resStatus: 200, resStatusText: 'OK',
        resHeaders: { 'Content-Type': 'application/json' },
        resBody: resPayload, resBodySize: resPayload.length,
        durationMs: performance.now() - startTime,
    });
    return new Response(resPayload, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

export function startFive9ConnectorServer(connector: Five9Connector): Five9ConnectorServer {
    // Same SSRF policy for DLQ replays as for live delivery (see GoContact).
    registerDlqSsrfPolicy(`connector:${connector.name}`, ssrfPolicy(connector));
    const cs: Five9ConnectorServer = {
        connector,
        client: new Five9ApiClient(connector.five9.authBaseUrl),
        server: null,
        ttlTimer: null,
        activeRequests: 0,
        isShuttingDown: false,
        stats: { inboundMessages: 0, agentMessages: 0, deliveryFailures: 0, lastInboundAt: null, lastAgentMessageAt: null, lastError: null },
    };

    if (connector.enabled !== false) {
        // Never let Bun fall back to process.env.PORT (the admin port).
        if (!Number.isInteger(connector.port) || connector.port <= 0) {
            throw new Error(`[five9:${connector.name}] invalid listen port ${String(connector.port)}`);
        }
        cs.server = Bun.serve({
            port: connector.port,
            idleTimeout: 0,
            maxRequestBodySize: 25 * 1024 * 1024,
            async fetch(req: Request, srv): Promise<Response> {
                const peer = srv?.requestIP?.(req)?.address ?? null;
                if (peer) reqPeerIp.set(req, peer);
                if (cs.isShuttingDown) return jsonResponse(503, { error: 'Service Unavailable' });
                cs.activeRequests++;
                try {
                    return await handleFive9Request(req, cs);
                } catch (error) {
                    log.error(`❌ [five9:${connector.name}] Error:`, error);
                    return jsonResponse(500, { error: 'Internal Server Error' });
                } finally {
                    cs.activeRequests--;
                }
            },
            error(error) {
                log.error(`[five9:${connector.name}] Server error:`, error);
                return jsonResponse(500, { error: 'Internal Server Error' });
            },
        });

        // Purge expired sessions every 5 minutes
        const ttl = connector.sessionTtlMinutes ?? 120;
        cs.ttlTimer = setInterval(() => {
            const expired = purgeFive9ExpiredSessions(connector.name, ttl);
            for (const s of expired) {
                log.info(`⌛ [five9:${connector.name}] Session ${s.chatId} expired after ${ttl}min idle`);
                const event: AgentEvent = {
                    connector: connector.name, channel: connector.channel, event: 'chat_closed', reason: 'expired',
                    chatId: s.customerId, displayName: s.displayName,
                    phoneNumberId: s.phoneNumberId || undefined, message: null,
                };
                fanoutFive9Event(cs, null, event).catch(err =>
                    log.warn(`⚠️ [five9:${connector.name}] expired chat_closed fan-out failed:`, err instanceof Error ? err.message : err));
            }
        }, 5 * 60_000);

        log.info(`🤝 Connector "${connector.name}" (${connector.channel}) on :${cs.server.port} — Five9 (push via callback)`);
    } else {
        log.info(`🤝 Connector "${connector.name}" loaded (disabled)`);
    }

    servers.set(connector.name, cs);
    return cs;
}

export async function stopFive9ConnectorServer(name: string, graceful = true): Promise<void> {
    const cs = servers.get(name);
    if (!cs) return;
    cs.isShuttingDown = true;
    if (cs.ttlTimer) { clearInterval(cs.ttlTimer); cs.ttlTimer = null; }
    if (graceful && cs.server) {
        const maxWait = 5000;
        const start = Date.now();
        while (cs.activeRequests > 0 && Date.now() - start < maxWait) {
            await Bun.sleep(200);
        }
    }
    cs.server?.stop(true);
    servers.delete(name);
}

export async function stopAllFive9Connectors(): Promise<void> {
    await Promise.all([...servers.keys()].map(name => stopFive9ConnectorServer(name, false)));
}

export async function restartFive9Connector(connector: Five9Connector): Promise<Five9ConnectorServer> {
    await stopFive9ConnectorServer(connector.name, false);
    return startFive9ConnectorServer(connector);
}

export function getFive9ConnectorStatus(name: string): object | null {
    const cs = servers.get(name);
    if (!cs) return null;
    return {
        name: cs.connector.name,
        channel: cs.connector.channel,
        enabled: cs.connector.enabled !== false,
        running: !!cs.server && !cs.isShuttingDown,
        port: cs.server?.port ?? null,
        directReply: directReplyEnabled(cs.connector),
        stats: { ...cs.stats },
    };
}

/**
 * Close a session from the admin UI: fan out chat_closed (webhooks + direct
 * reply consumers) and drop it locally so the next customer message opens a
 * fresh Five9 conversation. The Five9-side conversation is NOT terminated
 * (no anonymous API for it) — it closes when the agent ends it or it times out.
 */
export async function closeFive9Session(connectorName: string, chatId: string, reason: string): Promise<{ closed: boolean; correlationId?: string }> {
    const cs = servers.get(connectorName);
    const session = getFive9Session(connectorName, chatId);
    if (!session) return { closed: false };
    if (cs) {
        const event: AgentEvent = {
            connector: cs.connector.name, channel: cs.connector.channel, event: 'chat_closed', reason: 'agent',
            chatId: session.customerId, displayName: session.displayName,
            phoneNumberId: session.phoneNumberId || undefined, message: null,
        };
        await fanoutFive9Event(cs, null, event).catch(err =>
            log.warn(`⚠️ FIVE9_WARN ${fmtFields({ connector: connectorName, chat_id: chatId, step: 'admin-close', action: 'chat_closed-fanout-failed', error: err instanceof Error ? err.message : String(err) })}`));
    }
    deleteFive9Session(connectorName, chatId);
    log.info(`👋 FIVE9_STEP ${fmtFields({ connector: connectorName, chat_id: chatId, correlation_id: session.correlationId, step: 'admin-close', reason })}`);
    return { closed: true, correlationId: session.correlationId };
}

export function listFive9ConnectorNames(): string[] {
    return [...servers.keys()];
}
