/**
 * GoContact connector server.
 *
 * Per connector:
 *   • An inbound HTTP listener (dedicated port) accepting customer messages in
 *     Meta WhatsApp Cloud API format (hub.challenge handshake included) or a
 *     simple generic JSON shape — these are injected into a GoContact webchat
 *     session (created on first contact, then reused).
 *   • A polling scheduler reading agent replies (new-client-messages) for every
 *     active session, fanning them out to Meta (direct customer reply) and/or
 *     generic webhooks (your bot). A message is only marked as read in
 *     GoContact after all deliveries succeed — mark-as-read IS the dedup, so
 *     failed deliveries are retried on the next poll (at-least-once semantics;
 *     consumers can dedup by message uuid).
 *   • Agent LEAVE closes the session and emits a `chat_closed` event.
 */

import type { GoContactConnector, NormalizedInboundMessage, ConnectorWebhookTarget } from '../core/connector-types';
import { GoContactClient, stripHtml, type GoAgentMessage, type GoFile } from '../gocontact/client';
import {
    getSession, upsertSession, touchSession, deleteSession,
    updateSessionLastInbound, markSessionAutoReplied, listActiveSessions, purgeExpiredSessions, type ConnectorSession,
} from '../gocontact/sessions';
import { logRequest, headersToRecord } from '../telemetry/request-log';
import { enqueueFailedFanout } from './webhook-server';
import { isIpAllowed, resolveClientIp, getTrustProxyConfig } from '../core/ip-filter';
import { assertResolvedHostAllowed, type SsrfPolicyOverride } from '../core/ssrf-guard';
import { timingSafeEqualStr } from '../auth/auth';
import { createHmac } from 'crypto';

// ─── Types & State ───────────────────────────────────────────────────────────

export interface ConnectorServer {
    connector: GoContactConnector;
    client: GoContactClient;
    server: ReturnType<typeof Bun.serve> | null;
    pollTimer: ReturnType<typeof setInterval> | null;
    polling: boolean;             // reentrancy guard for the poll tick
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

const servers = new Map<string, ConnectorServer>();

// Recently delivered agent-message uuids per connector. Protects against
// double fan-out when delivery succeeded but mark-as-read failed (the message
// would come back on the next poll). Bounded FIFO per connector.
const deliveredUuids = new Map<string, Set<string>>();
const DELIVERED_CAP = 1000;

function rememberDelivered(connector: string, uuid: string): void {
    let set = deliveredUuids.get(connector);
    if (!set) { set = new Set(); deliveredUuids.set(connector, set); }
    set.add(uuid);
    if (set.size > DELIVERED_CAP) {
        const first = set.values().next().value;
        if (first !== undefined) set.delete(first);
    }
}

function wasDelivered(connector: string, uuid: string): boolean {
    return deliveredUuids.get(connector)?.has(uuid) ?? false;
}

// Per-message delivery backoff. The poll loop IS the retry mechanism for agent
// messages (mark-as-read only happens after success), but without backoff a
// persistently failing destination gets hammered every poll tick. Exponential:
// 8s, 16s, 32s … capped at 5 min between attempts.
const deliveryBackoff = new Map<string, { attempts: number; nextAttemptAt: number }>();
const BACKOFF_BASE_MS = 8_000;
const BACKOFF_MAX_MS = 300_000;

function backoffKey(connector: string, uuid: string): string {
    return `${connector}:${uuid}`;
}

function deliveryDue(connector: string, uuid: string): boolean {
    const entry = deliveryBackoff.get(backoffKey(connector, uuid));
    return !entry || entry.nextAttemptAt <= Date.now();
}

function recordDeliveryFailure(connector: string, uuid: string): { attempts: number; delayMs: number } {
    const key = backoffKey(connector, uuid);
    const entry = deliveryBackoff.get(key) || { attempts: 0, nextAttemptAt: 0 };
    entry.attempts += 1;
    const delayMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, entry.attempts - 1));
    entry.nextAttemptAt = Date.now() + delayMs;
    deliveryBackoff.set(key, entry);
    if (deliveryBackoff.size > 1000) {
        const first = deliveryBackoff.keys().next().value;
        if (first !== undefined) deliveryBackoff.delete(first);
    }
    return { attempts: entry.attempts, delayMs };
}

function clearDeliveryFailure(connector: string, uuid: string): void {
    deliveryBackoff.delete(backoffKey(connector, uuid));
}

// FILESEND episodes that arrived without a download URL — first-seen time per
// message, so we can wait out GoContact's upload processing before dropping.
const pendingFileFirstSeen = new Map<string, number>();
const PENDING_FILE_GRACE_MS = 90_000;

// ─── Adaptive per-session polling ────────────────────────────────────────────
// Hot conversations poll at the configured (fast) interval; every empty poll
// stretches that session's interval ×1.5 up to 8× (capped at 60s). Any
// activity — inbound customer message or an agent reply — snaps it back to
// fast. Active chats feel real-time, idle ones barely cost requests.

interface SessionPollState { intervalMs: number; nextPollAt: number }
const sessionPollState = new Map<string, SessionPollState>();

function fastIntervalMs(c: GoContactConnector): number {
    return Math.max(1000, c.pollIntervalMs ?? 4000);
}

function maxIntervalMs(c: GoContactConnector): number {
    return Math.min(60_000, fastIntervalMs(c) * 8);
}

/** Snap a session back to the fast polling rate (called on any activity). */
function markSessionHot(c: GoContactConnector, chatId: string): void {
    sessionPollState.set(`${c.name}:${chatId}`, { intervalMs: fastIntervalMs(c), nextPollAt: 0 });
}

function dropSessionPollState(connector: string, chatId: string): void {
    sessionPollState.delete(`${connector}:${chatId}`);
}

function ssrfPolicy(c: GoContactConnector): SsrfPolicyOverride {
    return { allowPrivate: c.allowPrivateTargets, allowedCidrs: c.targetAllowedCidrs };
}

