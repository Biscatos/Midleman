/**
 * Tiny level-gated logger. Keeps the container quiet in production without
 * losing error/warn signal.
 *
 *   LOG_LEVEL=error  → only log.error
 *   LOG_LEVEL=warn   → warn + error
 *   LOG_LEVEL=info   → info + warn + error   (default)
 *   LOG_LEVEL=debug  → everything
 *
 * Existing bare console.* calls elsewhere are unaffected; modules opt in by
 * importing this. Errors/warns always go through console.error/warn so they
 * survive any future stdout/stderr split.
 */

type Level = 'error' | 'warn' | 'info' | 'debug';
const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel(): Level {
    const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
    return (raw in RANK ? raw : 'info') as Level;
}

// Resolved once at startup; LOG_LEVEL isn't expected to change at runtime.
const threshold = RANK[currentLevel()];

export const log = {
    error: (...args: unknown[]) => { if (threshold >= RANK.error) console.error(...args); },
    warn: (...args: unknown[]) => { if (threshold >= RANK.warn) console.warn(...args); },
    info: (...args: unknown[]) => { if (threshold >= RANK.info) console.log(...args); },
    debug: (...args: unknown[]) => { if (threshold >= RANK.debug) console.log(...args); },
};
