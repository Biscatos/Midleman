// Midleman agent — runs on each Docker host and pushes a report to Midleman.
//
// Outbound only: the server needs no open port, no inbound rule, no VPN — the
// same model as a Cloudflare tunnel connector. Reads the Docker socket
// (read-only) and, when /hostfs is mounted, the host's disks.
//
//   docker run -d --name midleman-agent --restart unless-stopped \
//     --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m \
//     -v /var/run/docker.sock:/var/run/docker.sock:ro -v /:/hostfs:ro \
//     -e MIDLEMAN_URL=https://reports.example.com -e AGENT_NAME=srv-200 -e AGENT_TOKEN=mma_... \
//     registry.biscatos.com/midleman/api-midleman:<tag> bun run src/agent/index.ts
//
// Env: MIDLEMAN_URL (required), AGENT_TOKEN (required), AGENT_NAME (default hostname),
//      AGENT_INTERVAL seconds (default 30), LOG_PATTERN regex (default ERROR|Exception|FATAL|panic),
//      LOG_IGNORE regex (optional), DOCKER_SOCK (default /var/run/docker.sock),
//      SKIP_CONTAINERS comma list (default: this agent's own container).
//      TUNNEL_ALLOW private | host:port list | off, TUNNEL_CONNS parallel connections (default 2),
//      TUNNEL_MAX_STREAMS (default 512), TUNNEL_WINDOW_MB per-stream window (default 2, same on both sides).

import { hostname } from 'os';
import { Mux, muxSocket, TUNNEL_PROTO, TUNNEL_WINDOW } from '../core/tunnel-mux';

