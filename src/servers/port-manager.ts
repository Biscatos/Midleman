import { resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PortMap {
    proxies: Record<string, number>;
    webhooks: Record<string, number>;
    tcpUdp: Record<string, number>;
}

// ─── State ───────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const PORTS_FILE = resolve(DATA_DIR, 'ports.json');
export const PORT_RANGE_START = parseInt(process.env.PORT_RANGE_START || '4000', 10);

let portMap: PortMap = { proxies: {}, webhooks: {}, tcpUdp: {} };

// ─── Persistence ─────────────────────────────────────────────────────────────

export function loadPortAssignments(): void {
    try {
        portMap = JSON.parse(readFileSync(PORTS_FILE, 'utf-8'));
        if (!portMap.webhooks) portMap.webhooks = {};
        if (!portMap.tcpUdp) portMap.tcpUdp = {};
        // Migrate old format: keys without colon → e.g. "meta" → discard (will be re-assigned)
        for (const key of Object.keys(portMap.tcpUdp)) {
            if (!key.includes(':')) {
                console.warn(`[port-manager] Migrating old tcpUdp port key "${key}" — will be reassigned`);
                delete portMap.tcpUdp[key];
            }
        }
    } catch {
        portMap = { proxies: {}, webhooks: {}, tcpUdp: {} };
    }
}

function save(): void {
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(PORTS_FILE, JSON.stringify(portMap, null, 2));
    } catch (err) {
        console.warn('⚠️  Could not save port assignments:', err instanceof Error ? err.message : err);
    }
}

// ─── Port probing ─────────────────────────────────────────────────────────────

async function isPortFree(port: number): Promise<boolean> {
    try {
        const server = Bun.serve({ port, fetch: () => new Response('') });
        server.stop();
        return true;
    } catch {
        return false;
    }
}

async function allocate(used: Set<number>, preferred?: number): Promise<number> {
    if (preferred && preferred > 0 && !used.has(preferred) && await isPortFree(preferred)) {
        return preferred;
    }
    let port = PORT_RANGE_START;
    while (port < 65535) {
        if (!used.has(port) && await isPortFree(port)) return port;
        port++;
    }
    throw new Error('No free ports available');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Assign ports for all proxy profiles and targets at startup.
 * Prefers previously saved ports; falls back to finding a free one.
 * Targets with an explicit port (> 0) always use that port.
 */
export async function assignAllPorts(
    proxyNames: string[],
    webhookNames: string[],
    tcpUdpNames: string[],
    adminPort: number,
): Promise<{ proxies: Record<string, number>; webhooks: Record<string, number>; tcpUdp: Record<string, number> }> {
    const used = new Set<number>([adminPort]);

    const proxies: Record<string, number> = {};
    for (const name of proxyNames) {
        const port = await allocate(used, portMap.proxies[name]);
        proxies[name] = port;
        used.add(port);
    }

    const webhookPorts: Record<string, number> = {};
    for (const name of webhookNames) {
        const port = await allocate(used, portMap.webhooks[name]);
        webhookPorts[name] = port;
        used.add(port);
    }

    const tcpUdpPorts: Record<string, number> = {};
    for (const name of tcpUdpNames) {
        const port = await allocate(used, portMap.tcpUdp[name]);
        tcpUdpPorts[name] = port;
        used.add(port);
    }

    portMap = { proxies, webhooks: webhookPorts, tcpUdp: tcpUdpPorts };
    save();
    return { proxies, webhooks: webhookPorts, tcpUdp: tcpUdpPorts };
}

/**
 * Assign a single new port for a proxy profile (e.g., added via admin API).
 */
export async function assignProxyPort(name: string, adminPort: number, excludePorts: number[]): Promise<number> {
    const proxiesWithoutSelf = Object.entries(portMap.proxies).filter(([k]) => k !== name).map(([_, v]) => v);
    const webhooks = Object.values(portMap.webhooks || {});
    
    const used = new Set<number>([adminPort, ...excludePorts, ...proxiesWithoutSelf, ...webhooks]);
    const port = await allocate(used, portMap.proxies[name]);
    portMap.proxies[name] = port;
    save();
    return port;
}



/**
 * Assign a single new port for a webhook distributor (e.g., added via admin API).
 */
export async function assignWebhookPort(name: string, configuredPort: number, adminPort: number, excludePorts: number[]): Promise<number> {
    if (!portMap.webhooks) portMap.webhooks = {};
    if (configuredPort > 0) {
        portMap.webhooks[name] = configuredPort;
        save();
        return configuredPort;
    }
    const proxies = Object.values(portMap.proxies);
    const webhooksWithoutSelf = Object.entries(portMap.webhooks).filter(([k]) => k !== name).map(([_, v]) => v);

    const used = new Set<number>([adminPort, ...excludePorts, ...proxies, ...webhooksWithoutSelf]);
    const port = await allocate(used, portMap.webhooks[name]);
    portMap.webhooks[name] = port;
    save();
    return port;
}

export function releaseProxyPort(name: string): void {
    delete portMap.proxies[name];
    save();
}



export function releaseWebhookPort(name: string): void {
    delete portMap.webhooks[name];
    save();
}

export function getProxyPort(name: string): number | undefined {
    return portMap.proxies[name];
}



export function getWebhookPort(name: string): number | undefined {
    return portMap.webhooks[name];
}

/**
 * Assign a port for a single TCP/UDP listener.
 * Key format: "${profileName}:${transport}" e.g. "meta:tls", "meta:udp".
 */
export async function assignTcpUdpListenerPort(listenerKey: string, adminPort: number, excludePorts: number[]): Promise<number> {
    if (!portMap.tcpUdp) portMap.tcpUdp = {};
    const otherPorts = Object.entries(portMap.tcpUdp).filter(([k]) => k !== listenerKey).map(([, v]) => v);
    const proxies = Object.values(portMap.proxies);
    const webhooks = Object.values(portMap.webhooks || {});
    const used = new Set<number>([adminPort, ...excludePorts, ...proxies, ...webhooks, ...otherPorts]);
    const port = await allocate(used, portMap.tcpUdp[listenerKey]);
    portMap.tcpUdp[listenerKey] = port;
    save();
    return port;
}

/** Release all listener ports for a profile (removes all "profileName:*" keys). */
export function releaseTcpUdpListenerPorts(profileName: string): void {
    const prefix = `${profileName}:`;
    for (const key of Object.keys(portMap.tcpUdp)) {
        if (key.startsWith(prefix)) delete portMap.tcpUdp[key];
    }
    save();
}

export function getTcpUdpListenerPort(profileName: string, transport: string): number | undefined {
    return portMap.tcpUdp?.[`${profileName}:${transport}`];
}

// Legacy aliases (kept for backwards compat, prefer the Listener variants)
export async function assignTcpUdpPort(name: string, adminPort: number, excludePorts: number[]): Promise<number> {
    return assignTcpUdpListenerPort(`${name}:tcp`, adminPort, excludePorts);
}
export function releaseTcpUdpPort(name: string): void {
    releaseTcpUdpListenerPorts(name);
}
export function getTcpUdpPort(name: string): number | undefined {
    return getTcpUdpListenerPort(name, 'tcp');
}

export function getAllAssignedPorts(): PortMap {
    return { ...portMap };
}
