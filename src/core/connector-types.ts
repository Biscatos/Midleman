/**
 * GoContact webchat connector types.
 *
 * A connector bridges a written/digital channel (Meta WhatsApp Cloud API,
 * generic JSON, later Telegram/Instagram) into a GoContact webchat session:
 *
 *   inbound:  channel payload → (create/reuse webchat session) → client-message
 *   poller:   new-client-messages → agent replies → fan-out (Meta and/or webhooks)
 *
 * The protocol mirrors GoContact's "traditional" webchat plugin API
 * (poll/new-webchat-service/*) — there is no official interactive API yet.
 */

import { assertSafeOutboundUrl, SsrfBlockedError } from './ssrf-guard';

/** Inbound channel adapters. Telegram/Instagram reserved for future use. */
export type ConnectorChannel = 'meta-whatsapp' | 'generic' | 'telegram' | 'instagram';

/** GoContact instance credentials + webchat channel addressing. */
export interface GoContactSettings {
  /** Instance base URL, e.g. "https://gotaag.ucall.co.ao/" */
  baseUrl: string;
  /** Login e-mail. The webchat domain name is the part after "@". */
  username: string;
  password: string;
  /** Webchat channel hash key (from the GoContact webchat embed script: `_hashkey`). */
  hashKey: string;
  /** Webchat domain UUID (from the embed script: `_domain`). When set, the
   *  per-session nameconversion lookup is skipped — also avoids relying on the
   *  login e-mail's domain matching the webchat domain. */
  domainUuid?: string;
  /** Language sent on new-dialog-group (default "en"). */
  language?: string;
  /** Hours added to UTC when stamping episode timestamps (default 1, matching
   *  the original integration's UTC+1 behaviour). */
  timestampOffsetHours?: number;
  /** Path under baseUrl where agent file attachments live (default "storage"). */
  storageBucket?: string;
}

/** Meta WhatsApp Cloud API credentials — used to download inbound media and to
 *  send agent replies straight back to the customer. */
export interface MetaSettings {
  accessToken: string;
  phoneNumberId: string;
  /** Graph API version (default "v21.0"). */
  graphVersion?: string;
}

/** A generic webhook destination for agent replies (e.g. your bot). */
export interface ConnectorWebhookTarget {
  url: string;
  method?: string;                       // default POST
  customHeaders?: Record<string, string>;
}

export interface GoContactConnector {
  name: string;            // unique, lowercase
  port: number;            // dedicated inbound listener port (0 = auto-assign)
  enabled?: boolean;       // default true — disabled connectors don't listen/poll

  channel: ConnectorChannel;
  gocontact: GoContactSettings;

  /** Inbound verify token: doubles as Meta hub.verify_token AND as the
   *  X-Forward-Token/?token= guard for non-Meta posts. */
  verifyToken?: string;
  allowedIps?: string[];

  /** Required when channel = meta-whatsapp or when replyToMeta is true. */
  meta?: MetaSettings;
  /** Only process inbound messages whose metadata.phone_number_id is in this
   *  list (empty/unset = accept all). Lets several connectors — one per brand,
   *  each with its own GoContact channel — share the same inbound feed: each
   *  picks only its own business number. */
  phoneNumberFilter?: string[];
  /** When true, agent replies are sent directly to the customer via the
   *  Meta Graph API (text and media). */
  replyToMeta?: boolean;

  /** Agent replies (and chat-closed events) are also POSTed to each of these. */
  webhookTargets?: ConnectorWebhookTarget[];
  /** Master switch for webhook delivery (default true). Lets you pause the
   *  webhook fan-out without deleting the configured targets. */
  webhooksEnabled?: boolean;

  /** Automatic reply sent once per session, on the customer's first message —
   *  delivered to the customer (Meta and/or webhooks, same plumbing as agent
   *  replies) and also posted into the GoContact chat so the agent sees it. */
  autoReply?: {
    enabled: boolean;
    text: string;
  };

  /** Poller cadence in ms (default 4000, min 1000). */
  pollIntervalMs?: number;
  /** Idle session expiry in minutes (default 120, like the original Redis TTL). */
  sessionTtlMinutes?: number;

