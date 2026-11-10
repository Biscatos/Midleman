// Stream multiplexer for the agent reverse tunnel — shared by Midleman (the side that
// opens streams) and the agent (the side that dials the real service). No imports
// from the rest of Midleman: the agent needs only this file plus its own entry point.
//
// Wire protocol v2, one WebSocket carries many TCP streams:
//   text frames   = JSON control
//       {t:'open',id,host,port,win}   Midleman → agent: dial host:port; `win` = my receive window
//       {t:'opened',id,win}           agent → Midleman: connected; `win` = my receive window
//       {t:'error',id,msg}            the dial failed / was refused
//       {t:'close',id}                the stream's socket ended on my side
//       {t:'win',id,n}                I delivered n more bytes to my socket: you may send n more
//       {t:'ping',ts} / {t:'pong',ts} liveness and round-trip time
//   binary frames = 4-byte big-endian stream id + payload
//
// Flow control is credit based, per stream and per direction (the HTTP/2 / yamux model):
// a sender never has more than the receiver's window in flight, so a slow reader stalls
// only its own stream and memory per stream is bounded by the window. On top of that a
// connection stops reading all its sockets while the WebSocket itself is congested, so
// nothing piles up in the WebSocket send buffer either.

import type { Socket } from 'bun';

export const TUNNEL_PROTO = 2;
/** Receive window per stream. Throughput per stream tops out near window ÷ round-trip time. */
export const TUNNEL_WINDOW = Math.min(64, Math.max(1, Number(process.env.TUNNEL_WINDOW_MB) || 2)) * 1024 * 1024;
const WS_HIGH = 4 * 1024 * 1024, WS_LOW = 1024 * 1024;

export interface MuxTransport { send(data: string | Uint8Array): unknown; buffered(): number }
/** Byte counters a caller can share between streams (one per tunnel). */
export interface MuxAcct { bytesIn: number; bytesOut: number }

export class Mux {
    readonly streams = new Map<number, MuxStream>();
    stalled = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private dead = false;
    constructor(private readonly t: MuxTransport) {}

    open(id: number, acct?: MuxAcct): MuxStream { const s = new MuxStream(this, id, acct); this.streams.set(id, s); return s; }
    ctl(o: object): void { if (!this.dead) this.t.send(JSON.stringify(o)); }
    bin(frame: Uint8Array): void { if (!this.dead) this.t.send(frame); }

    /** True while the WebSocket send buffer is too full to take more; streams pause their sockets meanwhile. */
    congested(): boolean {
        if (!this.stalled && this.t.buffered() > WS_HIGH) { this.stalled = true; this.timer = setInterval(() => this.relief(), 5); }
        return this.stalled;
    }
    /** Called by the poll above and by the server's WebSocket `drain` event. */
    relief(): void {
        if (!this.stalled || this.t.buffered() > WS_LOW) return;
        this.stalled = false; if (this.timer) clearInterval(this.timer); this.timer = null;
        for (const s of this.streams.values()) s.maybeResume();
    }

    onBinary(buf: Buffer): void { if (buf.length >= 4) this.streams.get(buf.readUInt32BE(0))?.deliver(buf.subarray(4)); }
    /** Handles the per-stream control frames; returns false for the ones the caller owns (open, ping, pong). */
    onCtl(c: any): boolean {
        const s = this.streams.get(c.id);
        switch (c.t) {
            case 'win': s?.grant(Number(c.n) || 0); return true;
            case 'opened': s?.ready(Number(c.win) || TUNNEL_WINDOW); return true;
            case 'error': s?.fail(String(c.msg || 'tunnel error')); return true;
            case 'close': s?.peerClosed(); return true;
        }
        return false;
    }
    destroy(why: string): void {
        if (this.timer) clearInterval(this.timer); this.timer = null;
        for (const s of [...this.streams.values()]) s.fail(why);
        this.dead = true;
    }
}

export class MuxStream {
    sock: Socket<any> | null = null;
    bytesIn = 0; bytesOut = 0;
    readonly since = Date.now();
    onOpen: (() => void) | null = null;
    /** Fired once, when the stream leaves the mux; `err` is set when it failed rather than ended. */
    onEnd: ((err?: string) => void) | null = null;
    private credit = 0;                    // bytes I may still send to the peer
    private consumed = 0;                  // bytes delivered to my socket since my last `win`
    private out: Uint8Array[] = [];        // from the peer, waiting for my socket to drain (≤ my window)
    private pre: Uint8Array[] | null = []; // from my socket, before the peer said the stream is open
    private paused = false; private ending = false; private done = false;
    constructor(readonly mux: Mux, readonly id: number, private readonly acct?: MuxAcct) {}

