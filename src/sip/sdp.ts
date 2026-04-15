/**
 * SDP (Session Description Protocol) — parser and rewriter.
 *
 * Only handles the first audio media block. Video and other media types are
 * passed through unchanged. RTCP is handled via the adjacent port (RTP+1).
 */

export interface SdpAudio {
    /** Connection address where the sender wants to receive audio */
    ip: string;
    /** RTP port where the sender wants to receive audio */
    port: number;
    /** e.g. "RTP/SAVP", "RTP/AVP" */
    protocol: string;
    /** Codec payload types e.g. "0 8 101" */
    codecs: string;
}

/**
 * Extract audio media info from an SDP body.
 * Returns null if no audio block found or port is 0 (on-hold).
 */
export function parseSdpAudio(body: Buffer): SdpAudio | null {
    const text = body.toString('utf8');
    const lines = text.split(/\r?\n/);

    let sessionIp = '';
    let audioIp = '';
    let inAudio = false;
    let audioPort = 0;
    let audioProtocol = '';
    let audioCodecs = '';

    for (const raw of lines) {
        const line = raw.trimEnd();

        if (line.startsWith('c=IN IP4 ')) {
            const ip = line.slice('c=IN IP4 '.length).trim();
            if (inAudio) audioIp = ip;
            else sessionIp = ip;
        }

        if (line.startsWith('m=')) {
            if (inAudio) break; // already processed audio block
            if (line.startsWith('m=audio ')) {
                inAudio = true;
                audioIp = ''; // reset — there may be a media-level c=
                const parts = line.slice('m=audio '.length).split(' ');
                // format: port protocol codecs...
                audioPort = parseInt(parts[0], 10);
                audioProtocol = parts[1] ?? '';
                audioCodecs = parts.slice(2).join(' ');
            }
        }
    }

    if (!inAudio || audioPort === 0) return null;

    const ip = audioIp || sessionIp;
    if (!ip) return null;

    return { ip, port: audioPort, protocol: audioProtocol, codecs: audioCodecs };
}

/**
 * Rewrite the connection IP and audio port in an SDP body.
 * Preserves all other lines unchanged.
 * Returns a new Buffer with the rewritten SDP.
 */
export function rewriteSdpAudio(body: Buffer, newIp: string, newPort: number): Buffer {
    const text = body.toString('utf8');
    // Preserve original line ending style
    const crlf = text.includes('\r\n');
    const lines = text.split(/\r?\n/);

    let inAudio = false;
    let sessionCRewritten = false;
    let audioCRewritten = false;
    let audioMRewritten = false;

    const rewritten = lines.map(raw => {
        const line = raw.trimEnd();

        if (line.startsWith('m=')) {
            if (line.startsWith('m=audio ') && !audioMRewritten) {
                inAudio = true;
                audioMRewritten = true;
                const parts = line.split(' ');
                parts[1] = String(newPort); // replace port
                return parts.join(' ');
            }
            inAudio = false;
            return line;
        }

        if (line.startsWith('c=IN IP4 ')) {
            if (inAudio && !audioCRewritten) {
                audioCRewritten = true;
                return `c=IN IP4 ${newIp}`;
            }
            if (!inAudio && !sessionCRewritten) {
                sessionCRewritten = true;
                return `c=IN IP4 ${newIp}`;
            }
        }

        // Rewrite RTCP port attribute in audio section
        if (inAudio && line.startsWith('a=rtcp:')) {
            return `a=rtcp:${newPort + 1}`;
        }

        return line;
    });

    return Buffer.from(rewritten.join(crlf ? '\r\n' : '\n'), 'utf8');
}

/**
 * Return true if the SIP message has an SDP body
 * (Content-Type: application/sdp).
 */
export function hasSdpBody(headers: [string, string][], body: Buffer): boolean {
    if (!body.length) return false;
    for (const [name, value] of headers) {
        if (name.toLowerCase() === 'content-type') {
            return value.toLowerCase().includes('application/sdp');
        }
    }
    return false;
}
