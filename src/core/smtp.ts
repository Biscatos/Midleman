// SMTP configuration storage + encryption + minimal SMTP client.
//
// Persists a single SMTP profile to data/smtp.json. The password is encrypted
// at rest using AES-256-GCM with a key derived from the JWT RSA private key
// (same pattern as src/auth/ldap.ts), domain-separated by a fixed label.
//
// The mailer speaks SMTP directly over TCP/TLS using Bun.connect — no external
// dependency. Supports implicit TLS (port 465), STARTTLS upgrade (587/25),
// and PLAIN/LOGIN auth.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { connect as netConnect, type Socket } from 'net';
import { connect as tlsConnect, type TLSSocket } from 'tls';

export type SmtpSecurity = 'none' | 'starttls' | 'tls';

export interface SmtpConfig {
    host: string;
    port: number;
    security: SmtpSecurity;
    username: string;
    /** Encrypted (v1:iv:tag:ct). Empty string when not set. */
    passwordEnc: string;
    fromAddress: string;
    fromName: string;
    /** Whether to accept self-signed / invalid TLS certs. Default false. */
    allowInvalidCerts?: boolean;
}

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const SMTP_FILE = resolve(DATA_DIR, 'smtp.json');

let encKey: Buffer | null = null;
let cachedConfig: SmtpConfig | null = null;

function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function deriveEncKey(dataDir: string): Buffer {
    const keyPath = resolve(dataDir, 'jwt-key.pem');
    if (!existsSync(keyPath)) {
        throw new Error('SMTP: jwt-key.pem not found — initJwt() must run before initSmtp()');
    }
    const pem = readFileSync(keyPath, 'utf-8');
    return createHash('sha256').update('midleman:smtp:password:v1\n').update(pem).digest();
}

function encryptPassword(plaintext: string): string {
    if (!plaintext) return '';
    if (!encKey) throw new Error('SMTP not initialized');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptPassword(encoded: string): string {
    if (!encoded) return '';
    if (!encKey) throw new Error('SMTP not initialized');
    const parts = encoded.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('SMTP: malformed password_enc');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

export function initSmtp(dataDir: string): void {
    encKey = deriveEncKey(dataDir);
    try {
        if (existsSync(SMTP_FILE)) {
            const raw = readFileSync(SMTP_FILE, 'utf-8');
            cachedConfig = JSON.parse(raw) as SmtpConfig;
        }
    } catch (err) {
        console.warn('⚠️  Could not load smtp.json:', err instanceof Error ? err.message : err);
        cachedConfig = null;
    }
}

export function getSmtpConfig(): SmtpConfig | null {
    return cachedConfig;
}

export function isSmtpConfigured(): boolean {
    return !!cachedConfig && !!cachedConfig.host && !!cachedConfig.fromAddress;
}

export interface SmtpConfigInput {
    host: string;
    port: number;
    security: SmtpSecurity;
    username?: string;
    /** Plaintext. Pass empty string to clear, undefined to keep existing. */
    password?: string;
    fromAddress: string;
    fromName?: string;
    allowInvalidCerts?: boolean;
}

export function validateSmtpInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';
    const i = input as Record<string, unknown>;
    if (!i.host || typeof i.host !== 'string') return '"host" is required (string)';
    if ((i.host as string).length > 253) return '"host" too long';
    if (typeof i.port !== 'number' || i.port < 1 || i.port > 65535) return '"port" must be 1–65535';
    if (i.security !== 'none' && i.security !== 'starttls' && i.security !== 'tls') return '"security" must be "none", "starttls" or "tls"';
    if (i.username !== undefined && typeof i.username !== 'string') return '"username" must be a string';
    if (i.password !== undefined && typeof i.password !== 'string') return '"password" must be a string';
    if (!i.fromAddress || typeof i.fromAddress !== 'string') return '"fromAddress" is required (string)';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.fromAddress as string)) return '"fromAddress" must be a valid email';
    if (i.fromName !== undefined && typeof i.fromName !== 'string') return '"fromName" must be a string';
    if (i.allowInvalidCerts !== undefined && typeof i.allowInvalidCerts !== 'boolean') return '"allowInvalidCerts" must be a boolean';
    return null;
}

