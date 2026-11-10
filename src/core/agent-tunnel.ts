// Reverse tunnels through the Docker-host agent (FRP-style, zero extra setup).
//
// The agent already keeps an outbound connection to Midleman; here it also opens a
// WebSocket to /agent/tunnel. Midleman can then ask it to connect to a host:port
// on ITS network (a Redis or database whose port is not exposed to the internet)
// and the bytes flow over the WebSocket. Monitors use it transparently: a monitor
// with `via: "<agent>"` gets a local 127.0.0.1 port that Midleman bridges to the
// remote service, so Bun's Redis/SQL clients need nothing special.
//
// Wire protocol (one WebSocket per agent, many streams):
//   text frames  = JSON control: {t:'open',id,host,port} / {t:'opened',id} / {t:'error',id,msg} / {t:'close',id} / {t:'ping'} / {t:'pong'}
//   binary frames = 4-byte big-endian stream id + payload
// The agent decides what it is willing to reach (TUNNEL_ALLOW); Midleman never dials
// anything itself on the remote side.

import type { ServerWebSocket, Server, Socket, TCPSocketListener } from 'bun';

interface Stream { id: number; local: Socket<any> | null; onOpen: (() => void) | null; onError: ((msg: string) => void) | null; /** bytes from the local client until the agent reports the remote side open (a DB client talks first) */ pending: Buffer[] | null; }
interface AgentConn { name: string; ws: ServerWebSocket<TunnelWsData>; since: number; lastSeen: number; streams: Map<number, Stream>; nextId: number; remoteIp: string }
export interface TunnelWsData { agent: string; remoteIp: string }

const agents = new Map<string, AgentConn>();
/** `${agent}|${host}:${port}` → local listener (reused by every check against that target). */
const bridges = new Map<string, { listener: TCPSocketListener<any>; port: number; agent: string; host: string; port_: number; lastUsed: number; opened: number }>();
const STREAM_TIMEOUT_MS = 15_000;

export function tunnelAgents(): { name: string; since: number; lastSeen: number; streams: number; remoteIp: string }[] {
    return [...agents.values()].map(a => ({ name: a.name, since: a.since, lastSeen: a.lastSeen, streams: a.streams.size, remoteIp: a.remoteIp }));
}
export function tunnelConnected(agent: string): boolean { return agents.has(agent.toLowerCase()); }
export function tunnelBridges() { return [...bridges.values()].map(b => ({ agent: b.agent, target: `${b.host}:${b.port_}`, localPort: b.port, lastUsed: b.lastUsed, opened: b.opened })); }

/** Bun.serve `websocket` handlers — attach to every server that accepts /agent/tunnel. */
export const tunnelWebSocket = {
    open(ws: ServerWebSocket<TunnelWsData>) {
        const name = ws.data.agent;
        const prev = agents.get(name);
        if (prev) { try { prev.ws.close(1012, 'replaced by a new connection'); } catch {} failAll(prev, 'agent reconnected'); }
        agents.set(name, { name, ws, since: Date.now(), lastSeen: Date.now(), streams: new Map(), nextId: 1, remoteIp: ws.data.remoteIp });
        console.log(`🔌 [tunnel] agent "${name}" connected from ${ws.data.remoteIp}`);
    },
    message(ws: ServerWebSocket<TunnelWsData>, msg: string | Buffer) {
        const a = agents.get(ws.data.agent); if (!a) return;
        a.lastSeen = Date.now();
        if (typeof msg === 'string') {
            let c: any; try { c = JSON.parse(msg); } catch { return; }
            if (c.t === 'ping') { ws.send(JSON.stringify({ t: 'pong' })); return; }
            const s = a.streams.get(c.id); if (!s) return;
            if (c.t === 'opened') { s.onOpen?.(); s.onOpen = null; s.onError = null; const q = s.pending; s.pending = null; for (const f of q || []) ws.send(f); }
            else if (c.t === 'error') { s.onError?.(String(c.msg || 'tunnel error')); dropStream(a, c.id, false); }
            else if (c.t === 'close') dropStream(a, c.id, false);
            return;
        }
        const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as any);
        if (buf.length < 4) return;
        const id = buf.readUInt32BE(0);
        const s = a.streams.get(id);
        if (s?.local) s.local.write(buf.subarray(4));
    },
    close(ws: ServerWebSocket<TunnelWsData>) {
        const a = agents.get(ws.data.agent);
        if (a && a.ws === ws) { failAll(a, 'agent disconnected'); agents.delete(ws.data.agent); console.log(`🔌 [tunnel] agent "${ws.data.agent}" disconnected`); }
    },
};

