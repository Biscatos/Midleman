// SMS configuration storage + encryption + multi-provider client (WeSender, Twilio).
//
// Persists a single SMS profile to data/sms.json. Sensitive credentials
// (WeSender ApiKey, Twilio Auth Token) are encrypted at rest using AES-256-GCM
// with a key derived from the JWT RSA private key (same pattern as
// src/auth/ldap.ts and src/core/smtp.ts), domain-separated by a fixed label.
//
// Routing modes:
//   single    — always use `primary`
//   failover  — try `primary`, on failure try `secondary`
//   by-prefix — match destination E.164 prefix against `prefixRules` in order;
//               last rule with prefix "*" or "" acts as a catch-all.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export type SmsProvider = 'wesender' | 'twilio';
export type SmsRoutingMode = 'single' | 'failover' | 'by-prefix';

export interface SmsPrefixRule {
    /** E.164 prefix to match (e.g. "+244"). "*" or "" matches anything. */
    prefix: string;
    provider: SmsProvider;
}

export interface WesenderConfig {
    /** Encrypted ApiKey (v1:iv:tag:ct). Empty when not set. */
    apiKeyEnc: string;
    /** If true, WeSender will allow special characters (may reduce char limit). */
    defaultCEspeciais?: boolean;
}

export interface TwilioConfig {
    accountSid: string;
    /** Encrypted Auth Token. Empty when not set. */
    authTokenEnc: string;
    /** Sender number in E.164, e.g. "+15551234567". */
    fromNumber: string;
}

export interface SmsConfig {
    enabled: boolean;
    routing: SmsRoutingMode;
    primary: SmsProvider;
    secondary?: SmsProvider;
    prefixRules?: SmsPrefixRule[];
    /** Default country code to apply when normalizing local numbers (e.g. "244"). */
    defaultCountryCode?: string;
    wesender?: WesenderConfig;
    twilio?: TwilioConfig;
}

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const SMS_FILE = resolve(DATA_DIR, 'sms.json');

let encKey: Buffer | null = null;
let cachedConfig: SmsConfig | null = null;

function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function deriveEncKey(dataDir: string): Buffer {
    const keyPath = resolve(dataDir, 'jwt-key.pem');
    if (!existsSync(keyPath)) {
        throw new Error('SMS: jwt-key.pem not found — initJwt() must run before initSms()');
    }
    const pem = readFileSync(keyPath, 'utf-8');
    return createHash('sha256').update('midleman:sms:credentials:v1\n').update(pem).digest();
}

