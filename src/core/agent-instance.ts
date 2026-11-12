// One agent process per server monitor. Two agents sharing a name and token (the install command pasted on a
// second server) would interleave their reports and share one tunnel pool, so a tunnel could reach the wrong host.
// Kept in memory: after a Midleman restart the first agent to arrive holds the monitor again.

const holders = new Map<string, { id: string; ip: string; at: number }>();
const refused = new Map<string, { ip: string; at: number }>();

/**
 * True when this agent process may act for the monitor, and records it as the holder.
 * It may when nobody holds the monitor, when it is the holder, when it comes from the holder's address
 * (a restart on the same machine gets a new id), or when the holder has been silent for `staleMs`.
 * Agents older than this check send no id: they all share '' and behave as before.
 */
export function claimAgent(monitor: string, id: string, ip: string, staleMs: number, now = Date.now()): boolean {
    const cur = holders.get(monitor);
    if (cur && cur.id !== id && cur.ip !== ip && now - cur.at <= staleMs) { refused.set(monitor, { ip, at: now }); return false; }
    holders.set(monitor, { id, ip, at: now });
    return true;
}

/** The second agent refused in the last 15 minutes, for the dashboard. */
export function agentConflict(monitor: string, now = Date.now()): { ip: string; at: number } | null {
    const r = refused.get(monitor);
    return r && now - r.at < 15 * 60_000 ? r : null;
}