export function saveSmtpConfig(input: SmtpConfigInput): SmtpConfig {
    const existing = cachedConfig;
    let passwordEnc = existing?.passwordEnc || '';
    if (input.password !== undefined) {
        passwordEnc = input.password ? encryptPassword(input.password) : '';
    }
    const cfg: SmtpConfig = {
        host: input.host.trim(),
        port: input.port,
        security: input.security,
        username: (input.username ?? existing?.username ?? '').trim(),
        passwordEnc,
        fromAddress: input.fromAddress.trim(),
        fromName: (input.fromName ?? existing?.fromName ?? '').trim(),
        allowInvalidCerts: input.allowInvalidCerts ?? existing?.allowInvalidCerts ?? false,
    };
    ensureDataDir();
    writeFileSync(SMTP_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    cachedConfig = cfg;
    return cfg;
}

export function deleteSmtpConfig(): void {
    cachedConfig = null;
    try {
        if (existsSync(SMTP_FILE)) writeFileSync(SMTP_FILE, JSON.stringify({}, null, 2), 'utf-8');
    } catch {}
}

/** Public-safe view of the config (no password material). */
export function publicSmtpConfig(cfg: SmtpConfig | null): Record<string, unknown> | null {
    if (!cfg || !cfg.host) return null;
    return {
        host: cfg.host,
        port: cfg.port,
        security: cfg.security,
        username: cfg.username,
        hasPassword: !!cfg.passwordEnc,
        fromAddress: cfg.fromAddress,
        fromName: cfg.fromName,
        allowInvalidCerts: !!cfg.allowInvalidCerts,
    };
}

// ─── Minimal SMTP client ─────────────────────────────────────────────────────

interface SmtpConn {
    write(data: string): Promise<void>;
    readResponse(): Promise<{ code: number; lines: string[] }>;
    upgradeTls(host: string, allowInvalid: boolean): Promise<void>;
    close(): void;
    abort(reason: string): void;
}

function createConn(socket: Socket | TLSSocket): SmtpConn {
    let buffer = Buffer.alloc(0);
    const waiters: Array<{ res: (l: string) => void; rej: (e: Error) => void }> = [];
    const lineQueue: string[] = [];
    let closed = false;
    let closeErr: Error | null = null;
    let currentSocket: Socket | TLSSocket = socket;
    let onData: ((c: Buffer) => void) | null = null;
    let onError: ((e: Error) => void) | null = null;
    let onClose: (() => void) | null = null;

    function detach(s: Socket | TLSSocket) {
        if (onData) s.off('data', onData);
        if (onError) s.off('error', onError);
        if (onClose) s.off('close', onClose);
        onData = onError = onClose = null;
    }

    function attach(s: Socket | TLSSocket) {
        // Work in binary mode; SMTP lines are ASCII but we must not corrupt
        // bytes that belong to a TLS handshake when this socket is later
        // wrapped by tls.connect({ socket }).
        onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            let idx;
            while ((idx = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, idx).toString('utf-8');
                buffer = buffer.slice(idx + 2);
                const w = waiters.shift();
                if (w) w.res(line);
                else lineQueue.push(line);
            }
        };
        onError = (err: Error) => {
            closeErr = err; closed = true;
            while (waiters.length) waiters.shift()!.rej(err);
        };
        onClose = () => {
            closed = true;
            const err = closeErr || new Error('connection closed');
            while (waiters.length) waiters.shift()!.rej(err);
        };
        s.on('data', onData);
        s.on('error', onError);
        s.on('close', onClose);
    }
    attach(socket);

    function readLine(): Promise<string> {
        if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
        if (closed) return Promise.reject(closeErr || new Error('connection closed'));
        return new Promise((res, rej) => waiters.push({ res, rej }));
    }

    const conn: SmtpConn = {
        async write(data: string) {
            await new Promise<void>((res, rej) => {
                currentSocket.write(data, err => err ? rej(err) : res());
            });
        },
        async readResponse() {
            const lines: string[] = [];
            let code = 0;
            while (true) {
                const line = await readLine();
                if (line.length < 4) throw new Error('SMTP: short response line: ' + JSON.stringify(line));
                code = parseInt(line.slice(0, 3), 10);
                if (isNaN(code)) {
                    // Detect TLS-on-cleartext mismatch: if the bytes look like a
                    // TLS handshake (0x16 0x03 …) the server is speaking TLS while
                    // we're reading plaintext — wrong port/security combination.
                    const looksLikeTls = line.length > 0 && (line.charCodeAt(0) === 0x16 || /[^\x20-\x7e]/.test(line.slice(0, 8)));
                    if (looksLikeTls) {
                        throw new Error('SMTP: server appears to expect TLS on this port. If you selected "None" or "STARTTLS", try "TLS / SSL" (port 465). If you selected "TLS / SSL" on port 587, switch to "STARTTLS".');
                    }
                    throw new Error('SMTP: bad response code: ' + JSON.stringify(line.slice(0, 80)));
                }
                lines.push(line.slice(4));
                const sep = line.charAt(3);
                if (sep === ' ') return { code, lines };
                if (sep !== '-') throw new Error('SMTP: bad response separator: ' + JSON.stringify(line.slice(0, 80)));
            }
        },
        async upgradeTls(host: string, allowInvalid: boolean) {
            const plain = currentSocket as Socket;
            // Stop reading from the plaintext socket — any bytes that arrive
            // after this point belong to the TLS handshake and must be handed
            // to tls.connect, not to our SMTP line parser.
            detach(plain);
            // Any leftover bytes in our buffer would be lost to the TLS layer;
            // EHLO/STARTTLS responses are line-terminated so the buffer is
            // expected to be empty here, but reset just in case.
            buffer = Buffer.alloc(0);
            lineQueue.length = 0;
            const tls = await new Promise<TLSSocket>((res, rej) => {
                const t = tlsConnect({
                    socket: plain,
                    servername: host,
                    rejectUnauthorized: !allowInvalid,
                }, () => res(t));
                t.once('error', rej);
            });
            currentSocket = tls;
            attach(tls);
        },
        close() {
            try { currentSocket.end(); } catch {}
            try { currentSocket.destroy(); } catch {}
        },
        abort(reason: string) {
            closeErr = new Error(reason);
            closed = true;
            try { currentSocket.destroy(); } catch {}
            while (waiters.length) waiters.shift()!.rej(closeErr);
        },
    };
    return conn;
}

