import { resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PortMap {
    proxies: Record<string, number>;
    targets: Record<string, number>;
    webhooks: Record<string, number>;
}

// ─── State ───────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const PORTS_FILE = resolve(DATA_DIR, 'ports.json');
export const PORT_RANGE_START = parseInt(process.env.PORT_RANGE_START || '4000', 10);

let portMap: PortMap = { proxies: {}, targets: {}, webhooks: {} };

// ─── Persistence ─────────────────────────────────────────────────────────────

export function loadPortAssignments(): void {
    try {
        portMap = JSON.parse(readFileSync(PORTS_FILE, 'utf-8'));
        if (!portMap.webhooks) portMap.webhooks = {};
    } catch {
        portMap = { proxies: {}, targets: {}, webhooks: {} };
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
    targets: { name: string; configuredPort: number }[],
    webhookNames: string[],
    adminPort: number,
): Promise<{ proxies: Record<string, number>; targets: Record<string, number>; webhooks: Record<string, number> }> {
    const used = new Set<number>([adminPort]);

    // Reserve all explicitly configured target ports first
    for (const t of targets) {
        if (t.configuredPort > 0) used.add(t.configuredPort);
    }

    const proxies: Record<string, number> = {};
    for (const name of proxyNames) {
        const port = await allocate(used, portMap.proxies[name]);
        proxies[name] = port;
        used.add(port);
    }

    const targetPorts: Record<string, number> = {};
    for (const t of targets) {
        const port = t.configuredPort > 0
            ? t.configuredPort
            : await allocate(used, portMap.targets[t.name]);
        targetPorts[t.name] = port;
        used.add(port);
    }

    const webhookPorts: Record<string, number> = {};
    for (const name of webhookNames) {
        const port = await allocate(used, portMap.webhooks[name]);
        webhookPorts[name] = port;
        used.add(port);
    }

    portMap = { proxies, targets: targetPorts, webhooks: webhookPorts };
    save();
    return { proxies, targets: targetPorts, webhooks: webhookPorts };
}

/**
 * Assign a single new port for a proxy profile (e.g., added via admin API).
 */
export async function assignProxyPort(name: string, adminPort: number, excludePorts: number[]): Promise<number> {
    const proxiesWithoutSelf = Object.entries(portMap.proxies).filter(([k]) => k !== name).map(([_, v]) => v);
    const targets = Object.values(portMap.targets);
    const webhooks = Object.values(portMap.webhooks || {});
    
    const used = new Set<number>([adminPort, ...excludePorts, ...proxiesWithoutSelf, ...targets, ...webhooks]);
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
    const targets = Object.values(portMap.targets);
    const webhooksWithoutSelf = Object.entries(portMap.webhooks).filter(([k]) => k !== name).map(([_, v]) => v);

    const used = new Set<number>([adminPort, ...excludePorts, ...proxies, ...targets, ...webhooksWithoutSelf]);
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

export function getAllAssignedPorts(): PortMap {
    return { ...portMap };
}