  /** Outbound SSRF policy (same semantics as webhooks). */
  allowPrivateTargets?: boolean;
  targetAllowedCidrs?: string[];
}

/** Normalized message flowing through the connector core (channel-agnostic). */
export interface NormalizedInboundMessage {
  chatId: string;          // stable per-customer id (e.g. wa_id)
  displayName: string;     // shown to the agent
  /** Business number that received the message (Meta metadata.phone_number_id).
   *  Captured per session so replies go out via the same number — the
   *  configured meta.phoneNumberId is only a fallback. */
  phoneNumberId?: string;
  /** Channel message id (e.g. WhatsApp wamid) — used for read receipts. */
  messageId?: string;
  text?: string;
  file?: {
    /** Either a direct URL (generic channel) or resolved from a Meta media id. */
    url?: string;
    metaMediaId?: string;
    filename?: string;
    mimetype?: string;
    size?: number;
  };
}

/**
 * Validate a connector object from API input. Returns an error string or null.
 */
export function validateConnectorInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'Request body must be a JSON object';
  const c = input as Record<string, unknown>;

  if (!c.name || typeof c.name !== 'string') return '"name" is required (string)';
  if (!/^[a-z0-9_-]+$/.test(c.name)) return '"name" may only contain lowercase letters, numbers, hyphens and underscores';
  if (c.name.length < 2 || c.name.length > 48) return '"name" must be between 2 and 48 characters';

  if (c.port !== undefined && c.port !== null && c.port !== 0) {
    if (typeof c.port !== 'number' || c.port < 1 || c.port > 65535) return '"port" must be 1–65535 (or 0/omitted for auto-assign)';
  }

  const channels: ConnectorChannel[] = ['meta-whatsapp', 'generic', 'telegram', 'instagram'];
  if (!channels.includes(c.channel as ConnectorChannel)) return `"channel" must be one of: ${channels.join(', ')}`;
  if (c.channel === 'telegram' || c.channel === 'instagram') return `Channel "${c.channel}" is not implemented yet`;

  if (!c.gocontact || typeof c.gocontact !== 'object') return '"gocontact" settings are required';
  const g = c.gocontact as Record<string, unknown>;
  if (!g.baseUrl || typeof g.baseUrl !== 'string') return '"gocontact.baseUrl" is required';
  try { new URL(g.baseUrl); } catch { return '"gocontact.baseUrl" must be a valid URL'; }
  if (!g.username || typeof g.username !== 'string' || !g.username.includes('@')) {
    return '"gocontact.username" must be an e-mail (domain name is taken from the part after "@")';
  }
  if (g.password !== undefined && typeof g.password !== 'string') return '"gocontact.password" must be a string';
  if (!g.hashKey || typeof g.hashKey !== 'string') return '"gocontact.hashKey" is required';
  if (g.domainUuid !== undefined && g.domainUuid !== '' && (typeof g.domainUuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g.domainUuid))) {
    return '"gocontact.domainUuid" must be a UUID (the _domain value from the embed script)';
  }
  if (g.timestampOffsetHours !== undefined && (typeof g.timestampOffsetHours !== 'number' || g.timestampOffsetHours < -12 || g.timestampOffsetHours > 14)) {
    return '"gocontact.timestampOffsetHours" must be between -12 and 14';
  }

  const ssrfOverride = {
    allowPrivate: c.allowPrivateTargets as boolean | undefined,
    allowedCidrs: c.targetAllowedCidrs as string[] | undefined,
  };

  // Meta credentials are only REQUIRED to send replies via the Graph API.
  // For inbound meta-whatsapp without them, text flows normally; media messages
  // need the accessToken to be downloadable (degrades gracefully otherwise).
  if (c.meta !== undefined) {
    if (typeof c.meta !== 'object' || c.meta === null) return '"meta" must be an object';
    const m = c.meta as Record<string, unknown>;
    if (m.accessToken !== undefined && typeof m.accessToken !== 'string') return '"meta.accessToken" must be a string';
    if (m.phoneNumberId !== undefined && typeof m.phoneNumberId !== 'string') return '"meta.phoneNumberId" must be a string';
    // phoneNumberId is optional for the meta-whatsapp channel: it is captured
    // per-session from the inbound payload (metadata.phone_number_id). It is
    // only required to reply via Meta on channels that don't carry it.
    if (c.replyToMeta === true && c.channel !== 'meta-whatsapp' && !m.phoneNumberId) {
      return '"meta.phoneNumberId" is required to reply via Meta on this channel';
    }
  } else if (c.replyToMeta === true) {
    return '"replyToMeta" requires "meta" credentials';
  }

  if (c.replyToMeta !== undefined && typeof c.replyToMeta !== 'boolean') return '"replyToMeta" must be a boolean';
  if (c.phoneNumberFilter !== undefined && (!Array.isArray(c.phoneNumberFilter) || (c.phoneNumberFilter as unknown[]).some(x => typeof x !== 'string'))) {
    return '"phoneNumberFilter" must be an array of phone_number_id strings';
  }

  if (c.autoReply !== undefined) {
    if (typeof c.autoReply !== 'object' || c.autoReply === null) return '"autoReply" must be an object';
    const ar = c.autoReply as Record<string, unknown>;
    if (typeof ar.enabled !== 'boolean') return '"autoReply.enabled" must be a boolean';
    if (ar.enabled) {
      if (!ar.text || typeof ar.text !== 'string' || !(ar.text as string).trim()) return '"autoReply.text" is required when auto-reply is enabled';
      if ((ar.text as string).length > 2000) return '"autoReply.text" must be 2000 characters or fewer';
    }
  }

  if (c.webhookTargets !== undefined) {
    if (!Array.isArray(c.webhookTargets)) return '"webhookTargets" must be an array';
    if (c.webhookTargets.length > 16) return '"webhookTargets" cannot exceed 16 entries';
    for (const t of c.webhookTargets as unknown[]) {
      if (!t || typeof t !== 'object') return '"webhookTargets" entries must be objects';
      const wt = t as Record<string, unknown>;
      if (typeof wt.url !== 'string' || !wt.url.trim()) return '"webhookTargets[].url" is required';
      try { assertSafeOutboundUrl(wt.url, ssrfOverride); }
      catch (e) { return e instanceof SsrfBlockedError ? `"${wt.url}": ${e.message}` : `"${wt.url}" is not a valid URL`; }
      if (wt.method !== undefined && typeof wt.method !== 'string') return '"webhookTargets[].method" must be a string';
      if (wt.customHeaders !== undefined && (typeof wt.customHeaders !== 'object' || wt.customHeaders === null)) return '"webhookTargets[].customHeaders" must be an object';
    }
  }

  if (c.webhooksEnabled !== undefined && typeof c.webhooksEnabled !== 'boolean') return '"webhooksEnabled" must be a boolean';

  const webhooksActive = c.webhooksEnabled !== false && Array.isArray(c.webhookTargets) && c.webhookTargets.length > 0;
  if (c.replyToMeta !== true && !webhooksActive) {
    return 'Agent replies need at least one active destination: enable "replyToMeta" or add (and enable) a webhook target';
  }

  if (c.pollIntervalMs !== undefined && (typeof c.pollIntervalMs !== 'number' || c.pollIntervalMs < 1000 || c.pollIntervalMs > 300_000)) {
    return '"pollIntervalMs" must be between 1000 and 300000';
  }
  if (c.sessionTtlMinutes !== undefined && (typeof c.sessionTtlMinutes !== 'number' || c.sessionTtlMinutes < 5 || c.sessionTtlMinutes > 10080)) {
    return '"sessionTtlMinutes" must be between 5 and 10080';
  }
  if (c.allowPrivateTargets !== undefined && typeof c.allowPrivateTargets !== 'boolean') return '"allowPrivateTargets" must be a boolean';
  if (c.targetAllowedCidrs !== undefined && (!Array.isArray(c.targetAllowedCidrs) || (c.targetAllowedCidrs as unknown[]).some(x => typeof x !== 'string'))) {
    return '"targetAllowedCidrs" must be an array of CIDR strings';
  }

  return null;
}