function expect(resp: { code: number; lines: string[] }, ok: (c: number) => boolean, what: string): void {
    if (!ok(resp.code)) {
        throw new Error(`SMTP ${what} failed: ${resp.code} ${resp.lines.join(' / ')}`);
    }
}

async function openSmtpConn(cfg: SmtpConfig, timeoutMs: number): Promise<SmtpConn> {
    const allowInvalid = !!cfg.allowInvalidCerts;
    const tlsOpen = cfg.security === 'tls';
    const socket: Socket | TLSSocket = await new Promise((res, rej) => {
        const timer = setTimeout(() => {
            try { (s as any).destroy(); } catch {}
            rej(new Error(`SMTP: connection timeout (${timeoutMs}ms)`));
        }, timeoutMs);
        const onConn = () => { clearTimeout(timer); res(s); };
        const s: Socket | TLSSocket = tlsOpen
            ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: !allowInvalid }, onConn)
            : netConnect({ host: cfg.host, port: cfg.port }, onConn);
        s.once('error', err => { clearTimeout(timer); rej(err); });
    });
    return createConn(socket);
}

function parseEhloCaps(lines: string[]): Set<string> {
    // First line is the greeting; rest are "CAP" or "CAP arg arg".
    const caps = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
        const tok = lines[i].trim().split(/\s+/)[0]?.toUpperCase();
        if (tok) caps.add(tok);
    }
    return caps;
}

function localHostname(): string {
    const h = process.env.HOSTNAME || 'midleman';
    return /^[a-zA-Z0-9.-]+$/.test(h) ? h : 'midleman';
}

export interface SendMailInput {
    to: string;
    subject: string;
    html: string;
    text: string;
}

export interface MailResult {
    ok: boolean;
    error?: string;
}

