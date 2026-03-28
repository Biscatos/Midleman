import type { ProxyProfile } from '../core/types';
import { handleDirectProxy } from '../proxy/proxy';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProxyServerInstance {
    profile: ProxyProfile;
    server: ReturnType<typeof Bun.serve>;
    port: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

const servers = new Map<string, ProxyServerInstance>();

// ─── Server lifecycle ─────────────────────────────────────────────────────────

export function startProxyServer(profile: ProxyProfile, port: number): ProxyServerInstance {
    const server = Bun.serve({
        port,
        idleTimeout: 255,
        async fetch(req: Request): Promise<Response> {
            const startTime = performance.now();
            return handleDirectProxy(req, profile, startTime);
        },
        error(err: Error) {
            console.error(`[proxy:${profile.name}] server error:`, err);
            return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    });

    const instance: ProxyServerInstance = { profile, server, port: server.port ?? port };
    servers.set(profile.name, instance);
    console.log(`🌐 Proxy "${profile.name}" on :${server.port} → ${profile.targetUrl}`);
    return instance;
}

export async function stopProxyServer(name: string): Promise<void> {
    const ps = servers.get(name);
    if (!ps) return;
    ps.server.stop();
    servers.delete(name);
    console.log(`🛑 Proxy "${name}" stopped`);
}

export async function stopAllProxyServers(): Promise<void> {
    for (const name of [...servers.keys()]) {
        await stopProxyServer(name);
    }
}

export async function restartProxyServer(name: string, newProfile?: ProxyProfile, newPort?: number): Promise<ProxyServerInstance | null> {
    const existing = servers.get(name);
    if (!existing) return null;
    const port = newPort ?? existing.port;
    const profile = newProfile || existing.profile;
    await stopProxyServer(name);
    return startProxyServer(profile, port);
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function getProxyServerStatus(): { name: string; port: number; targetUrl: string; running: boolean }[] {
    return Array.from(servers.values()).map(ps => ({
        name: ps.profile.name,
        port: ps.port,
        targetUrl: ps.profile.targetUrl,
        running: true,
    }));
}

export function getProxyServerPort(name: string): number | undefined {
    return servers.get(name)?.port;
}

export function isProxyServerRunning(name: string): boolean {
    return servers.has(name);
}
