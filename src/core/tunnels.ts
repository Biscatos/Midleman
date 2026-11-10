// Named tunnels: a fixed Midleman port that reaches host:port on an agent's network,
// so a tool on the LAN (redis-cli, a SQL client, a browser) uses a cloud-internal
// service as if it were local — while the cloud server exposes nothing.
//
// Security model, in order:
//   1. no allowed addresses  → the port listens on 127.0.0.1 only (Midleman itself);
//   2. allowed addresses set → listens on all interfaces, every other source is closed at accept;
//   3. the agent still refuses any target outside its own TUNNEL_ALLOW;
//   4. connection limit per tunnel; every create / change / delete is audited by the caller.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import type { TCPSocketListener } from 'bun';
import { ipInCidrs } from './ssrf-guard';
import { muxSocket, type MuxStream } from './tunnel-mux';
import { openTunnelStream, probeTunnel, tunnelConnected } from './agent-tunnel';
import { getAllAssignedPorts, PORT_RANGE_START } from '../servers/port-manager';

export interface Tunnel {
    name: string;
    description: string;
    /** Server monitor (agent) whose network holds the target. */
    agent: string;
    host: string;
    port: number;
    /** Port Midleman listens on. */
    listenPort: number;
    /** IPv4 addresses / CIDRs that may connect. Empty = only Midleman itself (127.0.0.1). */
    allowedIps: string[];
    maxConnections: number;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    createdBy?: string;
}
interface ConnLog { at: number; ip: string; ms: number; up: number; down: number; error?: string }
interface Runtime {
    listener: TCPSocketListener<any> | null; bound: string; error: string | null;
    active: number; total: number; rejected: number; lastRejected: { ip: string; at: number; why: string } | null;
    /** MuxAcct: Out = client → remote, In = remote → client. */
    bytesIn: number; bytesOut: number;
    lastUsed: number | null; lastError: { msg: string; at: number } | null; recent: ConnLog[];
}

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const FILE = resolve(DATA_DIR, 'tunnels.json');
const tunnels = new Map<string, Tunnel>();
const runtime = new Map<string, Runtime>();
let reserved: number[] = [];

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,251}[a-zA-Z0-9])?$/;
const CIDR_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(\d|[12]\d|3[0-2]))?$/;

function persist(): void {
    try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify([...tunnels.values()], null, 2), 'utf-8'); }
    catch (e) { console.error('[tunnels] could not save tunnels.json:', e instanceof Error ? e.message : e); }
}
function rt(name: string): Runtime {
    let r = runtime.get(name);
    if (!r) { r = { listener: null, bound: '', error: null, active: 0, total: 0, rejected: 0, lastRejected: null, bytesIn: 0, bytesOut: 0, lastUsed: null, lastError: null, recent: [] }; runtime.set(name, r); }
    return r;
}
function portsTaken(except?: string): Set<number> {
    const a = getAllAssignedPorts();
    return new Set<number>([...reserved, ...Object.values(a.proxies || {}), ...Object.values(a.webhooks || {}), ...Object.values(a.tcpUdp || {}), ...Object.values(a.connectors || {}), ...[...tunnels.values()].filter(t => t.name !== except).map(t => t.listenPort)]);
}

function accept(name: string, port: number, everyone: boolean): TCPSocketListener<any> {
    return Bun.listen<{ st: MuxStream } | undefined>({
        hostname: everyone ? '0.0.0.0' : '127.0.0.1', port,
        socket: {
            open(sock) {
                // the record is read on every accept: allowed addresses, target and limit apply without a restart
                const t = tunnels.get(name), r = runtime.get(name);
                if (!t || !r) { sock.end(); return; }
                const ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
                const refuse = (why: string) => { r.rejected++; r.lastRejected = { ip, at: Date.now(), why }; sock.end(); };
                if (ip !== '127.0.0.1' && !ipInCidrs(ip, t.allowedIps)) return refuse('address not allowed');
                if (r.active >= t.maxConnections) return refuse('connection limit reached');
                const at = Date.now();
                const st = openTunnelStream(t.agent, t.host, t.port, {
                    acct: r,
                    onEnd: (err) => {
                        r.active--;
                        r.recent.unshift({ at, ip, ms: Date.now() - at, up: st?.bytesOut ?? 0, down: st?.bytesIn ?? 0, error: err });
                        if (r.recent.length > 50) r.recent.length = 50;
                        if (err) r.lastError = { msg: err, at: Date.now() };
                    },
                });
                if (!st) { r.lastError = { msg: `agent "${t.agent}" is not connected`, at }; return refuse('agent offline'); }
                r.active++; r.total++; r.lastUsed = at;
                sock.data = { st }; st.attach(sock);
            },
            ...muxSocket,
        },
    });
}