/** Direct-reply flag, honouring the legacy `replyToMeta` alias. */
function directReplyEnabled(c: GoContactConnector): boolean {
    return c.directReply === true || c.replyToMeta === true;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const reqPeerIp = new WeakMap<Request, string>();

// ─── Meta WhatsApp Cloud API adapter ─────────────────────────────────────────

const DEFAULT_GRAPH_VERSION = 'v21.0';

/** Map common WhatsApp media mimetypes to a file extension. */
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

function graphBase(c: GoContactConnector): string {
    return `https://graph.facebook.com/${c.meta?.graphVersion || DEFAULT_GRAPH_VERSION}`;
}

/** Extract messages from a Meta webhook payload. Accepts both the full
 *  envelope (entry[].changes[].value) and a bare `value` object — the shape
 *  many middlewares/BSPs forward (messaging_product/metadata/contacts/messages
 *  at the top level). */
function parseMetaPayload(payload: any): NormalizedInboundMessage[] {
    const out: NormalizedInboundMessage[] = [];
    const values: any[] = [];
    if (Array.isArray(payload?.entry)) {
        for (const entry of payload.entry) {
            const changes = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const change of changes) {
                if (change?.value) values.push(change.value);
            }
        }
    } else if (Array.isArray(payload?.messages)) {
        values.push(payload); // bare `value` object
    }
    {
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
                            // Some gateways include a signed download URL in the webhook —
                            // prefer it (no Graph API token needed); fall back to the media id.
                            url: media.url ? String(media.url) : undefined,
                            metaMediaId: String(media.id || ''),
                            mimetype,
                            // Meta omits filenames for media — generate one WITH the right
                            // extension (GoContact needs it to serve the file).
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
                        continue; // statuses/reactions/unsupported — ignore
                }
                if (norm.text || norm.file) out.push(norm);
            }
        }
    }
    return out;
}

/** Generic JSON adapter: {chatId, name?, text?, file?{url,filename,mimetype,size}} or {messages:[…]}. */
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

// ─── Smooch / Sunshine Conversations adapter ─────────────────────────────────

function smoochBase(c: GoContactConnector): string {
    const b = (c.smooch?.baseUrl || 'https://api.smooch.io').replace(/\/$/, '');
    return b;
}

function smoochAuthHeader(c: GoContactConnector): string {
    const s = c.smooch!;
    if (s.bearerToken) return `Bearer ${s.bearerToken}`;
    return 'Basic ' + Buffer.from(`${s.keyId}:${s.keySecret}`).toString('base64');
}

/**
 * Parse a Sunshine Conversations webhook. CRITICAL: the conversation:message
 * trigger fires for EVERY author — including the `business` messages this
 * connector itself sends. We accept only `author.type === "user"`, otherwise
 * each agent reply we push to Smooch would loop straight back in.
 */
function parseSmoochPayload(payload: any): NormalizedInboundMessage[] {
    const out: NormalizedInboundMessage[] = [];
    const events = Array.isArray(payload?.events) ? payload.events
        : Array.isArray(payload?.messages) ? payload.messages.map((m: any) => ({ type: 'conversation:message', payload: m }))
        : [];
    for (const ev of events) {
        if (ev?.type && ev.type !== 'conversation:message') continue;
        const p = ev?.payload ?? ev;
        const conversationId = String(p?.conversation?.id ?? p?.conversation?._id ?? '');
        const message = p?.message ?? p;
        const author = message?.author ?? {};
        // Anti-echo: only the end customer's messages enter GoContact.
        if (String(author.type || '').toLowerCase() !== 'user') continue;
        if (!conversationId) continue;

        const displayName = String(author.displayName || author.userId || conversationId);
        const norm: NormalizedInboundMessage = {
            chatId: conversationId,
            displayName,
            messageId: message?.id ? String(message.id) : undefined,
        };
        const content = message?.content ?? {};
        const type = String(content.type || '').toLowerCase();
        if (type === 'text') {
            norm.text = String(content.text ?? '');
        } else if (type === 'image' || type === 'file') {
            const mediaUrl = content.mediaUrl ? String(content.mediaUrl) : undefined;
            if (mediaUrl) {
                norm.file = {
                    url: mediaUrl,
                    mimetype: content.mediaType ? String(content.mediaType) : undefined,
                    filename: content.altText ? String(content.altText) : undefined,
                    size: typeof content.mediaSize === 'number' ? content.mediaSize : undefined,
                };
            }
            if (content.text) norm.text = String(content.text);
        } else {
            continue; // carousel/form/location/etc. — not handled
        }
        if (norm.text || norm.file) out.push(norm);
    }
    return out;
}

/** Send an agent reply to the customer through Sunshine Conversations. */
async function sendToSmooch(c: GoContactConnector, conversationId: string, text: string | null, file: { url: string; mimetype: string; filename?: string } | null): Promise<void> {
    const s = c.smooch;
    if (!s?.appId || (!s.bearerToken && !(s.keyId && s.keySecret))) throw new Error('Smooch credentials not configured');
    let content: Record<string, unknown>;
    if (file) {
        content = {
            type: file.mimetype.startsWith('image/') ? 'image' : 'file',
            mediaUrl: file.url,
            ...(file.filename ? { altText: file.filename } : {}),
            ...(text ? { text } : {}),
        };
    } else {
        content = { type: 'text', text: text ?? '' };
    }
    const url = `${smoochBase(c)}/v2/apps/${encodeURIComponent(s.appId)}/conversations/${encodeURIComponent(conversationId)}/messages`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': smoochAuthHeader(c), 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: { type: 'business' }, content }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Smooch send failed: HTTP ${res.status} ${errText.slice(0, 300)}`);
    }
}

/** Verify the X-Smooch-Signature header (HMAC-SHA256 of the raw body, base64). */
function verifySmoochSignature(secret: string, rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
    return timingSafeEqualStr(expected, signature.trim());
}

