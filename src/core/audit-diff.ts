// Before/after for the audit log: which fields of a config object an admin changed.
// Secrets are never written to the log — a changed secret is recorded as changed, without either value.

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|access[_-]?key|hash[_-]?key|private|credential|bearer|authorization|cookie/i;
// Secrets that travel inside a URL: user:password@host and ?token=… style parameters.
const URL_USERINFO = /(\/\/[^/@:\s]+):[^/@\s]+@/g;
const URL_SECRET_PARAM = /([?&][^=&#\s]*(?:token|key|secret|pass|sig|auth)[^=&#\s]*=)[^&#\s]*/gi;
const SECRET = '(secret)';
const MAX_VALUE_CHARS = 2000;

export type AuditChange = { from: unknown; to: unknown };

/** A copy safe to store: secrets masked, Sets as arrays, long strings cut. */
export function auditSnapshot(value: unknown, key = ''): unknown {
    if (value === undefined || value === null) return null;
    // `hasPassword: true` style flags are not secrets; only real values under a secret-looking key are.
    if (key && SECRET_KEY.test(key) && typeof value !== 'boolean') return value === '' ? '' : SECRET;
    if (value instanceof Set) return Array.from(value).sort();
    if (Array.isArray(value)) return value.map(v => auditSnapshot(v, key));
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (v !== undefined) out[k] = auditSnapshot(v, k);
        }
        return out;
    }
    if (typeof value === 'string') {
        const clean = value.replace(URL_USERINFO, '$1:' + SECRET + '@').replace(URL_SECRET_PARAM, '$1' + SECRET);
        return clean.length > MAX_VALUE_CHARS ? clean.slice(0, MAX_VALUE_CHARS) + '…' : clean;
    }
    return value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Top-level fields that differ between two versions of a config object, as { field: { from, to } }.
 * A field absent on one side shows as null. Returns undefined when nothing changed.
 */
export function auditChanges(before: unknown, after: unknown): Record<string, AuditChange> | undefined {
    const a = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
    const b = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
    const out: Record<string, AuditChange> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        // Compare the real values (so a rotated secret is noticed), store the masked ones.
        const rawA = a[k] instanceof Set ? Array.from(a[k] as Set<unknown>).sort() : a[k];
        const rawB = b[k] instanceof Set ? Array.from(b[k] as Set<unknown>).sort() : b[k];
        if (same(rawA ?? null, rawB ?? null)) continue;
        const from = auditSnapshot(a[k], k), to = auditSnapshot(b[k], k);
        // Both sides mask to the same text when only a secret inside changed: say so instead of "x → x".
        out[k] = same(from, to) ? { from: SECRET, to: '(secret changed)' } : { from, to };
    }
    return Object.keys(out).length ? out : undefined;
}