/** Bring the listener in line with the record. Only a port / bind / on-off change restarts it. */
function sync(t: Tunnel): void {
    const r = rt(t.name);
    const everyone = t.allowedIps.length > 0, want = t.enabled ? `${everyone ? '0.0.0.0' : '127.0.0.1'}:${t.listenPort}` : '';
    if (r.listener && r.bound === want) return;
    if (r.listener) { try { r.listener.stop(true); } catch {} r.listener = null; r.bound = ''; }
    r.error = null;
    if (!t.enabled) return;
    // shortcut: a disabled tunnel keeps its port number but not the socket, so a proxy created meanwhile can take it; the tunnel then shows "port in use" and needs another port. Reserve disabled ports in port-manager if that ever bites.
    try { r.listener = accept(t.name, t.listenPort, everyone); r.bound = want; console.log(`🔌 [tunnel] "${t.name}" ${want} → ${t.agent} → ${t.host}:${t.port}`); }
    catch (e: any) { r.error = /EADDRINUSE|in use/i.test(String(e?.code || e?.message)) ? `port ${t.listenPort} is already in use` : String(e?.message || e); console.error(`[tunnels] "${t.name}": ${r.error}`); }
}

/** First port from the published range that nothing holds. */
function freePort(except?: string): number {
    const taken = portsTaken(except);
    for (let p = PORT_RANGE_START; p < PORT_RANGE_START + 2000 && p < 65535; p++) {
        if (taken.has(p)) continue;
        try { Bun.listen({ hostname: '0.0.0.0', port: p, socket: { data() {} } }).stop(true); return p; } catch { /* held by something else */ }
    }
    throw new Error('no free port in the published range');
}

/** Load tunnels.json and start the enabled ones. `reservedPorts` = Midleman's own listeners. */
export function startTunnels(reservedPorts: number[]): void {
    reserved = reservedPorts.filter(p => p > 0);
    try { for (const t of existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf-8')) : []) if (t?.name) tunnels.set(t.name, t); }
    catch (e) { console.error('[tunnels] could not read tunnels.json:', e instanceof Error ? e.message : e); }
    for (const t of tunnels.values()) sync(t);
}

export function listTunnels() {
    return [...tunnels.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => {
        const r = rt(t.name);
        return {
            ...t,
            status: !t.enabled ? 'disabled' : r.error ? 'error' : tunnelConnected(t.agent) ? 'online' : 'offline',
            error: r.error, active: r.active, total: r.total, rejected: r.rejected, lastRejected: r.lastRejected,
            bytesUp: r.bytesOut, bytesDown: r.bytesIn, lastUsed: r.lastUsed, lastError: r.lastError, recent: r.recent,
        };
    });
}
export function getTunnel(name: string): Tunnel | undefined { return tunnels.get(name.toLowerCase()); }

/** Create (existing = undefined) or update. Throws an Error whose message is safe to show. */
export function saveTunnel(input: any, existing?: Tunnel, actor?: string): Tunnel {
    const name = existing ? existing.name : String(input?.name || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new Error('Name: lowercase letters, digits, dot, dash or underscore (max 63)');
    if (!existing && tunnels.has(name)) throw new Error(`A tunnel named "${name}" already exists`);
    const agent = String(input?.agent || '').trim().toLowerCase();
    if (!agent || agent.length > 64) throw new Error('Choose the agent (server) that reaches the target');
    const host = String(input?.host || '').trim();
    if (!HOST_RE.test(host)) throw new Error('Remote host: an IP address or hostname as seen from the agent');
    const port = Number(input?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Remote port must be 1–65535');
    const raw: unknown[] = Array.isArray(input?.allowedIps) ? input.allowedIps : String(input?.allowedIps || '').split(/[\s,;]+/);
    const allowedIps = [...new Set(raw.map(x => String(x).trim()).filter(Boolean))];
    for (const c of allowedIps) {
        if (!CIDR_RE.test(c)) throw new Error(`Allowed address "${c}" is not an IPv4 address or CIDR`);
        if (c.includes('/') && Number(c.split('/')[1]) < 8) throw new Error(`Allowed address "${c}" is too broad — list the networks that need this tunnel`);
    }
    if (allowedIps.length > 64) throw new Error('At most 64 allowed addresses');
    const maxConnections = input?.maxConnections === undefined || input.maxConnections === '' ? (existing?.maxConnections ?? 100) : Number(input.maxConnections);
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 10_000) throw new Error('Connection limit must be 1–10000');
    let listenPort = Number(input?.listenPort) || 0;
    if (listenPort) {
        if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) throw new Error('Midleman port must be 1024–65535 (or empty to pick one)');
        if (portsTaken(name).has(listenPort)) throw new Error(`Port ${listenPort} is already used by Midleman or another tunnel`);
    } else listenPort = existing?.listenPort || freePort(name);
    const now = Date.now();
    const t: Tunnel = {
        name, description: String(input?.description || '').trim().slice(0, 200), agent, host, port, listenPort, allowedIps, maxConnections,
        enabled: input?.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
        createdAt: existing?.createdAt ?? now, updatedAt: now, createdBy: existing?.createdBy ?? actor,
    };
    tunnels.set(name, t); persist(); sync(t);
    return t;
}

export function deleteTunnel(name: string): boolean {
    const t = tunnels.get(name); if (!t) return false;
    const r = runtime.get(name);
    if (r?.listener) { try { r.listener.stop(true); } catch {} }
    runtime.delete(name); tunnels.delete(name); persist();
    return true;
}

export function testTunnel(t: Tunnel) { return probeTunnel(t.agent, t.host, t.port); }