function encryptSecret(plaintext: string): string {
    if (!plaintext) return '';
    if (!encKey) throw new Error('SMS not initialized');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptSecret(encoded: string): string {
    if (!encoded) return '';
    if (!encKey) throw new Error('SMS not initialized');
    const parts = encoded.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('SMS: malformed encrypted secret');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

export function initSms(dataDir: string): void {
    encKey = deriveEncKey(dataDir);
    try {
        if (existsSync(SMS_FILE)) {
            const raw = readFileSync(SMS_FILE, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<SmsConfig>;
            if (parsed && parsed.routing && parsed.primary) {
                cachedConfig = parsed as SmsConfig;
            } else {
                cachedConfig = null;
            }
        }
    } catch (err) {
        console.warn('⚠️  Could not load sms.json:', err instanceof Error ? err.message : err);
        cachedConfig = null;
    }
}

export function getSmsConfig(): SmsConfig | null {
    return cachedConfig;
}

export function isSmsConfigured(): boolean {
    if (!cachedConfig || !cachedConfig.enabled) return false;
    const haveWe = !!cachedConfig.wesender?.apiKeyEnc;
    const haveTw = !!cachedConfig.twilio?.authTokenEnc && !!cachedConfig.twilio?.accountSid && !!cachedConfig.twilio?.fromNumber;
    return haveWe || haveTw;
}

/** Public-safe view of the config (no encrypted credentials). */
export function publicSmsConfig(cfg: SmsConfig | null): Record<string, unknown> | null {
    if (!cfg) return null;
    return {
        enabled: !!cfg.enabled,
        routing: cfg.routing,
        primary: cfg.primary,
        secondary: cfg.secondary,
        prefixRules: cfg.prefixRules || [],
        defaultCountryCode: cfg.defaultCountryCode || '',
        wesender: cfg.wesender ? {
            hasApiKey: !!cfg.wesender.apiKeyEnc,
            defaultCEspeciais: !!cfg.wesender.defaultCEspeciais,
        } : null,
        twilio: cfg.twilio ? {
            accountSid: cfg.twilio.accountSid,
            hasAuthToken: !!cfg.twilio.authTokenEnc,
            fromNumber: cfg.twilio.fromNumber,
        } : null,
    };
}

export interface SmsConfigInput {
    enabled: boolean;
    routing: SmsRoutingMode;
    primary: SmsProvider;
    secondary?: SmsProvider;
    prefixRules?: SmsPrefixRule[];
    defaultCountryCode?: string;
    wesender?: {
        /** Plaintext. Empty string clears, undefined keeps existing. */
        apiKey?: string;
        defaultCEspeciais?: boolean;
    };
    twilio?: {
        accountSid?: string;
        /** Plaintext. Empty string clears, undefined keeps existing. */
        authToken?: string;
        fromNumber?: string;
    };
}

export function validateSmsInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';
    const i = input as Record<string, unknown>;
    if (typeof i.enabled !== 'boolean') return '"enabled" must be boolean';
    if (i.routing !== 'single' && i.routing !== 'failover' && i.routing !== 'by-prefix') {
        return '"routing" must be "single", "failover" or "by-prefix"';
    }
    if (i.primary !== 'wesender' && i.primary !== 'twilio') return '"primary" must be "wesender" or "twilio"';
    if (i.routing === 'failover') {
        if (i.secondary !== 'wesender' && i.secondary !== 'twilio') return '"secondary" required for failover routing';
        if (i.secondary === i.primary) return '"secondary" must differ from "primary"';
    }
    if (i.routing === 'by-prefix') {
        if (!Array.isArray(i.prefixRules) || i.prefixRules.length === 0) {
            return '"prefixRules" must be a non-empty array for by-prefix routing';
        }
        for (const r of i.prefixRules as any[]) {
            if (!r || typeof r.prefix !== 'string') return 'each prefix rule needs a "prefix" string';
            if (r.provider !== 'wesender' && r.provider !== 'twilio') return 'each prefix rule "provider" must be "wesender" or "twilio"';
        }
    }
    if (i.defaultCountryCode !== undefined && typeof i.defaultCountryCode !== 'string') return '"defaultCountryCode" must be a string';
    if (i.wesender !== undefined && (typeof i.wesender !== 'object' || i.wesender === null)) return '"wesender" must be an object';
    if (i.twilio !== undefined && (typeof i.twilio !== 'object' || i.twilio === null)) return '"twilio" must be an object';
    const tw = i.twilio as any;
    if (tw) {
        if (tw.accountSid !== undefined && typeof tw.accountSid !== 'string') return '"twilio.accountSid" must be a string';
        if (tw.authToken !== undefined && typeof tw.authToken !== 'string') return '"twilio.authToken" must be a string';
        if (tw.fromNumber !== undefined && typeof tw.fromNumber !== 'string') return '"twilio.fromNumber" must be a string';
    }
    return null;
}

export function saveSmsConfig(input: SmsConfigInput): SmsConfig {
    const existing = cachedConfig;
    const we = input.wesender || {};
    const tw = input.twilio || {};
    const cfg: SmsConfig = {
        enabled: input.enabled,
        routing: input.routing,
        primary: input.primary,
        secondary: input.secondary,
        prefixRules: input.prefixRules?.map(r => ({ prefix: r.prefix.trim(), provider: r.provider })),
        defaultCountryCode: (input.defaultCountryCode ?? existing?.defaultCountryCode ?? '').replace(/^\+/, '').trim(),
        wesender: {
            apiKeyEnc: we.apiKey !== undefined
                ? (we.apiKey ? encryptSecret(we.apiKey) : '')
                : (existing?.wesender?.apiKeyEnc || ''),
            defaultCEspeciais: we.defaultCEspeciais ?? existing?.wesender?.defaultCEspeciais ?? false,
        },
        twilio: {
            accountSid: (tw.accountSid ?? existing?.twilio?.accountSid ?? '').trim(),
            authTokenEnc: tw.authToken !== undefined
                ? (tw.authToken ? encryptSecret(tw.authToken) : '')
                : (existing?.twilio?.authTokenEnc || ''),
            fromNumber: (tw.fromNumber ?? existing?.twilio?.fromNumber ?? '').trim(),
        },
    };
    ensureDataDir();
    writeFileSync(SMS_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    cachedConfig = cfg;
    return cfg;
}

export function deleteSmsConfig(): void {
    cachedConfig = null;
    try {
        if (existsSync(SMS_FILE)) writeFileSync(SMS_FILE, JSON.stringify({}, null, 2), 'utf-8');
    } catch {}
}

// ─── Phone normalization ─────────────────────────────────────────────────────

/** Normalize a phone number to E.164 (+CCXXXXXXXX). Returns null if invalid. */
export function normalizePhone(raw: string, defaultCountryCode?: string): string | null {
    if (!raw) return null;
    let s = raw.replace(/[\s\-().]/g, '');
    if (!s) return null;
    if (s.startsWith('00')) s = '+' + s.slice(2);
    if (s.startsWith('+')) {
        const digits = s.slice(1);
        if (!/^\d{6,15}$/.test(digits)) return null;
        return '+' + digits;
    }
    if (!/^\d+$/.test(s)) return null;
    const cc = (defaultCountryCode || cachedConfig?.defaultCountryCode || '').replace(/^\+/, '');
    if (!cc) return null;
    return '+' + cc + s;
}

// ─── Routing ─────────────────────────────────────────────────────────────────

function pickProviderByPrefix(e164: string, rules: SmsPrefixRule[]): SmsProvider | null {
    for (const r of rules) {
        const p = r.prefix.trim();
        if (!p || p === '*' || e164.startsWith(p)) return r.provider;
    }
    return null;
}

// ─── Message templates ───────────────────────────────────────────────────────

export function truncateSms(msg: string, maxLen = 160): string {
    if (msg.length <= maxLen) return msg;
    return msg.slice(0, maxLen - 1) + '…';
}

export function render2faCodeSms(code: string): string {
    return truncateSms(`Midleman: o seu codigo de verificacao e ${code}. Valido por 5 min.`);
}
export function renderPhoneVerifySms(code: string): string {
    return truncateSms(`Midleman: codigo para confirmar este numero: ${code}. Valido por 10 min.`);
}
export function renderPasswordResetSms(link: string): string {
    return truncateSms(`Midleman: reset de password — ${link} (15 min).`);
}
export function renderWebhookAlertSms(name: string): string {
    return truncateSms(`Midleman ALERTA: webhook '${name}' falhou apos retries.`);
}
export function renderAdminAlertSms(subject: string): string {
    return truncateSms(`Midleman: ${subject}`);
}
export function renderTestSms(): string {
    return 'Midleman: SMS de teste — config OK.';
}

// ─── Provider clients ────────────────────────────────────────────────────────

export interface SmsSendResult {
    ok: boolean;
    providerUsed?: SmsProvider;
    messageId?: string;
    error?: string;
    /** Per-attempt diagnostics in routing order. Populated for failover. */
    attempts?: Array<{ provider: SmsProvider; ok: boolean; error?: string; messageId?: string }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const onExternalAbort = () => ctrl.abort(externalSignal?.reason);
    if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
}

async function sendViaWeSender(
    to: string[],
    message: string,
    cfg: WesenderConfig,
    opts: { signal?: AbortSignal; timeoutMs?: number; cEspeciais?: boolean } = {}
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
    if (!cfg.apiKeyEnc) return { ok: false, error: 'WeSender ApiKey not configured' };
    let apiKey: string;
    try { apiKey = decryptSecret(cfg.apiKeyEnc); }
    catch (e) { return { ok: false, error: 'WeSender ApiKey decrypt failed: ' + (e instanceof Error ? e.message : String(e)) }; }
    // WeSender expects local format (no leading '+').
    const Destino = to.map(n => n.startsWith('+') ? n.slice(1) : n);
    const cEspeciais = opts.cEspeciais ?? cfg.defaultCEspeciais ?? false;
    const body = {
        ApiKey: apiKey,
        Destino,
        Mensagem: message,
        CEspeciais: cEspeciais ? 'true' : 'false',
    };
    try {
        const resp = await fetchWithTimeout(
            'https://api.wesender.co.ao/envio/apikey',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
            opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            opts.signal,
        );
        const text = await resp.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch {}
        if (!resp.ok) return { ok: false, error: `WeSender HTTP ${resp.status}: ${text.slice(0, 200)}` };
        if (!parsed || parsed.Exito !== true) {
            return { ok: false, error: `WeSender rejected: ${parsed?.Mensagem || text.slice(0, 200)}` };
        }
        // Partial-delivery check: parse "Foram enviados X de Y mensagens".
        const m = typeof parsed.Mensagem === 'string'
            ? parsed.Mensagem.match(/(\d+)\s+de\s+(\d+)/i)
            : null;
        if (m) {
            const sent = parseInt(m[1], 10);
            const total = parseInt(m[2], 10);
            if (sent < total) {
                return { ok: false, error: `WeSender delivered ${sent}/${total}: ${parsed.Mensagem}` };
            }
        }
        return { ok: true, messageId: undefined };
    } catch (e: any) {
        return { ok: false, error: 'WeSender request failed: ' + (e?.message || String(e)) };
    }
}

async function sendViaTwilio(
    to: string,
    message: string,
    cfg: TwilioConfig,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
    if (!cfg.accountSid || !cfg.authTokenEnc || !cfg.fromNumber) {
        return { ok: false, error: 'Twilio not fully configured' };
    }
    let token: string;
    try { token = decryptSecret(cfg.authTokenEnc); }
    catch (e) { return { ok: false, error: 'Twilio token decrypt failed: ' + (e instanceof Error ? e.message : String(e)) }; }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
    const form = new URLSearchParams({ To: to, From: cfg.fromNumber, Body: message });
    const auth = Buffer.from(`${cfg.accountSid}:${token}`).toString('base64');
    try {
        const resp = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: {
                    Authorization: 'Basic ' + auth,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: form.toString(),
            },
            opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            opts.signal,
        );
        const text = await resp.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch {}
        if (!resp.ok) {
            const msg = parsed?.message || text.slice(0, 200);
            return { ok: false, error: `Twilio HTTP ${resp.status}: ${msg}` };
        }
        const sid = parsed?.sid;
        return { ok: true, messageId: typeof sid === 'string' ? sid : undefined };
    } catch (e: any) {
        return { ok: false, error: 'Twilio request failed: ' + (e?.message || String(e)) };
    }
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

export interface SendSmsOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Override provider (used by send-test). */
    forceProvider?: SmsProvider;
}

async function sendOnce(provider: SmsProvider, to: string, message: string, opts: SendSmsOptions, cfg: SmsConfig) {
    if (provider === 'wesender') {
        if (!cfg.wesender) return { ok: false, error: 'WeSender not configured' };
        return sendViaWeSender([to], message, cfg.wesender, { signal: opts.signal, timeoutMs: opts.timeoutMs });
    }
    if (!cfg.twilio) return { ok: false, error: 'Twilio not configured' };
    return sendViaTwilio(to, message, cfg.twilio, { signal: opts.signal, timeoutMs: opts.timeoutMs });
}

export async function sendSms(toRaw: string, message: string, opts: SendSmsOptions = {}): Promise<SmsSendResult> {
    const cfg = cachedConfig;
    if (!cfg) return { ok: false, error: 'SMS not configured' };
    if (!cfg.enabled) return { ok: false, error: 'SMS disabled' };
    const to = normalizePhone(toRaw);
    if (!to) return { ok: false, error: `Invalid phone number: ${toRaw}` };

    let chain: SmsProvider[];
    if (opts.forceProvider) {
        chain = [opts.forceProvider];
    } else if (cfg.routing === 'single') {
        chain = [cfg.primary];
    } else if (cfg.routing === 'failover') {
        chain = cfg.secondary ? [cfg.primary, cfg.secondary] : [cfg.primary];
    } else {
        const picked = pickProviderByPrefix(to, cfg.prefixRules || []);
        if (!picked) return { ok: false, error: `No prefix rule matched ${to}` };
        chain = [picked];
    }

    const attempts: NonNullable<SmsSendResult['attempts']> = [];
    for (const provider of chain) {
        const r = await sendOnce(provider, to, message, opts, cfg);
        attempts.push({ provider, ok: r.ok, error: r.error, messageId: r.messageId });
        if (r.ok) return { ok: true, providerUsed: provider, messageId: r.messageId, attempts };
    }
    const last = attempts[attempts.length - 1];
    return { ok: false, error: last?.error || 'All providers failed', attempts };
}

export async function sendSmsTest(toRaw: string, opts: SendSmsOptions = {}): Promise<SmsSendResult> {
    return sendSms(toRaw, renderTestSms(), opts);
}