/** Resolve a Meta media id to a downloadable URL + bytes (Graph API, two hops). */
async function downloadMetaMedia(c: GoContactConnector, mediaId: string): Promise<{ bytes: Uint8Array; mimetype: string; filename?: string }> {
    if (!c.meta?.accessToken) throw new Error('Meta accessToken not configured — cannot download media');
    const auth = { 'Authorization': `Bearer ${c.meta.accessToken}` };

    const metaRes = await fetch(`${graphBase(c)}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
    if (!metaRes.ok) throw new Error(`Meta media lookup failed: HTTP ${metaRes.status}`);
    const meta = await metaRes.json() as any;
    if (!meta?.url) throw new Error('Meta media lookup returned no URL');

    const binRes = await fetch(meta.url, { headers: auth, signal: AbortSignal.timeout(120_000) });
    if (!binRes.ok) throw new Error(`Meta media download failed: HTTP ${binRes.status}`);
    const bytes = new Uint8Array(await binRes.arrayBuffer());
    return { bytes, mimetype: String(meta.mime_type || 'application/octet-stream') };
}

/** Meta-owned media hosts — the WhatsApp access token is attached ONLY for
 *  these (lookaside URLs still validate the bearer token on download). */
function isMetaMediaHost(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'lookaside.fbsbx.com'
            || host === 'graph.facebook.com'
            || host.endsWith('.fbcdn.net')
            || host.endsWith('.whatsapp.net');
    } catch { return false; }
}

/** Download a direct file URL. SSRF-checked against the connector policy.
 *  Attaches the Meta access token when (and only when) the host is Meta's. */
async function downloadDirectUrl(c: GoContactConnector, url: string): Promise<{ bytes: Uint8Array; mimetype: string }> {
    await assertResolvedHostAllowed(url, ssrfPolicy(c));
    const headers: Record<string, string> = {};
    if (c.meta?.accessToken && isMetaMediaHost(url)) {
        headers['Authorization'] = `Bearer ${c.meta.accessToken}`;
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`File download failed: HTTP ${res.status}${isMetaMediaHost(url) && !c.meta?.accessToken ? ' (Meta host — a valid meta.accessToken is required to download media)' : ''}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, mimetype: res.headers.get('content-type') || 'application/octet-stream' };
}

/** Send an agent reply back to the customer via the Meta Graph API.
 *  Replies go out via the number the customer wrote to (session-captured
 *  phone_number_id); the configured meta.phoneNumberId is the fallback. */
async function sendToMeta(c: GoContactConnector, chatId: string, text: string | null, file: { url: string; mimetype: string; filename?: string } | null, sessionPhoneNumberId?: string): Promise<void> {
    const phoneNumberId = sessionPhoneNumberId || c.meta?.phoneNumberId;
    if (!c.meta?.accessToken || !phoneNumberId) throw new Error('Meta credentials not configured (accessToken + phone_number_id)');
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
    const res = await fetch(`${graphBase(c)}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.meta.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Meta send failed: HTTP ${res.status} ${errText.slice(0, 300)}`);
    }
}

