import type { SipMessage } from './message';
import { parseVia } from './message';

// ─── Header Utilities ─────────────────────────────────────────────────────────

/** Case-insensitive header lookup. Returns first match or undefined. */
function getHeader(headers: [string, string][], name: string): string | undefined {
    const lower = name.toLowerCase();
    return headers.find(([n]) => n.toLowerCase() === lower)?.[1];
}

/** Extract structured fields from a flat headers array */
function buildStructured(headers: [string, string][], body: Buffer): Omit<SipMessage, 'isRequest' | 'method' | 'requestUri' | 'statusCode' | 'reasonPhrase' | 'sipVersion' | 'headers' | 'body'> {
    const viaHeaders = headers.filter(([n]) => n.toLowerCase() === 'via');
    const vias = viaHeaders.map(([, v]) => parseVia(v));

    const callId = getHeader(headers, 'call-id') ?? getHeader(headers, 'i') ?? '';
    const cseqRaw = getHeader(headers, 'cseq') ?? '';
    const cseqParts = cseqRaw.trim().split(/\s+/);
    const cseqNum = parseInt(cseqParts[0] ?? '0', 10);
    const cseqMethod = cseqParts[1] ?? '';

    const maxFwdStr = getHeader(headers, 'max-forwards') ?? '70';

    return {
        vias,
        callId,
        cseq: cseqRaw,
        cseqMethod,
        cseqNum,
        from: getHeader(headers, 'from') ?? getHeader(headers, 'f') ?? '',
        to: getHeader(headers, 'to') ?? getHeader(headers, 't') ?? '',
        maxForwards: parseInt(maxFwdStr, 10),
    };
}

// ─── Shared Parse Logic ───────────────────────────────────────────────────────

/**
 * Parse a complete SIP message from a Buffer (headers + body already split).
 * `headerBlock` is everything before the blank line; `body` is everything after.
 */
function parseHeaderBlock(headerBlock: string, body: Buffer): SipMessage {
    const lines = headerBlock.split(/\r?\n/);
    const firstLine = lines[0]?.trim() ?? '';

    // Unfold continuation lines (SP or TAB at start = continuation of previous header)
    const rawHeaderLines: string[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (line[0] === ' ' || line[0] === '\t') {
            // Fold: append to last header
            const last = rawHeaderLines.length - 1;
            if (last >= 0) rawHeaderLines[last] += ' ' + line.trim();
        } else {
            rawHeaderLines.push(line.trimEnd());
        }
    }

    const headers: [string, string][] = [];
    for (const line of rawHeaderLines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const name = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (name) headers.push([name, value]);
    }

    const structured = buildStructured(headers, body);

    // Request: "METHOD uri SIP/2.0"
    // Response: "SIP/2.0 code reason"
    if (firstLine.startsWith('SIP/')) {
        const parts = firstLine.split(' ');
        const sipVersion = parts[0] ?? 'SIP/2.0';
        const statusCode = parseInt(parts[1] ?? '0', 10);
        const reasonPhrase = parts.slice(2).join(' ');
        return { isRequest: false, sipVersion, statusCode, reasonPhrase, headers, body, ...structured };
    } else {
        const parts = firstLine.split(' ');
        const method = parts[0] ?? '';
        const requestUri = parts[1] ?? '';
        const sipVersion = parts[2] ?? 'SIP/2.0';
        return { isRequest: true, method, requestUri, sipVersion, headers, body, ...structured };
    }
}

// ─── UDP Parser (one datagram = one message) ──────────────────────────────────

/**
 * Parse a complete SIP message from a single UDP datagram.
 * Throws if the buffer is not a valid SIP message.
 */
export function parseSipMessage(buf: Buffer): SipMessage {
    const str = buf.toString('utf8');
    const sepIdx = str.indexOf('\r\n\r\n');
    const fallbackIdx = str.indexOf('\n\n');

    let headerStr: string;
    let bodyStart: number;

    if (sepIdx !== -1) {
        headerStr = str.slice(0, sepIdx);
        bodyStart = sepIdx + 4;
    } else if (fallbackIdx !== -1) {
        headerStr = str.slice(0, fallbackIdx);
        bodyStart = fallbackIdx + 2;
    } else {
        headerStr = str;
        bodyStart = str.length;
    }

    const contentLengthStr = headerStr.match(/(?:^|\r?\n)(?:content-length|l)\s*:\s*(\d+)/i)?.[1];
    const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;
    const body = buf.subarray(bodyStart, bodyStart + contentLength);

    return parseHeaderBlock(headerStr, Buffer.from(body));
}

// ─── TCP/TLS Parser (stateful, framed by Content-Length) ─────────────────────

type ParserState = 'headers' | 'body';

export class SipTcpParser {
    private buf = Buffer.alloc(0);
    private state: ParserState = 'headers';
    private headerStr = '';
    private contentLength = 0;

    constructor(private readonly onMessage: (msg: SipMessage) => void) {}

    feed(chunk: Buffer): void {
        this.buf = Buffer.concat([this.buf, chunk]);
        this.process();
    }

    private process(): void {
        while (true) {
            if (this.state === 'headers') {
                // Find header/body separator
                const str = this.buf.toString('utf8');
                let sepIdx = str.indexOf('\r\n\r\n');
                let sepLen = 4;
                if (sepIdx === -1) {
                    const fb = str.indexOf('\n\n');
                    if (fb !== -1) { sepIdx = fb; sepLen = 2; }
                }
                if (sepIdx === -1) break; // need more data

                this.headerStr = str.slice(0, sepIdx);
                // Extract Content-Length
                const clMatch = this.headerStr.match(/(?:^|\r?\n)(?:content-length|l)\s*:\s*(\d+)/i);
                this.contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;

                // Consume header bytes
                this.buf = this.buf.subarray(Buffer.byteLength(str.slice(0, sepIdx + sepLen), 'utf8'));
                this.state = 'body';
            }

            if (this.state === 'body') {
                if (this.buf.length < this.contentLength) break; // need more data

                const body = Buffer.from(this.buf.subarray(0, this.contentLength));
                this.buf = this.buf.subarray(this.contentLength);
                this.state = 'headers';

                try {
                    const msg = parseHeaderBlock(this.headerStr, body);
                    this.onMessage(msg);
                } catch (err) {
                    console.warn('[sip-parser] Failed to parse SIP message:', err instanceof Error ? err.message : err);
                }

                this.headerStr = '';
                this.contentLength = 0;
            }
        }
    }

    reset(): void {
        this.buf = Buffer.alloc(0);
        this.state = 'headers';
        this.headerStr = '';
        this.contentLength = 0;
    }
}