const URL_BASE = (process.env.MIDLEMAN_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.AGENT_TOKEN || '';
const NAME = process.env.AGENT_NAME || hostname();
const INTERVAL = Math.max(10, Number(process.env.AGENT_INTERVAL) || 30);
const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const PATTERN = new RegExp(process.env.LOG_PATTERN || 'ERROR|Exception|FATAL|panic', 'i');
const IGNORE = process.env.LOG_IGNORE ? new RegExp(process.env.LOG_IGNORE, 'i') : null;
const SKIP = new Set((process.env.SKIP_CONTAINERS || 'midleman-agent').split(',').map(s => s.trim()).filter(Boolean));
if (!URL_BASE || !TOKEN) { console.error('MIDLEMAN_URL and AGENT_TOKEN are required'); process.exit(2); }
// Reports include log lines → HTTPS only, except to a private/LAN Midleman (or AGENT_ALLOW_HTTP=1 for a lab).
{
    const u = new URL(URL_BASE);
    // Private IPs, localhost, and container/compose names (no public TLD: "midleman", "midlemanprod.api", "*.internal", "*.local").
    const lan = /^(localhost|host\.docker\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)
        || !u.hostname.includes('.') || /\.(internal|local|lan|docker)$/.test(u.hostname) || /^[a-z0-9_-]+\.(api|app|svc|srv|db|web|prod|dev|stage)$/i.test(u.hostname);
    if (u.protocol !== 'https:' && !lan && process.env.AGENT_ALLOW_HTTP !== '1') { console.error(`MIDLEMAN_URL must be https:// (got ${u.protocol}//${u.hostname}); set AGENT_ALLOW_HTTP=1 only for a trusted network`); process.exit(2); }
}
/** Secrets must never leave the server inside a log line. */
const REDACT: [RegExp, string][] = [
    [/\b(authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 ***'],
    [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2***'],
    [/([?&](?:token|key|secret|password|sig|signature)=)[^&\s]+/gi, '$1***'],
    [/\b(?:\d[ -]?){13,19}\b/g, '***card***'],
];
const redact = (line: string) => REDACT.reduce((l, [re, to]) => l.replace(re, to), line);

const docker = (path: string) => fetch(`http://localhost${path}`, { unix: SOCK, signal: AbortSignal.timeout(20_000) } as any);
const dockerJson = async (path: string) => { const r = await docker(path); if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`); return r.json() as Promise<any>; };

/** Docker multiplexes stdout/stderr in 8-byte frames unless the container has a TTY. */
function demux(buf: Uint8Array, tty: boolean): string {
    if (tty) return new TextDecoder().decode(buf);
    let out = '', i = 0;
    while (i + 8 <= buf.length) {
        const len = (buf[i + 4] << 24 | buf[i + 5] << 16 | buf[i + 6] << 8 | buf[i + 7]) >>> 0;
        out += new TextDecoder().decode(buf.subarray(i + 8, i + 8 + len)); i += 8 + len;
    }
    return out;
}

const lastLogAt = new Map<string, number>(); // container id → unix seconds of the last line we read
const lastCpu = new Map<string, { cpu: number; sys: number }>(); // container id → counters of the previous cycle
/** CPU % between two samples of Docker's cumulative counters; null when there is no earlier sample. */
export function cpuPct(prev: { cpu: number; sys: number } | undefined, cur: { cpu: number; sys: number }, cpus: number): number | null {
    if (!prev || cur.sys <= prev.sys || cur.cpu < prev.cpu) return null;   // first cycle, or the container restarted
    return Math.round(1000 * (cur.cpu - prev.cpu) / (cur.sys - prev.sys) * cpus) / 10;
}
let lastReport = 0;

async function containerReport(c: any): Promise<any> {
    const id: string = c.Id, name: string = (c.Names?.[0] || c.Id).replace(/^\//, '');
    const base = { id: id.slice(0, 12), name, image: c.Image, status: c.State, health: null as string | null, restartCount: 0, oomKilled: false, restartPolicy: 'no', exitCode: null as number | null, startedAt: null as string | null, cpuPct: null as number | null, memBytes: null as number | null, memLimit: null as number | null, errors: [] as { at: number; line: string }[] };
    try {
        const ins = await dockerJson(`/containers/${id}/json`);
        base.health = ins.State?.Health?.Status || null;
        base.restartCount = ins.RestartCount || 0;
        base.restartPolicy = ins.HostConfig?.RestartPolicy?.Name || 'no';
        base.oomKilled = ins.State?.OOMKilled === true;
        base.exitCode = ins.State?.Running ? null : (ins.State?.ExitCode ?? null);
        base.startedAt = ins.State?.StartedAt || null;
        if (ins.State?.Running) try {
            // one-shot: dockerd answers from one cgroup read instead of sampling for 1-2 s per container (measured 300x cheaper);
            // CPU % is the delta against our previous cycle. A container that will not answer must not hold the whole report.
            const sr = await fetch(`http://localhost/containers/${id}/stats?stream=false&one-shot=true`, { unix: SOCK, signal: AbortSignal.timeout(6_000) } as any);
            if (!sr.ok) throw new Error(`stats HTTP ${sr.status}`);
            const st = await sr.json() as any;
            const cur = { cpu: st.cpu_stats?.cpu_usage?.total_usage || 0, sys: st.cpu_stats?.system_cpu_usage || 0 };
            base.cpuPct = cpuPct(lastCpu.get(id), cur, st.cpu_stats?.online_cpus || 1);
            lastCpu.set(id, cur);
            const cache = st.memory_stats?.stats?.inactive_file || st.memory_stats?.stats?.cache || 0;
            if (st.memory_stats?.usage) base.memBytes = Math.max(0, st.memory_stats.usage - cache);
            if (st.memory_stats?.limit) base.memLimit = st.memory_stats.limit;
        } catch (e: any) { console.warn(`[agent] stats unavailable for ${name}: ${e.message}`); } // CPU/RAM stay null; never an "error line" of the app
        // logs since the previous read (first run: last interval only, so a backlog never floods)
        const since = lastLogAt.get(id) ?? Math.floor(Date.now() / 1000) - INTERVAL;
        const now = Math.floor(Date.now() / 1000);
        // a stopped container writes nothing more: once read past its end, leave it alone (most containers on a host can be stopped)
        const finished = ins.State?.Running ? Infinity : Math.ceil(Date.parse(ins.State?.FinishedAt || '') / 1000) || 0;
        if (since > finished) return base;
        // tail makes dockerd read the log file from its end; without it every call decodes the whole file to find `since`
        // shortcut: more than 2000 lines in one interval loses the oldest ones, raise tail if a container logs that fast
        const r = await docker(`/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&since=${since}&until=${now}&tail=2000`);
        if (r.ok) {
            const text = demux(new Uint8Array(await r.arrayBuffer()), ins.Config?.Tty === true);
            for (const raw of text.split('\n')) {
                const line = raw.trimEnd(); if (!line) continue;
                const ts = Date.parse(line.slice(0, 30).split(' ')[0]) || Date.now();
                const msg = line.replace(/^\S+\s/, '');
                if (PATTERN.test(msg) && !(IGNORE && IGNORE.test(msg))) { base.errors.push({ at: ts, line: redact(msg).slice(0, 500) }); if (base.errors.length >= 100) break; }
            }
        }
        lastLogAt.set(id, now);
    } catch (e: any) { console.warn(`[agent] could not inspect ${name}: ${e.message}`); }
    return base;
}

async function hostReport(): Promise<any> {
    const host: any = { hostname: hostname(), memPct: null, disks: [] };
    try { if (await Bun.file('/hostfs/etc/hostname').exists()) host.hostname = (await Bun.file('/hostfs/etc/hostname').text()).trim() || host.hostname; } catch {}
    try {
        const mem = await Bun.file('/proc/meminfo').text();
        const kb = (k: string) => Number((mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
        const total = kb('MemTotal'), avail = kb('MemAvailable');
        if (total) { host.memTotal = total * 1024; host.memPct = Math.round(1000 * (total - avail) / total) / 10; }
        host.load1 = Number((await Bun.file('/proc/loadavg').text()).split(' ')[0]);
        host.uptimeSec = Math.floor(Number((await Bun.file('/proc/uptime').text()).split(' ')[0]));
    } catch {}
    try {
        // df on the host's root when mounted at /hostfs (plus docker's data dir), else the container's own view
        const roots = (await Bun.file('/hostfs/etc/hostname').exists()) ? ['/hostfs', '/hostfs/var/lib/docker', '/hostfs/home', '/hostfs/var'] : ['/'];
        const out = await new Response(Bun.spawn(['df', '-Pk', ...roots], { stderr: 'ignore' }).stdout).text();
        const seen = new Set<string>();
        for (const line of out.split('\n').slice(1)) {
            const f = line.trim().split(/\s+/); if (f.length < 6) continue;
            const total = Number(f[1]) * 1024, used = Number(f[2]) * 1024, mount = f[5].replace(/^\/hostfs/, '') || '/';
            if (seen.has(f[0]) || !total) continue; seen.add(f[0]);
            host.disks.push({ mount, total, used, pct: Math.round(100 * used / total) });
        }
    } catch {}
    return host;
}

// Inside a container the hostname is the container id: never report ourselves (our own log says
// "N error lines", which would match the pattern and alert on itself forever).
const SELF_ID = hostname();
async function tick(): Promise<void> {
    const list: any[] = await dockerJson('/containers/json?all=1');
    const mine = (c: any) => c.Id.startsWith(SELF_ID) || SKIP.has((c.Names?.[0] || '').replace(/^\//, ''));
    const containers = await Promise.all(list.filter(c => !mine(c)).map(containerReport));
    const report = { agent: NAME, at: Date.now(), intervalSeconds: INTERVAL, host: await hostReport(), containers };
    const res = await fetch(`${URL_BASE}/agent/report`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(report), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Midleman answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    lastReport = Date.now();
    const down = containers.filter(c => c.status !== 'running').length, errs = containers.reduce((a, c) => a + c.errors.length, 0);
    console.log(`[agent] ${new Date().toISOString()} sent ${containers.length} containers, ${down} down, ${errs} error lines`);
}

// ─── Reverse tunnel (FRP-style, no extra setup) ─────────────────────────────
// Midleman asks this agent to connect to host:port on OUR network and relays the
// bytes over an outbound WebSocket. What we are willing to reach is decided HERE:
//   TUNNEL_ALLOW=private  (default) → loopback, RFC1918/CGNAT and container names (no dots) only
//   TUNNEL_ALLOW=10.0.0.5:6379,db.internal:5432 → exactly these targets
//   TUNNEL_ALLOW=off → tunnels disabled
const TUNNEL_ALLOW = (process.env.TUNNEL_ALLOW || 'private').trim();
const TUNNEL_MAX_STREAMS = Math.max(1, Number(process.env.TUNNEL_MAX_STREAMS) || 512);
/** Parallel WebSockets to Midleman (1–8). */
const TUNNEL_CONNS = Math.min(8, Math.max(1, Number(process.env.TUNNEL_CONNS) || 2));
let tunnelStreams = 0;
function tunnelAllowed(host: string, port: number): boolean {
    if (TUNNEL_ALLOW === 'off') return false;
    if (TUNNEL_ALLOW === 'private') {
        const h = host.toLowerCase();
        return h === 'localhost' || h === 'host.docker.internal' || !h.includes('.') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(h) || /\.(internal|local|lan|docker)$/.test(h);
    }
    return TUNNEL_ALLOW.split(',').map(x => x.trim()).filter(Boolean).some(x => x === `${host}:${port}` || x === host);
}
/** One outbound WebSocket; TUNNEL_CONNS of these run side by side so one slow TCP path does not stall every stream. */
async function tunnelLoop(n: number): Promise<void> {
    const wsUrl = URL_BASE.replace(/^http/, 'ws') + `/agent/tunnel?v=${TUNNEL_PROTO}`;
    let backoff = 2000;
    for (;;) {
        await new Promise<void>((resolve) => {
            const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Agent-Name': NAME } } as any);
            ws.binaryType = 'arraybuffer';
            const mux = new Mux({ send: d => { if (ws.readyState === 1) ws.send(d); }, buffered: () => ws.bufferedAmount });
            // Midleman pings every 15 s: 45 s of silence means the path is dead even if TCP has not noticed
            // monotonic clock: a wall-clock step (NTP, VM time sync) must not look like 45 s of silence
            let seen = performance.now();
            const watchdog = setInterval(() => { if (performance.now() - seen > 45_000) { try { (ws as any).terminate ? (ws as any).terminate() : ws.close(); } catch {} } }, 10_000);
            ws.onopen = () => { backoff = 2000; seen = performance.now(); console.log(`[agent] tunnel #${n} connected (${TUNNEL_ALLOW === 'private' ? 'private targets' : TUNNEL_ALLOW})`); };
            ws.onmessage = (ev) => {
                seen = performance.now();
                if (typeof ev.data !== 'string') { mux.onBinary(Buffer.from(ev.data as ArrayBuffer)); return; }
                let c: any; try { c = JSON.parse(ev.data); } catch { return; }
                if (c.t === 'ping') { mux.ctl({ t: 'pong', ts: c.ts }); return; }
                if (c.t !== 'open') { mux.onCtl(c); return; }
                const id = Number(c.id), host = String(c.host || ''), port = Number(c.port);
                const refuse = (msg: string) => mux.ctl({ t: 'error', id, msg });
                if (!Number.isInteger(id) || !host || !Number.isInteger(port) || port < 1 || port > 65535) return refuse('bad target');
                if (!tunnelAllowed(host, port)) { console.warn(`[agent] tunnel refused ${host}:${port} (TUNNEL_ALLOW=${TUNNEL_ALLOW})`); return refuse(`target ${host}:${port} not allowed by this agent (TUNNEL_ALLOW)`); }
                if (tunnelStreams >= TUNNEL_MAX_STREAMS) return refuse('too many open tunnel streams on this agent (TUNNEL_MAX_STREAMS)');
                if (mux.streams.has(id)) return refuse('stream id already in use');
                const st = mux.open(id); tunnelStreams++;
                st.onEnd = () => { tunnelStreams--; };
                const live = () => mux.streams.get(id) === st;   // Midleman may have given up while we were dialling
                const failed = (err: any) => { if (live()) { refuse(`connect ${host}:${port}: ${err?.message || err}`); st.fail('connect failed'); } };
                Bun.connect({
                    hostname: host, port, data: { st },
                    socket: {
                        open(sock) {
                            if (!live()) { sock.end(); return; }
                            st.attach(sock); mux.ctl({ t: 'opened', id, win: TUNNEL_WINDOW }); st.ready(Number(c.win) || TUNNEL_WINDOW);
                        },
                        ...muxSocket,
                        connectError(_sock, err) { failed(err); },
                    },
                }).catch(failed);
            };
            ws.onerror = () => {};
            ws.onclose = (ev) => { clearInterval(watchdog); mux.destroy('tunnel connection lost'); console.warn(`[agent] tunnel #${n} closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''}) — reconnecting in ${backoff / 1000}s`); resolve(); };
        });
        await Bun.sleep(backoff); backoff = Math.min(backoff * 2, 15_000);   // stays under Midleman's 20 s grace for monitors
    }
}
if (TUNNEL_ALLOW === 'off') console.log('[agent] tunnels disabled (TUNNEL_ALLOW=off)');
else for (let n = 1; n <= TUNNEL_CONNS; n++) void tunnelLoop(n);

console.log(`[agent] ${NAME} → ${URL_BASE} every ${INTERVAL}s (pattern /${PATTERN.source}/i)`);
for (;;) {
    try { await tick(); } catch (e: any) { console.error(`[agent] ${e.message}`); } // never die on one bad cycle; Midleman alerts if we go silent
    await Bun.sleep(INTERVAL * 1000);
}
export { lastReport };
