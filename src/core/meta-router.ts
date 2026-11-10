// Meta Cloud API (WhatsApp) routing for webhook fan-out.
//
// A Tech-Provider style app receives ONE callback for every WABA / phone number.
// One POST may batch several `entry[].changes[]` from different numbers, so a
// plain forward would hand customer A the messages of customer B. This module:
//   • verifies X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the App Secret)
//   • splits the batch into (entry, change) units and classifies each event
//   • for every destination, keeps only the units whose phone number / WABA and
//     event kind it subscribes to, and rebuilds a valid Meta payload with them
//   • deduplicates message / status ids (Meta re-sends when it gets no 200 in time)
//   • remembers the phone numbers seen, so the dashboard can offer them.

import { createHmac, timingSafeEqual } from 'crypto';
import type { WebhookDestination, WebhookDistributor } from './types';

export type MetaEventKind = 'messages' | 'statuses' | 'templates' | 'account' | 'other';
export const META_EVENT_KINDS: { id: MetaEventKind; label: string; hint: string }[] = [
    { id: 'messages', label: 'Incoming messages', hint: 'text, media, interactive replies, reactions' },
    { id: 'statuses', label: 'Delivery statuses', hint: 'sent · delivered · read · failed' },
    { id: 'templates', label: 'Templates', hint: 'template approved / rejected / paused, category changes' },
    { id: 'account', label: 'Account & number', hint: 'account_update, phone_number_quality_update, account_alerts' },
    { id: 'other', label: 'Everything else', hint: 'any field not listed above' },
];

interface Unit { wabaId: string; field: string; kind: MetaEventKind; phoneNumberId: string | null; displayPhone: string | null; change: any; ids: string[] }

function kindOf(field: string, value: any): MetaEventKind {
    if (field === 'messages') return Array.isArray(value?.statuses) && !Array.isArray(value?.messages) ? 'statuses' : 'messages';
    if (/template/i.test(field)) return 'templates';
    if (/^(account_|phone_number_|business_capability|security)/.test(field)) return 'account';
    return 'other';
}

/** Break a Meta webhook body into routable units. Returns null when it is not a Meta payload. */
export function splitMetaPayload(body: any): Unit[] | null {
    if (!body || typeof body !== 'object' || !Array.isArray(body.entry)) return null;
    const units: Unit[] = [];
    for (const entry of body.entry) {
        const wabaId = String(entry?.id ?? '');
        for (const change of entry?.changes || []) {
            const field = String(change?.field ?? ''), value = change?.value ?? {};
            const md = value?.metadata || {};
            const ids = [...(value?.messages || []).map((m: any) => m?.id), ...(value?.statuses || []).map((s: any) => s?.id)].filter((x): x is string => typeof x === 'string');
            units.push({ wabaId, field, kind: kindOf(field, value), phoneNumberId: md.phone_number_id ? String(md.phone_number_id) : null, displayPhone: md.display_phone_number ? String(md.display_phone_number) : null, change, ids });
        }
    }
    return units;
}

/** Does this destination subscribe to the unit? Numbers: phone_number_id or WABA id; empty list = catch-all. */
export function destinationWants(d: WebhookDestination, u: Unit): boolean {
    const r = d.metaRoute;
    if (!r) return true;
    if (r.events?.length && !r.events.includes(u.kind)) return false;
    if (r.numbers?.length) {
        const wanted = r.numbers.map(String);
        if (!(u.phoneNumberId && wanted.includes(u.phoneNumberId)) && !(u.displayPhone && wanted.includes(u.displayPhone)) && !wanted.includes(u.wabaId)) return false;
    } else if (r.catchAll !== true) {
        return false; // no numbers and not the catch-all → gets nothing (misconfigured destination, stays quiet rather than leaking)
    }
    return true;
}

/** Rebuild a payload in Meta's shape with only the given units. */
export function buildMetaPayload(original: any, units: Unit[]): any {
    const byWaba = new Map<string, any[]>();
    for (const u of units) { if (!byWaba.has(u.wabaId)) byWaba.set(u.wabaId, []); byWaba.get(u.wabaId)!.push(u.change); }
    return { object: original.object ?? 'whatsapp_business_account', entry: [...byWaba].map(([id, changes]) => ({ id, changes })) };
}

export function verifyMetaSignature(appSecret: string, rawBody: ArrayBuffer | Uint8Array, header: string | null): boolean {
    if (!header || !header.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', appSecret).update(Buffer.from(rawBody as any)).digest('hex');
    const got = header.slice(7).trim().toLowerCase();
    if (got.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

// ─── Dedupe (24 h) and "numbers seen" registry, per webhook ─────────────────
const DEDUPE_MS = 24 * 60 * 60_000;
const seenIds = new Map<string, Map<string, number>>();      // webhook → id → firstSeen
const seenNumbers = new Map<string, Map<string, { phoneNumberId: string; displayPhone: string | null; wabaId: string; lastAt: number; count: number; kinds: Record<string, number> }>>();

/** Returns the units whose message/status ids were not delivered before (and records them). Units without ids always pass. */
export function dedupe(webhook: string, units: Unit[]): Unit[] {
    const now = Date.now();
    let m = seenIds.get(webhook); if (!m) { m = new Map(); seenIds.set(webhook, m); }
    if (m.size > 50_000) for (const [k, t] of m) if (now - t > DEDUPE_MS) m.delete(k);
    return units.filter(u => {
        if (!u.ids.length) return true;
        const fresh = u.ids.filter(id => { const t = m!.get(id); return !t || now - t > DEDUPE_MS; });
        if (!fresh.length) return false;
        for (const id of fresh) m!.set(id, now);
        if (fresh.length < u.ids.length) { // partial replay: drop the already-delivered items from the change
            const v = u.change.value || {};
            if (Array.isArray(v.messages)) v.messages = v.messages.filter((x: any) => fresh.includes(x?.id));
            if (Array.isArray(v.statuses)) v.statuses = v.statuses.filter((x: any) => fresh.includes(x?.id));
        }
        return true;
    });
}

export function noteNumbers(webhook: string, units: Unit[]): void {
    let m = seenNumbers.get(webhook); if (!m) { m = new Map(); seenNumbers.set(webhook, m); }
    for (const u of units) {
        const key = u.phoneNumberId || `waba:${u.wabaId}`;
        const e = m.get(key) || { phoneNumberId: u.phoneNumberId || '', displayPhone: null, wabaId: u.wabaId, lastAt: 0, count: 0, kinds: {} };
        e.lastAt = Date.now(); e.count++; e.kinds[u.kind] = (e.kinds[u.kind] || 0) + 1;
        if (u.displayPhone) e.displayPhone = u.displayPhone;
        m.set(key, e);
    }
}
export function numbersSeen(webhook: string) {
    return [...(seenNumbers.get(webhook)?.values() || [])].sort((a, b) => b.lastAt - a.lastAt);
}
/** Load / dump the registry so it survives restarts (kept small: numbers, not messages). */
export function exportNumbersSeen(): Record<string, any[]> { return Object.fromEntries([...seenNumbers].map(([w, m]) => [w, [...m.values()]])); }
export function importNumbersSeen(data: Record<string, any[]> | null | undefined): void {
    if (!data) return;
    for (const [w, arr] of Object.entries(data)) seenNumbers.set(w, new Map((arr || []).map((e: any) => [e.phoneNumberId || `waba:${e.wabaId}`, e])));
}

export function metaEnabled(w: WebhookDistributor): boolean { return !!w.meta?.enabled; }