async function smtpHandshake(cfg: SmtpConfig, conn: SmtpConn): Promise<void> {
    const greet = await conn.readResponse();
    expect(greet, c => c === 220, 'greeting');

    const ehlo = async () => {
        await conn.write(`EHLO ${localHostname()}\r\n`);
        return conn.readResponse();
    };
    let ehloResp = await ehlo();
    expect(ehloResp, c => c === 250, 'EHLO');
    let caps = parseEhloCaps(ehloResp.lines);

    if (cfg.security === 'starttls') {
        if (!caps.has('STARTTLS')) throw new Error('SMTP: server does not advertise STARTTLS');
        await conn.write('STARTTLS\r\n');
        const r = await conn.readResponse();
        expect(r, c => c === 220, 'STARTTLS');
        await conn.upgradeTls(cfg.host, !!cfg.allowInvalidCerts);
        ehloResp = await ehlo();
        expect(ehloResp, c => c === 250, 'EHLO (post-TLS)');
        caps = parseEhloCaps(ehloResp.lines);
    }

    if (cfg.username && cfg.passwordEnc) {
        const password = decryptPassword(cfg.passwordEnc);
        // Match both modern "AUTH PLAIN LOGIN" and legacy "AUTH=PLAIN LOGIN".
        const authLines = ehloResp.lines.filter(l => /^AUTH[\s=]/i.test(l));
        const methods = new Set<string>();
        for (const l of authLines) {
            const rest = l.replace(/^AUTH[\s=]+/i, '').toUpperCase();
            for (const tok of rest.split(/[\s,]+/)) if (tok) methods.add(tok);
        }
        if (methods.has('PLAIN')) {
            const token = Buffer.from('\0' + cfg.username + '\0' + password, 'utf-8').toString('base64');
            await conn.write(`AUTH PLAIN ${token}\r\n`);
            const r = await conn.readResponse();
            expect(r, c => c === 235, 'AUTH PLAIN');
        } else if (methods.has('LOGIN')) {
            await conn.write('AUTH LOGIN\r\n');
            expect(await conn.readResponse(), c => c === 334, 'AUTH LOGIN');
            await conn.write(Buffer.from(cfg.username, 'utf-8').toString('base64') + '\r\n');
            expect(await conn.readResponse(), c => c === 334, 'AUTH LOGIN (user)');
            await conn.write(Buffer.from(password, 'utf-8').toString('base64') + '\r\n');
            expect(await conn.readResponse(), c => c === 235, 'AUTH LOGIN (pass)');
        } else if (methods.size === 0) {
            // No AUTH capability advertised. Common causes:
            //  - server requires STARTTLS first and only advertises AUTH on the
            //    second EHLO (we already handled that above, so this means
            //    you connected with security=none to a server that doesn't allow
            //    cleartext auth);
            //  - server doesn't require auth at all (then username should be empty).
            const hint = cfg.security === 'none'
                ? ' — server may require STARTTLS/TLS before allowing AUTH; try STARTTLS (port 587) or TLS (port 465).'
                : '';
            throw new Error('SMTP: server did not advertise AUTH after EHLO' + hint);
        } else {
            throw new Error('SMTP: no supported AUTH method (server offered: ' + Array.from(methods).join(', ') + '; we support PLAIN and LOGIN)');
        }
    }
}

function encodeAddress(name: string, email: string): string {
    if (!name) return `<${email}>`;
    // RFC 2047 'Q' encoding for non-ASCII names.
    const needsEnc = /[^\x20-\x7e]/.test(name) || /[<>,"]/.test(name);
    if (!needsEnc) return `"${name.replace(/"/g, '\\"')}" <${email}>`;
    const b64 = Buffer.from(name, 'utf-8').toString('base64');
    return `=?UTF-8?B?${b64}?= <${email}>`;
}

function encodeSubject(s: string): string {
    if (!/[^\x20-\x7e]/.test(s)) return s;
    return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;
}

function buildMime(cfg: SmtpConfig, input: SendMailInput, messageId: string): string {
    const boundary = 'mm_' + randomBytes(12).toString('hex');
    const date = new Date().toUTCString().replace(/GMT$/, '+0000');
    const headers = [
        `From: ${encodeAddress(cfg.fromName, cfg.fromAddress)}`,
        `To: <${input.to}>`,
        `Subject: ${encodeSubject(input.subject)}`,
        `Date: ${date}`,
        `Message-ID: <${messageId}>`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].join('\r\n');
    const body =
        `\r\n--${boundary}\r\n` +
        'Content-Type: text/plain; charset=UTF-8\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        Buffer.from(input.text, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n') + '\r\n' +
        `--${boundary}\r\n` +
        'Content-Type: text/html; charset=UTF-8\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        Buffer.from(input.html, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n') + '\r\n' +
        `--${boundary}--\r\n`;
    return headers + '\r\n' + body;
}

/** Dot-stuff per RFC 5321 §4.5.2 — any line starting with '.' gets an extra '.'. */
function dotStuff(data: string): string {
    return data.replace(/(^|\r\n)\.(?=[^\r\n]|$)/g, '$1..');
}

/**
 * Wraps an SMTP operation in a global deadline + abort signal. If either fires,
 * the socket is destroyed and any pending reads/writes reject immediately.
 */