function failAll(a: AgentConn, why: string): void { for (const id of [...a.streams.keys()]) { a.streams.get(id)?.onError?.(why); dropStream(a, id, false); } }
function dropStream(a: AgentConn, id: number, tellAgent: boolean): void {
    const s = a.streams.get(id); if (!s) return;
    a.streams.delete(id);
    try { s.local?.end(); } catch {}
    if (tellAgent) { try { a.ws.send(JSON.stringify({ t: 'close', id })); } catch {} }
}

/** Upgrade handler: authenticated agent name is passed by the caller (token already checked). Returns undefined when upgraded. */
export function upgradeTunnel(server: Server<any>, req: Request, agent: string, remoteIp: string): Response | undefined {
    const ok = (server as Server<TunnelWsData>).upgrade(req, { data: { agent: agent.toLowerCase(), remoteIp } });
    return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
}

/** Local 127.0.0.1 port bridged to host:port on the agent's network. Reused per target. */
export async function tunnelLocalPort(agent: string, host: string, port: number): Promise<number> {
    const name = agent.toLowerCase();
    if (!agents.has(name)) throw new Error(`agent "${agent}" has no tunnel connection (is it running with TUNNEL_ALLOW set?)`);
    const key = `${name}|${host}:${port}`;
    const hit = bridges.get(key);
    if (hit) { hit.lastUsed = Date.now(); return hit.port; }
    const listener = Bun.listen<{ id: number; agent: string }>({
        hostname: '127.0.0.1', port: 0,
        socket: {
            open(sock) {
                const a = agents.get(name);
                if (!a) { sock.end(); return; }
                const id = a.nextId++;
                sock.data = { id, agent: name };
                const s: Stream = { id, local: sock, onOpen: null, onError: null, pending: [] };
                a.streams.set(id, s);
                const b = bridges.get(key); if (b) { b.lastUsed = Date.now(); b.opened++; }
                const timer = setTimeout(() => { if (a.streams.get(id)?.onOpen) { s.onError?.('timeout opening remote connection'); dropStream(a, id, true); } }, STREAM_TIMEOUT_MS);
                s.onOpen = () => clearTimeout(timer);
                s.onError = (m) => { clearTimeout(timer); console.warn(`[tunnel] ${name} → ${host}:${port}: ${m}`); };
                a.ws.send(JSON.stringify({ t: 'open', id, host, port }));
            },
            data(sock, data) {
                const a = agents.get(sock.data.agent); const s = a?.streams.get(sock.data.id); if (!a || !s) { sock.end(); return; }
                const frame = Buffer.allocUnsafe(4 + data.length); frame.writeUInt32BE(sock.data.id, 0); Buffer.from(data).copy(frame, 4);
                if (s.pending) s.pending.push(frame); else a.ws.send(frame);
            },
            close(sock) { const a = agents.get(sock.data?.agent); if (a && sock.data) { const s = a.streams.get(sock.data.id); if (s) { s.local = null; dropStream(a, sock.data.id, true); } } },
            error(sock, err) { const a = agents.get(sock.data?.agent); if (a && sock.data) dropStream(a, sock.data.id, true); void err; },
        },
    });
    bridges.set(key, { listener, port: listener.port, agent: name, host, port_: port, lastUsed: Date.now(), opened: 0 });
    console.log(`🔌 [tunnel] 127.0.0.1:${listener.port} → ${name} → ${host}:${port}`);
    return listener.port;
}

/** Idle bridges are closed after an hour; disconnected agents lose theirs at once. */
setInterval(() => {
    const now = Date.now();
    for (const [key, b] of bridges) if (now - b.lastUsed > 60 * 60_000 || !agents.has(b.agent)) { try { b.listener.stop(true); } catch {} bridges.delete(key); }
}, 60_000);