/** Mark the customer's message as read on WhatsApp (blue ticks). Best-effort. */
async function sendMetaReadReceipt(c: GoContactConnector, phoneNumberId: string, messageId: string): Promise<void> {
    if (!c.meta?.accessToken || !phoneNumberId) return;
    const res = await fetch(`${graphBase(c)}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.meta.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Meta read receipt failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
    }
}

// ─── Session management ──────────────────────────────────────────────────────

/** Session key: one GoContact chat per (business number, customer) pair, so a
 *  customer talking to several numbers of the same WABA gets separate chats
 *  with correctly routed replies. */
function sessionKeyFor(msg: NormalizedInboundMessage): string {
    return msg.phoneNumberId ? `${msg.phoneNumberId}:${msg.chatId}` : msg.chatId;
}

/** Get a live session or bootstrap a new one (token → … → dialog group + JOIN). */
async function ensureSession(cs: ConnectorServer, msg: NormalizedInboundMessage): Promise<ConnectorSession> {
    const c = cs.connector;
    const ttl = c.sessionTtlMinutes ?? 120;
    const key = sessionKeyFor(msg);
    const existing = getSession(c.name, key);

    // The bearer token is shared per user by the token manager, so a live
    // session needs no token upkeep — just reuse it.
    if (existing && Date.now() - existing.lastActivityAt < ttl * 60_000) {
        return existing;
    }

    if (existing) deleteSession(c.name, key);

    const handles = await cs.client.openSession(msg.displayName, msg.chatId);
    const session: ConnectorSession = {
        connector: c.name,
        chatId: key,
        customerId: msg.chatId,
        displayName: msg.displayName,
        domainUuid: handles.domainUuid,
        accessKey: handles.accessKey,
        dialogGroupUuid: handles.dialogGroupUuid,
        dialogGroupId: handles.dialogGroupId,
        phoneNumberId: msg.phoneNumberId || '',
        lastInboundMsgId: '',
        autoReplied: false,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
    };
    upsertSession(session);

    // Announce the customer in the chat (mirrors the original JOIN episode).
    try {
        await cs.client.sendClientMessage(session.accessKey, session.dialogGroupUuid, session.displayName, 'JOIN', '');
    } catch (err) {
        console.warn(`⚠️ [connector:${c.name}] JOIN failed for ${msg.chatId}:`, err instanceof Error ? err.message : err);
    }
    console.log(`💬 [connector:${c.name}] New webchat session for ${key} (${session.dialogGroupUuid})`);
    return session;
}

/** Inject one normalized inbound message into GoContact (text and/or file). */
async function deliverInbound(cs: ConnectorServer, msg: NormalizedInboundMessage): Promise<void> {
    const c = cs.connector;
    const session = await ensureSession(cs, msg);

    if (msg.file) {
        // Prefer a direct (signed) URL when the gateway provides one — no Meta
        // token needed. Fall back to the Graph API media-id exchange.
        let downloaded: { bytes: Uint8Array; mimetype: string } | null = null;
        if (msg.file.url) {
            try {
                downloaded = await downloadDirectUrl(c, msg.file.url);
            } catch (err) {
                if (!msg.file.metaMediaId) throw err;
                console.warn(`⚠️ [connector:${c.name}] Direct media URL failed (${err instanceof Error ? err.message : err}) — falling back to Graph API media id`);
            }
        }
        if (!downloaded) {
            if (!msg.file.metaMediaId) throw new Error('Media message has neither a usable URL nor a media id');
            downloaded = await downloadMetaMedia(c, msg.file.metaMediaId);
        }
        const { bytes, mimetype } = downloaded;
        const effectiveMime = msg.file.mimetype || mimetype;
        const filename = msg.file.filename || `file-${Date.now()}${extensionForMime(effectiveMime)}`;
        // 1. Create the FILESEND episode with metadata only. The url is left
        //    empty on purpose: a Meta lookaside link needs Meta auth and is
        //    useless to the agent console — the binary is attached next.
        const goFile: GoFile = {
            filename,
            size: String(bytes.byteLength),
            mimetype: effectiveMime,
            url: '',
            filestatus: '',
        };
        const { episodeUuid } = await cs.client.sendClientMessage(
            session.accessKey, session.dialogGroupUuid, session.displayName, 'FILESEND', '', goFile);
        if (!episodeUuid) throw new Error('FILESEND episode created but no episode uuid returned — cannot attach file');
        // 2. Attach the binary to that episode.
        await cs.client.uploadFile(
            { dialogGroupUuid: session.dialogGroupUuid, episodeUuid, domainUuid: session.domainUuid },
            bytes, filename, effectiveMime,
        );
    }
    if (msg.text) {
        await cs.client.sendClientMessage(session.accessKey, session.dialogGroupUuid, session.displayName, 'MSG', msg.text);
    }
    // Remember the customer's message id so the agent's reply can trigger a
    // read receipt on the channel (WhatsApp blue ticks).
    if (msg.messageId) updateSessionLastInbound(c.name, session.chatId, msg.messageId);
    touchSession(c.name, session.chatId);
    // Customer just wrote — an agent/queue reply is most likely now.
    markSessionHot(c, session.chatId);
    cs.stats.inboundMessages++;
    cs.stats.lastInboundAt = Date.now();

    // Auto-reply: once per session, on the first customer message. An expiry
    // date (when set) silently disables it — a forgotten holiday/campaign
    // notice stops by itself.
    const autoReplyExpired = !!c.autoReply?.expiresAt && Date.now() > Date.parse(c.autoReply.expiresAt);
    if (c.autoReply?.enabled && !autoReplyExpired && c.autoReply.text?.trim() && !session.autoReplied) {
        session.autoReplied = true;
        markSessionAutoReplied(c.name, session.chatId);
        void sendAutoReply(cs, session, c.autoReply.text.trim());
    }
}

/** Deliver the connector's auto-reply: to the customer through the regular
 *  agent-reply plumbing (Meta and/or webhooks) AND into the GoContact chat so
 *  the agent sees what was already answered. Best-effort, fires once. */
async function sendAutoReply(cs: ConnectorServer, session: ConnectorSession, text: string): Promise<void> {
    const c = cs.connector;
    const event: AgentEvent = {
        connector: c.name,
        channel: c.channel,
        event: 'agent_message',
        chatId: session.customerId,
        displayName: session.displayName,
        phoneNumberId: session.phoneNumberId || undefined,
        message: {
            uuid: `autoreply-${session.dialogGroupUuid}`,
            text,
            timestamp: Date.now(),
            agentName: 'Auto-Reply',
            userType: 'AUTO',
            file: null,
        },
    };
    try {
        await fanoutAgentEvent(cs, session, event);
        console.log(`🤖 [connector:${c.name}] Auto-reply sent to ${session.customerId}`);
    } catch (err) {
        console.warn(`⚠️ [connector:${c.name}] Auto-reply delivery failed:`, err instanceof Error ? err.message : err);
    }
    // Mirror it into the GoContact chat (visible to the agent on pickup).
    try {
        await cs.client.sendClientMessage(
            session.accessKey, session.dialogGroupUuid,
            '🤖 Auto-Reply', 'MSG', text);
    } catch (err) {
        console.warn(`⚠️ [connector:${c.name}] Auto-reply mirror to GoContact failed:`, err instanceof Error ? err.message : err);
    }
}

// ─── Outbound fan-out (agent → customer / bot) ──────────────────────────────

interface AgentEvent {
    connector: string;
    channel: string;
    event: 'agent_message' | 'agent_joined' | 'chat_closed';
    /** Why the chat closed (chat_closed only): the agent ended it, an admin
     *  closed it from the dashboard, or it expired by inactivity (TTL). */
    reason?: 'agent' | 'admin' | 'expired';
    chatId: string;
    displayName: string;
    /** Business number the conversation belongs to (Meta phone_number_id). */
    phoneNumberId?: string;
    message: {
        uuid: string;
        text: string | null;
        timestamp: number;
        agentName: string;
        /** GoContact episode usertype (e.g. "AGENT" for humans; automatic
         *  system messages carry a different value) — lets consumers tell
         *  human replies apart from queue/system notices. */
        userType?: string;
        file: { url: string; filename: string; mimetype: string; size: number | string } | null;
    } | null;
}

async function postWebhookTarget(c: GoContactConnector, target: ConnectorWebhookTarget, event: AgentEvent, maxAttempts = 3): Promise<void> {
    await assertResolvedHostAllowed(target.url, ssrfPolicy(c));
    const body = JSON.stringify(event);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) await Bun.sleep(1000 * Math.pow(2, attempt - 2));
        const started = performance.now();
        try {
            const headers = new Headers({ 'Content-Type': 'application/json', 'X-Connector': c.name });
            for (const [k, v] of Object.entries(target.customHeaders || {})) headers.set(k, v);
            const res = await fetch(target.url, {
                method: target.method || 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(30_000),
                tls: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
            } as RequestInit);
            const resText = await res.text().catch(() => null);
            logRequest({
                requestId: event.message?.uuid || crypto.randomUUID(),
                type: 'connector-fanout',
                targetName: c.name,
                method: target.method || 'POST',
                path: `/${event.event}`,
                targetUrl: target.url,
                reqHeaders: headersToRecord(headers),
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

/** Deliver one agent message to every configured destination. Throws if any fails.
 *  chat_closed is fire-once (the session is already gone), so webhook-target
 *  failures for it are parked in the shared DLQ for manual replay instead of
 *  being lost — agent_message failures retry naturally on the next poll. */
async function fanoutAgentEvent(cs: ConnectorServer, session: ConnectorSession | null, event: AgentEvent): Promise<void> {
    const c = cs.connector;
    const jobs: Promise<void>[] = [];

    // Direct reply to the customer through this connector's channel provider.
    if (directReplyEnabled(c) && event.event === 'agent_message' && event.message) {
        if (c.channel === 'meta-whatsapp') {
            jobs.push(sendToMeta(c, event.chatId, event.message.text, event.message.file, session?.phoneNumberId));
        } else if (c.channel === 'smooch') {
            jobs.push(sendToSmooch(c, event.chatId, event.message.text, event.message.file));
        }
    }
    for (const target of (c.webhooksEnabled !== false ? c.webhookTargets || [] : [])) {
        // agent_message: single shot per tick — the poll loop + per-message
        // backoff is the retry mechanism. chat_closed: 3 attempts, then DLQ.
        let job = postWebhookTarget(c, target, event, event.event === 'chat_closed' ? 3 : 1);
        if (event.event === 'chat_closed') {
            job = job.catch(err => {
                const body = JSON.stringify(event);
                const errMsg = err instanceof Error ? err.message : String(err);
                enqueueFailedFanout({
                    webhookName: `connector:${c.name}`,
                    requestId: crypto.randomUUID(),
                    targetUrl: target.url,
                    method: target.method || 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Connector': c.name, ...(target.customHeaders || {}) },
                    body,
                    bodyPreview: body,
                    bodySize: body.length,
                    path: `/chat_closed`,
                    clientIp: 'internal',
                    retryConfig: undefined,
                    lastError: errMsg,
                    totalAttempts: 3,
                });
                console.warn(`📥 [connector:${c.name}] chat_closed → ${target.url} failed (${errMsg}) — parked in DLQ for replay`);
            });
        }
        jobs.push(job);
    }

    const results = await Promise.allSettled(jobs);
    const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
        cs.stats.deliveryFailures += failures.length;
        const msg = failures.map(f => f.reason instanceof Error ? f.reason.message : String(f.reason)).join('; ');
        throw new Error(`${failures.length}/${jobs.length} deliveries failed: ${msg}`);
    }
}

// ─── Poller ──────────────────────────────────────────────────────────────────

async function pollSession(cs: ConnectorServer, session: ConnectorSession): Promise<number> {
    const c = cs.connector;

    const messages = await cs.client.fetchNewMessages(session.accessKey);
    if (messages.length === 0) return 0;

    for (const m of messages) {
        // Respect the per-message backoff window before re-attempting delivery.
        if (m.uuid && (m.msgtype === 'MSG' || m.msgtype === 'FILESEND') && !deliveryDue(c.name, m.uuid)) continue;
        try {
            await processAgentMessage(cs, session, m);
            if (m.uuid) clearDeliveryFailure(c.name, m.uuid);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            cs.stats.lastError = errMsg;
            if (m.uuid) {
                const { attempts, delayMs } = recordDeliveryFailure(c.name, m.uuid);
                console.error(`❌ [connector:${c.name}] Agent message ${m.uuid} for ${session.chatId} not delivered (attempt ${attempts}, next retry in ${Math.round(delayMs / 1000)}s):`, errMsg);
                // First failure: dump the raw episode so unexpected shapes
                // (automatic messages, odd file objects) are diagnosable.
                if (attempts === 1) {
                    console.error(`   raw episode: ${JSON.stringify(m).slice(0, 500)}`);
                }
            } else {
                console.error(`❌ [connector:${c.name}] Agent message for ${session.chatId} not delivered:`, errMsg);
            }
        }
    }
    return messages.length;
}

async function processAgentMessage(cs: ConnectorServer, session: ConnectorSession, m: GoAgentMessage): Promise<void> {
    const c = cs.connector;

    // Agent closed the chat.
    if (m.msgtype === 'LEAVE') {
        try { await cs.client.markAsRead(session.accessKey, m.uuid); } catch { /* session dies anyway */ }
        deleteSession(c.name, session.chatId);
        dropSessionPollState(c.name, session.chatId);
        console.log(`👋 [connector:${c.name}] Agent closed chat ${session.chatId}`);
        const event: AgentEvent = {
            connector: c.name, channel: c.channel, event: 'chat_closed', reason: 'agent',
            chatId: session.customerId, displayName: session.displayName,
            phoneNumberId: session.phoneNumberId || undefined, message: null,
        };
        // Best-effort: the session is gone either way.
        try { await fanoutAgentEvent(cs, null, event); } catch (err) {
            console.warn(`⚠️ [connector:${c.name}] chat_closed fan-out failed:`, err instanceof Error ? err.message : err);
        }
        return;
    }

    // Agent joined the conversation — notify the webhooks (fire-and-forget).
    if (m.msgtype === 'JOIN') {
        try { if (m.uuid) await cs.client.markAsRead(session.accessKey, m.uuid); } catch { /* non-critical */ }
        console.log(`🙋 [connector:${c.name}] Agent "${m.displayname}" joined chat ${session.chatId}`);
        const event: AgentEvent = {
            connector: c.name, channel: c.channel, event: 'agent_joined',
            chatId: session.customerId, displayName: session.displayName,
            phoneNumberId: session.phoneNumberId || undefined,
            message: { uuid: m.uuid, text: null, timestamp: m.timestamp || Date.now(), agentName: m.displayname, userType: m.usertype || undefined, file: null },
        };
        fanoutAgentEvent(cs, session, event).catch(err =>
            console.warn(`⚠️ [connector:${c.name}] agent_joined fan-out failed:`, err instanceof Error ? err.message : err));
        return;
    }

    // FILESEND without a file URL: either the upload is still processing on
    // GoContact's side (our poll can outrun it) or it genuinely failed (e.g.
    // file over the size limit). Grace period: leave it UNACKED so the next
    // polls can pick up the URL once ready; only drop after 90s without one.
    if (m.msgtype === 'FILESEND' && (!m.file || !m.file.url)) {
        if (m.uuid) {
            const key = backoffKey(c.name, m.uuid);
            const firstSeen = pendingFileFirstSeen.get(key) ?? Date.now();
            pendingFileFirstSeen.set(key, firstSeen);
            if (Date.now() - firstSeen < PENDING_FILE_GRACE_MS) {
                return; // wait — do NOT mark as read yet
            }
            pendingFileFirstSeen.delete(key);
            console.log(`🚮 [connector:${c.name}] Dropping FILESEND ${m.uuid} on chat ${session.chatId} — no url after ${PENDING_FILE_GRACE_MS / 1000}s (upload failed/rejected)`);
            await cs.client.markAsRead(session.accessKey, m.uuid);
            clearDeliveryFailure(c.name, m.uuid);
        }
        return;
    }
    if (m.uuid) pendingFileFirstSeen.delete(backoffKey(c.name, m.uuid));

    if (m.msgtype !== 'MSG' && m.msgtype !== 'FILESEND') {
        // Unknown episode type — surface it so we learn what GoContact emits
        // (typing? read receipts?). Mark as read so it doesn't repeat forever.
        console.log(`❓ [connector:${c.name}] Unhandled agent msgtype "${m.msgtype}" (usertype=${m.usertype}) on chat ${session.chatId} — ignored`);
        try { if (m.uuid) await cs.client.markAsRead(session.accessKey, m.uuid); } catch { /* non-critical */ }
        return;
    }
    if (!m.uuid || wasDelivered(c.name, m.uuid)) {
        // Already fanned out but mark-as-read failed last time — just retry the mark.
        if (m.uuid) await cs.client.markAsRead(session.accessKey, m.uuid);
        return;
    }

    const event: AgentEvent = {
        connector: c.name,
        channel: c.channel,
        event: 'agent_message',
        chatId: session.customerId,
        displayName: session.displayName,
        phoneNumberId: session.phoneNumberId || undefined,
        message: {
            uuid: m.uuid,
            text: m.msgtype === 'MSG' ? stripHtml(m.msg) : (m.msg ? stripHtml(m.msg) : null),
            timestamp: m.timestamp || Date.now(),
            agentName: m.displayname,
            userType: m.usertype || undefined,
            file: m.msgtype === 'FILESEND' && m.file && m.file.url ? {
                url: cs.client.agentFileUrl(m.file.url),
                filename: m.file.filename || 'file',
                mimetype: m.file.mimetype || 'application/octet-stream',
                size: m.file.size ?? 0,
            } : null,
        },
    };

    await fanoutAgentEvent(cs, session, event);
    rememberDelivered(c.name, m.uuid);
    cs.stats.agentMessages++;
    cs.stats.lastAgentMessageAt = Date.now();
    touchSession(c.name, session.chatId);

    // Agent replied → mark the customer's last message as read on WhatsApp
    // (blue ticks). Meta-specific, only when Midleman owns the Meta side.
    if (c.channel === 'meta-whatsapp' && directReplyEnabled(c) && session.lastInboundMsgId && session.phoneNumberId) {
        sendMetaReadReceipt(c, session.phoneNumberId, session.lastInboundMsgId)
            .then(() => { session.lastInboundMsgId = ''; updateSessionLastInbound(c.name, session.chatId, ''); })
            .catch(err => console.warn(`⚠️ [connector:${c.name}] read receipt failed:`, err instanceof Error ? err.message : err));
    }

    // Only after successful delivery — mark-as-read is the dedup/ack.
    await cs.client.markAsRead(session.accessKey, m.uuid);
}

async function pollTick(cs: ConnectorServer): Promise<void> {
    if (cs.polling || cs.isShuttingDown) return;
    cs.polling = true;
    try {
        const c = cs.connector;
        const ttl = c.sessionTtlMinutes ?? 120;
        const expired = purgeExpiredSessions(c.name, ttl);
        for (const s of expired) {
            console.log(`⌛ [connector:${c.name}] Session ${s.chatId} expired after ${ttl}min idle`);
            dropSessionPollState(c.name, s.chatId);
            const event: AgentEvent = {
                connector: c.name, channel: c.channel, event: 'chat_closed', reason: 'expired',
                chatId: s.customerId, displayName: s.displayName,
                phoneNumberId: s.phoneNumberId || undefined, message: null,
            };
            fanoutAgentEvent(cs, null, event).catch(err =>
                console.warn(`⚠️ [connector:${c.name}] chat_closed(expired) fan-out failed:`, err instanceof Error ? err.message : err));
        }
        // Adaptive scheduling: only poll the sessions that are due.
        const now = Date.now();
        const due = listActiveSessions(c.name, ttl).filter(s => {
            const state = sessionPollState.get(`${c.name}:${s.chatId}`);
            return !state || state.nextPollAt <= now;
        });
        if (due.length === 0) return;
        // Bounded parallelism: poll in batches so a large session count degrades
        // into longer effective latency instead of a thundering herd against
        // GoContact. The reentrancy guard above keeps overlapping ticks out.
        const BATCH = 25;
        for (let i = 0; i < due.length; i += BATCH) {
            if (cs.isShuttingDown) return;
            const batch = due.slice(i, i + BATCH);
            const results = await Promise.allSettled(batch.map(s => pollSession(cs, s)));
            // Reschedule each polled session: activity → fast; empty → back off.
            results.forEach((r, idx) => {
                const s = batch[idx];
                const key = `${c.name}:${s.chatId}`;
                const prev = sessionPollState.get(key)?.intervalMs ?? fastIntervalMs(c);
                const gotMessages = r.status === 'fulfilled' && r.value > 0;
                const intervalMs = gotMessages
                    ? fastIntervalMs(c)
                    : Math.min(maxIntervalMs(c), Math.round(prev * 1.5));
                sessionPollState.set(key, { intervalMs, nextPollAt: Date.now() + intervalMs });
            });
        }
    } catch (err) {
        cs.stats.lastError = err instanceof Error ? err.message : String(err);
        console.error(`❌ [connector:${cs.connector.name}] poll tick error:`, cs.stats.lastError);
    } finally {
        cs.polling = false;
    }
}

// ─── Inbound HTTP handling ───────────────────────────────────────────────────

async function handleInbound(req: Request, cs: ConnectorServer): Promise<Response> {
    const c = cs.connector;
    const url = new URL(req.url);
    const startTime = performance.now();
    const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();

    // Health/status probe
    if (req.method === 'GET' && url.pathname === '/health') {
        return jsonResponse(200, { status: 'ok', connector: c.name, channel: c.channel });
    }

    // Meta webhook verification handshake
    if (req.method === 'GET' && url.searchParams.get('hub.mode') === 'subscribe') {
        const verifyToken = url.searchParams.get('hub.verify_token');
        if (c.verifyToken && !timingSafeEqualStr(verifyToken, c.verifyToken)) {
            console.warn(`❌ [connector:${c.name}] Meta verification failed: invalid hub.verify_token`);
            return new Response('Invalid verify_token', { status: 403 });
        }
        console.log(`✅ [connector:${c.name}] Answered Meta webhook verification challenge`);
        return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
    }

    if (req.method !== 'POST') {
        return jsonResponse(405, { error: 'Method Not Allowed' });
    }

    const clientIp = resolveClientIp(reqPeerIp.get(req), req.headers.get('x-forwarded-for'), getTrustProxyConfig());
    if (!isIpAllowed(clientIp, c.allowedIps)) {
        console.warn(`🚫 [connector:${c.name}] blocked IP ${clientIp}`);
        return jsonResponse(401, { error: 'Unauthorized', message: 'Your IP address is not allowed.' });
    }

    let payload: any;
    let rawBody = '';
    try {
        rawBody = await req.text();
        payload = JSON.parse(rawBody);
    } catch {
        return jsonResponse(400, { error: 'Bad Request', message: 'Body must be valid JSON' });
    }

    // Inbound auth. Two independent mechanisms, either sufficient:
    //  • verifyToken — X-Forward-Token header or ?token= query (all channels).
    //    For a direct Meta webhook, bake ?token= into the callback URL.
    //  • Smooch X-Smooch-Signature — HMAC-SHA256 of the raw body with the
    //    webhook shared secret (smooch channel only).
    const smoochSecret = c.channel === 'smooch' ? c.smooch?.webhookSecret : undefined;
    if (c.verifyToken || smoochSecret) {
        const tokenOk = !!c.verifyToken &&
            timingSafeEqualStr(req.headers.get('X-Forward-Token') || url.searchParams.get('token'), c.verifyToken);
        const sigOk = !!smoochSecret &&
            verifySmoochSignature(smoochSecret, rawBody, req.headers.get('X-Smooch-Signature'));
        if (!tokenOk && !sigOk) {
            console.warn(`❌ [connector:${c.name}] Unauthorized POST from ${clientIp}: missing/invalid token or signature`);
            return jsonResponse(401, { error: 'Unauthorized', message: 'Valid token or webhook signature is required' });
        }
    }

    let messages = c.channel === 'meta-whatsapp' ? parseMetaPayload(payload)
        : c.channel === 'smooch' ? parseSmoochPayload(payload)
        : parseGenericPayload(payload);

    // Brand routing: when a filter is set, this connector only handles its own
    // business number(s) — other connectors sharing the same feed pick theirs.
    if (c.phoneNumberFilter && c.phoneNumberFilter.length > 0) {
        const before = messages.length;
        messages = messages.filter(m => m.phoneNumberId && c.phoneNumberFilter!.includes(m.phoneNumberId));
        if (before > 0 && messages.length === 0) {
            return jsonResponse(200, { status: 'ignored', reason: 'phone_number_id not handled by this connector', requestId });
        }
    }

    if (messages.length === 0) {
        // Meta sends statuses/read-receipts on the same webhook — only warn when
        // the payload doesn't look like one of those.
        const isMetaStatusPayload = c.channel === 'meta-whatsapp' && (
            Array.isArray(payload?.statuses) ||
            (Array.isArray(payload?.entry) &&
                payload.entry.some((e: any) => e?.changes?.some((ch: any) => Array.isArray(ch?.value?.statuses)))));
        if (!isMetaStatusPayload) {
            console.warn(`⚠️ [connector:${c.name}] Payload produced 0 messages (channel=${c.channel}). Body preview: ${rawBody.slice(0, 300)}`);
        }
    }

    // Always 200 fast (Meta retries aggressively on non-200) — inject async.
    if (messages.length > 0) {
        void (async () => {
            for (const msg of messages) {
                try {
                    await deliverInbound(cs, msg);
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    cs.stats.lastError = errMsg;
                    console.error(`❌ [connector:${c.name}] Failed to inject message from ${msg.chatId} into GoContact:`, errMsg);
                    logRequest({
                        requestId, type: 'connector', targetName: c.name,
                        method: 'POST', path: url.pathname, targetUrl: c.gocontact.baseUrl, clientIp,
                        reqHeaders: headersToRecord(req.headers),
                        reqBody: rawBody.length <= 64 * 1024 ? rawBody : `[large body: ${rawBody.length} bytes]`,
                        reqBodySize: rawBody.length,
                        resStatus: 502, resStatusText: 'Bad Gateway',
                        durationMs: performance.now() - startTime,
                        error: errMsg,
                    });
                }
            }
        })();
    }

    const resJson: Record<string, unknown> = { status: 'accepted', messages: messages.length, requestId };
    if (messages.length === 0) {
        resJson.hint = c.channel === 'meta-whatsapp'
            ? 'No messages extracted — send the Meta webhook envelope ({"entry":[{"changes":[{"value":{…}}]}]}) or a bare value object ({"messaging_product":"whatsapp","contacts":[…],"messages":[…]})'
            : c.channel === 'smooch'
            ? 'No user messages extracted — expects a Sunshine Conversations conversation:message event with author.type "user" (business/echo messages are ignored by design)'
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

// ─── Server lifecycle ────────────────────────────────────────────────────────

export function startConnectorServer(connector: GoContactConnector): ConnectorServer {
    const cs: ConnectorServer = {
        connector,
        client: new GoContactClient(connector.gocontact),
        server: null,
        pollTimer: null,
        polling: false,
        activeRequests: 0,
        isShuttingDown: false,
        stats: { inboundMessages: 0, agentMessages: 0, deliveryFailures: 0, lastInboundAt: null, lastAgentMessageAt: null, lastError: null },
    };

    if (connector.enabled !== false) {
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
                    return await handleInbound(req, cs);
                } catch (error) {
                    console.error(`❌ [connector:${connector.name}] Error:`, error);
                    return jsonResponse(500, { error: 'Internal Server Error' });
                } finally {
                    cs.activeRequests--;
                }
            },
            error(error) {
                console.error(`[connector:${connector.name}] Server error:`, error);
                return jsonResponse(500, { error: 'Internal Server Error' });
            },
        });

        // The scheduler ticks every second; each session is only actually
        // polled when due per its adaptive interval (fast..8×fast, max 60s).
        cs.pollTimer = setInterval(() => { void pollTick(cs); }, 1000);
        console.log(`💬 Connector "${connector.name}" (${connector.channel}) on :${cs.server.port} — adaptive polling ${fastIntervalMs(connector)}–${maxIntervalMs(connector)}ms`);
    } else {
        console.log(`💬 Connector "${connector.name}" loaded (disabled)`);
    }

    servers.set(connector.name, cs);
    return cs;
}

export async function stopConnectorServer(name: string, graceful = true): Promise<void> {
    const cs = servers.get(name);
    if (!cs) return;
    cs.isShuttingDown = true;
    if (cs.pollTimer) { clearInterval(cs.pollTimer); cs.pollTimer = null; }
    if (graceful && cs.server) {
        const maxWait = 5000;
        const start = Date.now();
        while ((cs.activeRequests > 0 || cs.polling) && Date.now() - start < maxWait) {
            await Bun.sleep(200);
        }
    }
    // Force-close active connections: with idleTimeout 0, a gateway's
    // kept-alive sockets would otherwise stay pinned to this (now dead)
    // instance and keep getting 503s after a restart.
    cs.server?.stop(true);
    servers.delete(name);
    console.log(`🛑 Connector "${name}" stopped`);
}

export async function stopAllConnectors(): Promise<void> {
    await Promise.all(Array.from(servers.keys()).map(n => stopConnectorServer(n)));
}

export async function restartConnector(connector: GoContactConnector): Promise<ConnectorServer> {
    await stopConnectorServer(connector.name, false);
    return startConnectorServer(connector);
}

export function getConnectorServers(): Map<string, ConnectorServer> {
    return servers;
}

export function getConnectorStatus(): Array<{
    name: string; channel: string; port: number | null; running: boolean; enabled: boolean;
    pollIntervalMs: number; directReply: boolean; webhookTargets: number;
    stats: ConnectorServer['stats'];
}> {
    return Array.from(servers.values()).map(cs => ({
        name: cs.connector.name,
        channel: cs.connector.channel,
        port: cs.server?.port ?? cs.connector.port ?? null,
        running: !!cs.server && !cs.isShuttingDown,
        enabled: cs.connector.enabled !== false,
        pollIntervalMs: Math.max(1000, cs.connector.pollIntervalMs ?? 4000),
        directReply: directReplyEnabled(cs.connector),
        webhookTargets: cs.connector.webhookTargets?.length ?? 0,
        stats: cs.stats,
    }));
}

/** Manually close a session from the dashboard (sends LEAVE, removes locally). */
export async function closeConnectorSession(connectorName: string, chatId: string): Promise<{ ok: boolean; error?: string }> {
    const cs = servers.get(connectorName);
    if (!cs) return { ok: false, error: 'Connector not running' };
    const session = getSession(connectorName, chatId);
    if (!session) return { ok: false, error: 'Session not found' };
    try {
        await cs.client.sendClientMessage(session.accessKey, session.dialogGroupUuid, session.displayName, 'LEAVE', '');
    } catch (err) {
        console.warn(`⚠️ [connector:${connectorName}] LEAVE for ${chatId} failed:`, err instanceof Error ? err.message : err);
    }
    deleteSession(connectorName, chatId);
    dropSessionPollState(connectorName, chatId);
    const event: AgentEvent = {
        connector: connectorName, channel: cs.connector.channel, event: 'chat_closed', reason: 'admin',
        chatId: session.customerId, displayName: session.displayName,
        phoneNumberId: session.phoneNumberId || undefined, message: null,
    };
    fanoutAgentEvent(cs, null, event).catch(err =>
        console.warn(`⚠️ [connector:${connectorName}] chat_closed(admin) fan-out failed:`, err instanceof Error ? err.message : err));
    return { ok: true };
}