async function withDeadline<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    work: (getConn: () => SmtpConn | null, setConn: (c: SmtpConn) => void) => Promise<T>,
): Promise<T> {
    let conn: SmtpConn | null = null;
    let timer: NodeJS.Timeout | null = null;
    let aborted = false;
    let abortReason = '';

    const abort = (reason: string) => {
        if (aborted) return;
        aborted = true;
        abortReason = reason;
        if (conn) conn.abort(reason);
    };

    const onSignalAbort = () => abort('cancelled by client');
    if (signal) {
        if (signal.aborted) abort('cancelled by client');
        else signal.addEventListener('abort', onSignalAbort, { once: true });
    }

    timer = setTimeout(() => abort(`operation timeout (${timeoutMs}ms)`), timeoutMs);

    try {
        return await work(() => conn, c => { conn = c; if (aborted) c.abort(abortReason); });
    } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onSignalAbort);
        if (conn) (conn as SmtpConn).close();
    }
}

export interface SmtpOpts {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export async function sendMail(input: SendMailInput, opts?: SmtpOpts): Promise<MailResult> {
    const cfg = cachedConfig;
    if (!cfg || !cfg.host) return { ok: false, error: 'SMTP not configured' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) return { ok: false, error: 'Invalid recipient address' };

    const timeoutMs = opts?.timeoutMs ?? 20000;
    try {
        return await withDeadline(timeoutMs, opts?.signal, async (_get, set) => {
            const conn = await openSmtpConn(cfg, Math.min(timeoutMs, 10000));
            set(conn);
            await smtpHandshake(cfg, conn);
            await conn.write(`MAIL FROM:<${cfg.fromAddress}>\r\n`);
            expect(await conn.readResponse(), c => c === 250, 'MAIL FROM');
            await conn.write(`RCPT TO:<${input.to}>\r\n`);
            expect(await conn.readResponse(), c => c === 250 || c === 251, 'RCPT TO');
            await conn.write('DATA\r\n');
            expect(await conn.readResponse(), c => c === 354, 'DATA');
            const messageId = randomBytes(16).toString('hex') + '@' + (cfg.fromAddress.split('@')[1] || 'midleman.local');
            const mime = buildMime(cfg, input, messageId);
            await conn.write(dotStuff(mime) + '\r\n.\r\n');
            expect(await conn.readResponse(), c => c === 250, 'DATA end');
            await conn.write('QUIT\r\n');
            try { await conn.readResponse(); } catch {}
            return { ok: true } as MailResult;
        });
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/** Verify SMTP connectivity + auth without sending a message. */
export async function testSmtpConnection(override?: SmtpConfigInput, opts?: SmtpOpts): Promise<MailResult> {
    let cfg: SmtpConfig | null = cachedConfig;
    if (override) {
        const passwordEnc = override.password !== undefined
            ? (override.password ? encryptPassword(override.password) : '')
            : (cachedConfig?.passwordEnc || '');
        cfg = {
            host: override.host,
            port: override.port,
            security: override.security,
            username: override.username || '',
            passwordEnc,
            fromAddress: override.fromAddress,
            fromName: override.fromName || '',
            allowInvalidCerts: override.allowInvalidCerts ?? false,
        };
    }
    if (!cfg || !cfg.host) return { ok: false, error: 'SMTP not configured' };
    const timeoutMs = opts?.timeoutMs ?? 10000;
    try {
        return await withDeadline(timeoutMs, opts?.signal, async (_get, set) => {
            const conn = await openSmtpConn(cfg!, Math.min(timeoutMs, 8000));
            set(conn);
            await smtpHandshake(cfg!, conn);
            await conn.write('QUIT\r\n');
            try { await conn.readResponse(); } catch {}
            return { ok: true } as MailResult;
        });
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

// ─── Templates ───────────────────────────────────────────────────────────────

export interface InviteEmailParams {
    inviteUrl: string;
    fullName?: string;
    note?: string;
    expiresInHours: number;
}

function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function getInviteBrandName(): string {
    return cachedConfig?.fromName?.trim() || '';
}

function appendBrand(base: string, brandName: string): string {
    return brandName ? `${base} — ${brandName}` : base;
}

function formatNaturalList(items: string[], wrap: (item: string) => string): string {
    if (items.length === 0) return '';
    if (items.length === 1) return wrap(items[0]);
    if (items.length === 2) return `${wrap(items[0])} and ${wrap(items[1])}`;
    return `${items.slice(0, -1).map(wrap).join(', ')}, and ${wrap(items[items.length - 1])}`;
}

function summarizeInviteSubject(resourceNames: string[]): string {
    if (resourceNames.length === 0) return 'Invitation';
    if (resourceNames.length === 1) return `Invitation to ${resourceNames[0]}`;
    if (resourceNames.length === 2) return `Invitation to ${resourceNames[0]} and ${resourceNames[1]}`;
    return `Invitation to ${resourceNames[0]}, ${resourceNames[1]} and ${resourceNames.length - 2} more`;
}

export function renderAdminInviteEmail(p: InviteEmailParams): { subject: string; html: string; text: string } {
    const brandName = getInviteBrandName();
    const subject = appendBrand('Admin invitation', brandName);
    const hello = p.fullName ? `Hi ${p.fullName},` : 'Hi,';
    const noteHtml = p.note ? `<p style="margin:16px 0 0;padding:12px 14px;background:#f6f7fb;border-left:3px solid #0078d4;font-size:13px;color:#52525b;font-style:italic">${escHtml(p.note)}</p>` : '';
    const noteText = p.note ? `\n\nNote: ${p.note}` : '';
    const expHours = p.expiresInHours;
    const footerHtml = brandName ? `<p style="margin:16px 0 0;font-size:11px;color:#a1a1aa;text-align:center;letter-spacing:0.08em;text-transform:uppercase">${escHtml(brandName)}</p>` : '';
    const footerText = brandName ? `\n— ${brandName}` : '';
    const inviteLineHtml = brandName
        ? `You have been invited to create an administrator account on <strong>${escHtml(brandName)}</strong>. To complete registration, click the button below and set your username and password.`
        : 'You have been invited to create an administrator account. To complete registration, click the button below and set your username and password.';
    const inviteLineText = brandName
        ? `You have been invited to create an administrator account on ${brandName}.`
        : 'You have been invited to create an administrator account.';
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:500;color:#0f1015">Admin invitation</h1>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">${escHtml(hello)}</p>
<p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">${inviteLineHtml}</p>
<p style="margin:24px 0"><a href="${escHtml(p.inviteUrl)}" style="display:inline-block;background:#0078d4;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600">Accept invitation</a></p>
<p style="margin:0 0 4px;font-size:12px;color:#71717a">Or copy this link:</p>
<p style="margin:0;font-size:12px;color:#52525b;word-break:break-all"><a href="${escHtml(p.inviteUrl)}" style="color:#0078d4">${escHtml(p.inviteUrl)}</a></p>
${noteHtml}
<p style="margin:24px 0 0;font-size:12px;color:#71717a">This invitation expires in ${expHours} hour${expHours === 1 ? '' : 's'}. If you were not expecting this email, you can safely ignore it.</p>
</td></tr></table>
${footerHtml}
</td></tr></table></body></html>`;
    const text = `${hello}

${inviteLineText}
Accept the invitation at: ${p.inviteUrl}
${noteText}

This invitation expires in ${expHours} hour${expHours === 1 ? '' : 's'}.
${footerText}`.trim();
    return { subject, html, text };
}

export interface ProxyInviteEmailParams {
    inviteUrl: string;
    profileName: string;
    invitedName: string;
    note?: string;
    expiresInHours: number;
    resourceNames?: string[];
}

export function renderProxyInviteEmail(p: ProxyInviteEmailParams): { subject: string; html: string; text: string } {
    const resourceNames = Array.from(new Set((p.resourceNames || []).map(name => name.trim()).filter(Boolean)));
    if (resourceNames.length === 0 && p.profileName) resourceNames.push(p.profileName);
    const hasResources = resourceNames.length > 0;
    const brandName = getInviteBrandName();
    const subject = appendBrand(summarizeInviteSubject(resourceNames), brandName);
    const hello = p.invitedName ? `Hi ${p.invitedName},` : 'Hi,';
    const noteHtml = p.note ? `<p style="margin:16px 0 0;padding:12px 14px;background:#f6f7fb;border-left:3px solid #0078d4;font-size:13px;color:#52525b;font-style:italic">${escHtml(p.note)}</p>` : '';
    const noteText = p.note ? `\n\nNote: ${p.note}` : '';
    const expHours = p.expiresInHours;
    const footerHtml = brandName ? `<p style="margin:16px 0 0;font-size:11px;color:#a1a1aa;text-align:center;letter-spacing:0.08em;text-transform:uppercase">${escHtml(brandName)}</p>` : '';
    const footerText = brandName ? `\n— ${brandName}` : '';
    const resourceListHtml = formatNaturalList(resourceNames, name => `<strong>${escHtml(name)}</strong>`);
    const resourceListText = formatNaturalList(resourceNames, name => `"${name}"`);
    const accessLine = hasResources
        ? (brandName
            ? `You have been invited to access ${resourceListHtml} on <strong>$System Access Services</strong>. Click the button below to set a username and password.`
            : `You have been invited to access ${resourceListHtml}. Click the button below to set a username and password.`)
        : (brandName
            ? `You have been invited to <strong>${escHtml(brandName)}</strong>. Click the button below to set a username and password.`
            : 'You have been invited. Click the button below to set a username and password.');
    const accessLineText = hasResources
        ? (brandName
            ? `You have been invited to access ${resourceListText} on ${brandName}.`
            : `You have been invited to access ${resourceListText}.`)
        : (brandName
            ? `You have been invited to ${brandName}.`
            : 'You have been invited.');
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:500;color:#0f1015">You're invited</h1>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">${escHtml(hello)}</p>
<p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">${accessLine}</p>
<p style="margin:0 0 20px;font-size:13px;color:#52525b;line-height:1.6;padding:10px 12px;background:#f6f7fb;border-left:3px solid #0078d4;border-radius:4px">🔐 For your security, you'll be asked to set up two-factor authentication (2FA) the first time you sign in. Have an authenticator app (Google Authenticator, Authy, 1Password, etc.) ready.</p>
<p style="margin:24px 0"><a href="${escHtml(p.inviteUrl)}" style="display:inline-block;background:#0078d4;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600">Accept invitation</a></p>
<p style="margin:0 0 4px;font-size:12px;color:#71717a">Or copy this link:</p>
<p style="margin:0;font-size:12px;color:#52525b;word-break:break-all"><a href="${escHtml(p.inviteUrl)}" style="color:#0078d4">${escHtml(p.inviteUrl)}</a></p>
${noteHtml}
<p style="margin:24px 0 0;font-size:12px;color:#71717a">This invitation expires in ${expHours} hour${expHours === 1 ? '' : 's'}. If you were not expecting this email, you can safely ignore it.</p>
</td></tr></table>
${footerHtml}
</td></tr></table></body></html>`;
    const text = `${hello}

${accessLineText}
Accept the invitation at: ${p.inviteUrl}

For your security, you'll be asked to set up two-factor authentication (2FA) the first time you sign in. Have an authenticator app ready.
${noteText}

This invitation expires in ${expHours} hour${expHours === 1 ? '' : 's'}.
${footerText}`.trim();
    return { subject, html, text };
}

export interface TwoFactorChangeEmailParams {
    fullName?: string;
    loginUrl?: string;
}

export function renderForce2faEmail(p: TwoFactorChangeEmailParams): { subject: string; html: string; text: string } {
    const brandName = getInviteBrandName();
    const subject = appendBrand('Two-factor authentication setup required', brandName);
    const hello = p.fullName ? `Hi ${p.fullName},` : 'Hi,';
    const footerHtml = brandName ? `<p style="margin:16px 0 0;font-size:11px;color:#a1a1aa;text-align:center;letter-spacing:0.08em;text-transform:uppercase">${escHtml(brandName)}</p>` : '';
    const footerText = brandName ? `\n— ${brandName}` : '';
    const ctaHtml = p.loginUrl
        ? `<p style="margin:24px 0"><a href="${escHtml(p.loginUrl)}" style="display:inline-block;background:#0078d4;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600">Sign in to set up 2FA</a></p>`
        : '';
    const ctaText = p.loginUrl ? `\nSign in here: ${p.loginUrl}` : '';
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:500;color:#0f1015">Two-factor authentication required</h1>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">${escHtml(hello)}</p>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">An administrator has required you to enable two-factor authentication (2FA) on your account. The next time you sign in you will be asked to scan a QR code with an authenticator app (Google Authenticator, Authy, 1Password, etc.) and enter a 6-digit code before you can continue.</p>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">This adds an extra layer of security to your account.</p>
${ctaHtml}
<p style="margin:24px 0 0;font-size:12px;color:#71717a">If you weren't expecting this email, please contact your administrator.</p>
</td></tr></table>
${footerHtml}
</td></tr></table></body></html>`;
    const text = `${hello}

An administrator has required you to enable two-factor authentication (2FA) on your account. The next time you sign in, you will be asked to scan a QR code with an authenticator app and enter a 6-digit code before you can continue.${ctaText}

If you weren't expecting this email, please contact your administrator.
${footerText}`.trim();
    return { subject, html, text };
}

export function render2faDisabledEmail(p: TwoFactorChangeEmailParams): { subject: string; html: string; text: string } {
    const brandName = getInviteBrandName();
    const subject = appendBrand('Two-factor authentication disabled', brandName);
    const hello = p.fullName ? `Hi ${p.fullName},` : 'Hi,';
    const footerHtml = brandName ? `<p style="margin:16px 0 0;font-size:11px;color:#a1a1aa;text-align:center;letter-spacing:0.08em;text-transform:uppercase">${escHtml(brandName)}</p>` : '';
    const footerText = brandName ? `\n— ${brandName}` : '';
    const ctaHtml = p.loginUrl
        ? `<p style="margin:24px 0"><a href="${escHtml(p.loginUrl)}" style="display:inline-block;background:#0078d4;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600">Sign in to re-enable 2FA</a></p>`
        : '';
    const ctaText = p.loginUrl ? `\nYou can re-enable 2FA from your account settings: ${p.loginUrl}` : '';
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:500;color:#0f1015">Two-factor authentication disabled</h1>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">${escHtml(hello)}</p>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">An administrator has disabled two-factor authentication (2FA) on your account. Your account is now protected only by your password.</p>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">For your security, we recommend re-enabling 2FA from your account settings as soon as possible.</p>
${ctaHtml}
<p style="margin:24px 0 0;font-size:12px;color:#71717a">If you did not request this change, please contact your administrator immediately.</p>
</td></tr></table>
${footerHtml}
</td></tr></table></body></html>`;
    const text = `${hello}

An administrator has disabled two-factor authentication (2FA) on your account. Your account is now protected only by your password.

For your security, we recommend re-enabling 2FA from your account settings as soon as possible.${ctaText}

If you did not request this change, please contact your administrator immediately.
${footerText}`.trim();
    return { subject, html, text };
}

export interface PasswordResetEmailParams {
    fullName?: string;
    resetUrl: string;
    expiresInMinutes: number;
    initiatedByAdmin: boolean;
}

export function renderPasswordResetEmail(p: PasswordResetEmailParams): { subject: string; html: string; text: string } {
    const brandName = getInviteBrandName();
    const subject = appendBrand('Password reset', brandName);
    const hello = p.fullName ? `Hi ${p.fullName},` : 'Hi,';
    const footerHtml = brandName ? `<p style="margin:16px 0 0;font-size:11px;color:#a1a1aa;text-align:center;letter-spacing:0.08em;text-transform:uppercase">${escHtml(brandName)}</p>` : '';
    const footerText = brandName ? `\n— ${brandName}` : '';
    const lead = p.initiatedByAdmin
        ? 'An administrator has issued a password reset for your account. Click the button below to choose a new password.'
        : 'We received a request to reset your password. Click the button below to choose a new password. If you did not request this, you can safely ignore this email.';
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:500;color:#0f1015">Password reset</h1>
<p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.6">${escHtml(hello)}</p>
<p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">${lead}</p>
<p style="margin:24px 0"><a href="${escHtml(p.resetUrl)}" style="display:inline-block;background:#0078d4;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600">Choose a new password</a></p>
<p style="margin:0 0 4px;font-size:12px;color:#71717a">Or copy this link:</p>
<p style="margin:0;font-size:12px;color:#52525b;word-break:break-all"><a href="${escHtml(p.resetUrl)}" style="color:#0078d4">${escHtml(p.resetUrl)}</a></p>
<p style="margin:20px 0 0;font-size:12px;color:#71717a">This link expires in ${p.expiresInMinutes} minute${p.expiresInMinutes === 1 ? '' : 's'} and can only be used once. Your existing two-factor authentication settings remain unchanged.</p>
</td></tr></table>
${footerHtml}
</td></tr></table></body></html>`;
    const text = `${hello}

${lead}

Reset your password: ${p.resetUrl}

This link expires in ${p.expiresInMinutes} minute${p.expiresInMinutes === 1 ? '' : 's'} and can only be used once. Your existing two-factor authentication settings remain unchanged.
${footerText}`.trim();
    return { subject, html, text };
}

export function renderTestEmail(): { subject: string; html: string; text: string } {
    return {
        subject: 'Midleman SMTP — Test',
        html: '<p style="font-family:sans-serif;font-size:14px;color:#0f1015">It works ✔. Your Midleman SMTP configuration is operational.</p>',
        text: 'It works. Your Midleman SMTP configuration is operational.',
    };
}
