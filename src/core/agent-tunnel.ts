// Reverse tunnels through the Docker-host agent (FRP-style, zero extra setup).
//
// The agent keeps outbound WebSockets to /agent/tunnel. Midleman can then ask it to
// connect to a host:port on ITS network (a Redis or database whose port is not exposed
// to the internet) and the bytes flow over the WebSocket. Two users of this:
//   • monitors with `via: "<agent>"` — tunnelLocalPort() gives a 127.0.0.1 port bridged
//     to the remote service, so Bun's Redis/SQL clients need nothing special;
//   • named tunnels (tunnels.ts) — a fixed Midleman port that people and tools connect to.
// The agent decides what it is willing to reach (TUNNEL_ALLOW); Midleman never dials
// anything itself on the remote side. Protocol and flow control: tunnel-mux.ts.
//
// An agent holds a small pool of WebSockets (TUNNEL_CONNS, default 2): each new stream
// goes to the least busy one, so a lost packet or a heavy transfer on one TCP connection
// does not stall every stream of that agent.

import type { ServerWebSocket, Server, TCPSocketListener } from 'bun';
import { Mux, muxSocket, TUNNEL_PROTO, TUNNEL_WINDOW, type MuxAcct, type MuxStream } from './tunnel-mux';

interface Conn { name: string; ws: ServerWebSocket<TunnelWsData>; mux: Mux; since: number; lastSeen: number; rttMs: number | null; remoteIp: string; nextId: number }
export interface TunnelWsData { agent: string; remoteIp: string; conn?: Conn }

const agents = new Map<string, Conn[]>();
const MAX_CONNS_PER_AGENT = 8;
const OPEN_TIMEOUT_MS = 15_000;
/** `${agent}|${host}:${port}` → local listener (reused by every check against that target). */
const bridges = new Map<string, { listener: TCPSocketListener<any>; port: number; agent: string; host: string; port_: number; lastUsed: number; opened: number }>();

export function tunnelAgents(): { name: string; since: number; lastSeen: number; connections: number; streams: number; rttMs: number | null; remoteIp: string }[] {
    return [...agents.entries()].filter(([, l]) => l.length).map(([name, l]) => {
        const rtts = l.map(c => c.rttMs).filter((x): x is number => x !== null);
        return { name, since: Math.min(...l.map(c => c.since)), lastSeen: Math.max(...l.map(c => c.lastSeen)), connections: l.length, streams: l.reduce((a, c) => a + c.mux.streams.size, 0), rttMs: rtts.length ? Math.min(...rtts) : null, remoteIp: l[0].remoteIp };
    });
}
export function tunnelConnected(agent: string): boolean { return !!agents.get(agent.toLowerCase())?.length; }
export function tunnelBridges() { return [...bridges.values()].map(b => ({ agent: b.agent, target: `${b.host}:${b.port_}`, localPort: b.port, lastUsed: b.lastUsed, opened: b.opened })); }

/** Bun.serve `websocket` handlers — attach to every server that accepts /agent/tunnel. */
export const tunnelWebSocket = {
    perMessageDeflate: false,                 // tunnelled bytes are mostly TLS or binary: compressing them only burns CPU
    maxPayloadLength: 16 * 1024 * 1024,
    backpressureLimit: 64 * 1024 * 1024,      // flow control keeps the buffer near 4 MB; past this the peer is gone or hostile
    closeOnBackpressureLimit: true,           // never drop a frame silently: a hole in a stream is corruption
    idleTimeout: 120,
    open(ws: ServerWebSocket<TunnelWsData>) {
        const name = ws.data.agent;
        const list = agents.get(name) ?? [];
        if (list.length >= MAX_CONNS_PER_AGENT) { ws.close(1013, 'too many tunnel connections for this agent'); return; }
        const conn: Conn = { name, ws, since: Date.now(), lastSeen: Date.now(), rttMs: null, remoteIp: ws.data.remoteIp, nextId: 0, mux: new Mux({ send: d => ws.send(d), buffered: () => ws.getBufferedAmount() }) };
        ws.data.conn = conn; list.push(conn); agents.set(name, list);
        conn.mux.ctl({ t: 'ping', ts: performance.now() });
        console.log(`🔌 [tunnel] agent "${name}" connected from ${ws.data.remoteIp} (${list.length} connection${list.length > 1 ? 's' : ''})`);
    },
    message(ws: ServerWebSocket<TunnelWsData>, msg: string | Buffer) {
        const c = ws.data.conn; if (!c) return;
        c.lastSeen = Date.now();
        if (typeof msg !== 'string') { c.mux.onBinary(msg); return; }
        let m: any; try { m = JSON.parse(msg); } catch { return; }
        if (m.t === 'pong') { if (Number.isFinite(m.ts)) c.rttMs = Math.max(0, Math.round(performance.now() - m.ts)); }   // monotonic: immune to clock steps
        else if (m.t === 'ping') c.mux.ctl({ t: 'pong', ts: m.ts });
        else c.mux.onCtl(m);
    },
    drain(ws: ServerWebSocket<TunnelWsData>) { ws.data.conn?.mux.relief(); },
    close(ws: ServerWebSocket<TunnelWsData>, code: number, reason: string) {
        const c = ws.data.conn; if (!c) return;
        const list = (agents.get(c.name) ?? []).filter(x => x !== c);
        if (list.length) agents.set(c.name, list); else agents.delete(c.name);
        c.mux.destroy('agent disconnected');
        console.log(`🔌 [tunnel] agent "${c.name}" lost a connection (${list.length} left, code ${code}${reason ? ' ' + reason : ''})`);
    },
};

