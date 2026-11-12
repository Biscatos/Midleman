import { expect, test } from 'bun:test';
import { agentConflict, claimAgent } from './agent-instance';

const STALE = 180_000;

test('a second agent from another address is refused while the first is alive', () => {
    expect(claimAgent('m1', 'a', '1.1.1.1', STALE, 0)).toBe(true);
    expect(claimAgent('m1', 'a', '1.1.1.1', STALE, 30_000)).toBe(true);      // same process keeps reporting
    expect(claimAgent('m1', 'b', '2.2.2.2', STALE, 40_000)).toBe(false);
    expect(agentConflict('m1', 41_000)).toEqual({ ip: '2.2.2.2', at: 40_000 });
    expect(claimAgent('m1', 'a', '1.1.1.1', STALE, 60_000)).toBe(true);      // the refusal did not displace the holder
    expect(agentConflict('m1', 40_000 + 16 * 60_000)).toBe(null);
});

test('a restart on the same machine and a takeover after silence are allowed', () => {
    expect(claimAgent('m2', 'a', '1.1.1.1', STALE, 0)).toBe(true);
    expect(claimAgent('m2', 'b', '1.1.1.1', STALE, 5_000)).toBe(true);       // new id, same address
    expect(claimAgent('m2', 'c', '3.3.3.3', STALE, 5_000 + STALE + 1)).toBe(true);
    expect(claimAgent('m2', 'b', '1.1.1.1', STALE, 5_000 + STALE + 2)).toBe(false);
});

test('agents without an id behave as before', () => {
    expect(claimAgent('m3', '', '1.1.1.1', STALE, 0)).toBe(true);
    expect(claimAgent('m3', '', '2.2.2.2', STALE, 1_000)).toBe(true);
});