    attach(sock: Socket<any>): void {
        if (this.done) { sock.end(); return; }
        this.sock = sock;
        try { sock.setNoDelay(true); sock.setKeepAlive(true, 60_000); } catch {}
        if (this.pre) this.pause();
        if (this.out.length) this.drain();
    }
    /** The peer is connected: `credit` is its receive window. */
    ready(credit: number): void {
        if (this.done || !this.pre) return;
        const q = this.pre; this.pre = null; this.credit = credit;
        for (const c of q) this.push(c);
        const f = this.onOpen; this.onOpen = null; f?.();
        this.maybeResume();
    }

    // ── my socket → peer ──
    fromSock(chunk: Uint8Array): void {
        if (this.done) return;
        if (this.pre) { this.pre.push(Buffer.from(chunk)); this.pause(); return; } // copy: the read buffer is reused
        this.push(chunk);
    }
    private push(chunk: Uint8Array): void {
        const f = Buffer.allocUnsafe(4 + chunk.length); f.writeUInt32BE(this.id, 0); f.set(chunk, 4);
        this.mux.bin(f);
        this.credit -= chunk.length; this.bytesOut += chunk.length; if (this.acct) this.acct.bytesOut += chunk.length;
        if (this.credit <= 0 || this.mux.congested()) this.pause();
    }
    grant(n: number): void { this.credit += n; this.maybeResume(); }
    maybeResume(): void {
        if (this.paused && !this.done && !this.pre && this.credit > 0 && !this.mux.stalled) { this.paused = false; this.sock?.resume(); }
    }
    private pause(): void { if (!this.paused) { this.paused = true; this.sock?.pause(); } }

    // ── peer → my socket ──
    deliver(p: Uint8Array): void {
        this.bytesIn += p.length; if (this.acct) this.acct.bytesIn += p.length;
        if (this.out.length || !this.sock) { this.out.push(p); return; }
        const n = Math.max(0, this.sock.write(p));
        if (n < p.length) this.out.push(p.subarray(n));
        this.ack(n);
    }
    /** My socket can take more: flush what the peer sent, then finish a pending close. */
    drain(): void {
        const s = this.sock; if (!s) return;
        while (this.out.length) {
            const h = this.out[0], n = Math.max(0, s.write(h));
            this.ack(n);
            if (n < h.length) { this.out[0] = h.subarray(n); return; }
            this.out.shift();
        }
        if (this.ending) s.end();
    }
    private ack(n: number): void {
        if (this.done) return;
        this.consumed += n;
        if (this.consumed >= TUNNEL_WINDOW / 2) { this.mux.ctl({ t: 'win', id: this.id, n: this.consumed }); this.consumed = 0; }
    }

    // ── endings ──
    /** The peer's socket ended: deliver what is still queued, then close mine. */
    peerClosed(): void {
        if (this.done) return;
        this.ending = true; this.finish();
        if (!this.out.length) { try { this.sock?.end(); } catch {} }
    }
    /** My socket ended. */
    sockClosed(): void {
        this.sock = null; this.out = [];
        if (!this.done) { this.finish(); this.mux.ctl({ t: 'close', id: this.id }); }
    }
    /** The stream broke on the peer's side (dial refused, connection lost): nothing to tell the peer. */
    fail(msg: string): void {
        if (this.done) return;
        this.finish(msg); this.out = [];
        try { this.sock?.end(); } catch {}
    }
    /** I give up on the stream (timeout, limit): tell the peer and close my socket. */
    close(err?: string): void {
        if (this.done) return;
        this.finish(err); this.out = [];
        this.mux.ctl({ t: 'close', id: this.id });
        try { this.sock?.end(); } catch {}
    }
    private finish(err?: string): void {
        this.done = true; this.mux.streams.delete(this.id);
        const f = this.onEnd; this.onEnd = null; this.onOpen = null; f?.(err);
    }
}

/** Socket handlers for Bun.listen / Bun.connect; the stream lives in `sock.data.st`. */
export const muxSocket = {
    data(sock: Socket<any>, chunk: Uint8Array) { sock.data?.st?.fromSock(chunk); },
    drain(sock: Socket<any>) { sock.data?.st?.drain(); },
    close(sock: Socket<any>) { sock.data?.st?.sockClosed(); },
    error(sock: Socket<any>) { sock.data?.st?.sockClosed(); },
};