/** Round-trip time per connection, and the agent's proof that Midleman is still there. */
setInterval(() => { const ts = performance.now(); for (const l of agents.values()) for (const c of l) c.mux.ctl({ t: 'ping', ts }); }, 15_000);

/** Upgrade handler: authenticated agent name is passed by the caller (token already checked). Returns undefined when upgraded. */
export function upgradeTunnel(server: Server<any>, req: Request, agent: string, remoteIp: string): Response | undefined {
    if (new URL(req.url).searchParams.get('v') !== String(TUNNEL_PROTO)) return new Response(`tunnel protocol v${TUNNEL_PROTO} required — update the agent image`, { status: 426 });
    const ok = (server as Server<TunnelWsData>).upgrade(req, { data: { agent: agent.toLowerCase(), remoteIp } });
    return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
}

/** Ask the agent to dial host:port. Null when the agent has no tunnel connection. Attach a socket to the stream, or just wait for onOpen. */
export function openTunnelStream(agent: string, host: string, port: number, hooks: { acct?: MuxAcct; onOpen?: () => void; onEnd?: (err?: string) => void } = {}): MuxStream | null {
    const list = agents.get(agent.toLowerCase()); if (!list?.length) return null;
    let c = list[0]; for (const x of list) if (x.mux.streams.size < c.mux.streams.size) c = x;
    let id = c.nextId; do { id = id >= 0xffffffff ? 1 : id + 1; } while (c.mux.streams.has(id)); c.nextId = id;
    const st = c.mux.open(id, hooks.acct);
    const timer = setTimeout(() => st.close('timeout opening the remote connection'), OPEN_TIMEOUT_MS);
    st.onOpen = () => { clearTimeout(timer); hooks.onOpen?.(); };
    st.onEnd = (err) => { clearTimeout(timer); hooks.onEnd?.(err); };
    c.mux.ctl({ t: 'open', id, host, port, win: TUNNEL_WINDOW });
    return st;
}

/** Can the agent reach host:port? Opens a stream, waits for the dial, closes it. */
export function probeTunnel(agent: string, host: string, port: number): Promise<{ ok: boolean; ms: number; error?: string }> {
    const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
    return new Promise(resolve => {
        const st = openTunnelStream(agent, host, port, {
            onOpen: () => { resolve({ ok: true, ms: ms() }); st?.close(); },
            onEnd: (err) => resolve({ ok: false, ms: ms(), error: err || 'closed before it opened' }),
        });
        if (!st) resolve({ ok: false, ms: 0, error: `agent "${agent}" has no tunnel connection` });
    });
}

/** How long a monitor waits for a disconnected agent to come back (agents retry at most every 15 s). */
const TUNNEL_GRACE_MS = Number(process.env.TUNNEL_GRACE_MS ?? 20_000);

/** Local 127.0.0.1 port bridged to host:port on the agent's network. Reused per target. */
export async function tunnelLocalPort(agent: string, host: string, port: number): Promise<number> {
    const name = agent.toLowerCase();
    // a Midleman restart or a network blip drops the agent for a few seconds: let it dial back before a monitor reports a false failure
    for (let i = 0; i < TUNNEL_GRACE_MS / 250 && !tunnelConnected(name); i++) await Bun.sleep(250);
    if (!tunnelConnected(name)) throw new Error(`agent "${agent}" has no tunnel connection (is it running with TUNNEL_ALLOW set?)`);
    const key = `${name}|${host}:${port}`;
    const hit = bridges.get(key);
    if (hit) { hit.lastUsed = Date.now(); return hit.port; }
    const listener = Bun.listen<{ st: MuxStream } | undefined>({
        hostname: '127.0.0.1', port: 0,
        socket: {
            open(sock) {
                const st = openTunnelStream(name, host, port, { onEnd: (err) => { if (err) console.warn(`[tunnel] ${name} → ${host}:${port}: ${err}`); } });
                if (!st) { sock.end(); return; }
                const b = bridges.get(key); if (b) { b.lastUsed = Date.now(); b.opened++; }
                sock.data = { st }; st.attach(sock);
            },
            ...muxSocket,
        },
    });
    bridges.set(key, { listener, port: listener.port, agent: name, host, port_: port, lastUsed: Date.now(), opened: 0 });
    console.log(`🔌 [tunnel] 127.0.0.1:${listener.port} → ${name} → ${host}:${port}`);
    return listener.port;
}

/** Idle bridges are closed after an hour; disconnected agents lose theirs at once. */
setInterval(() => {
    const now = Date.now();
    for (const [key, b] of bridges) if (now - b.lastUsed > 60 * 60_000 || !tunnelConnected(b.agent)) { try { b.listener.stop(true); } catch {} bridges.delete(key); }
}, 60_000);
