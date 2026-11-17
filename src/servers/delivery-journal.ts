// Delivery journal: a crash-safe record of webhook payloads that were accepted
// (202) but whose fan-out has not finished yet.
//
// Opt-in with DELIVERY_ENGINE=journal; any other value keeps the legacy engine
// and this module does no I/O at all.
//
// How it stays fast: one sequential append (writeSync, no fsync) per accepted
// payload and one tiny "done" line per destination. Once writeSync returns the
// bytes belong to the OS page cache, so they survive a crash, kill -9 or OOM of
// this process (not a power loss of the host). Nothing is ever rewritten.
//
// Segments: the journal is split into files; a file whose every destination
// is done is deleted, so disk use stays at "what is in flight right now".
// On boot, replay() hands back every destination with no "done" line.

import { openSync, writeSync, closeSync, readdirSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface JournalRecord {
    /** Journal id — unique per accepted payload (requestId may come from the client). */
    id: string;
    webhook: string;
    requestId: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    /** base64 body, absent for GET/HEAD or an empty body. */
    body?: string;
    clientIp: string;
    at: number;
    /** Destination keys still to deliver. */
    keys: string[];
}

const SEGMENT_MAX_BYTES = 64 * 1024 * 1024;
const SEGMENT_MAX_AGE_MS = 5 * 60_000;

export const journalEnabled = (process.env.DELIVERY_ENGINE || '').trim().toLowerCase() === 'journal';

let dir = '';
let fd: number | null = null;
let current = '';
let currentBytes = 0;
let currentOpenedAt = 0;
/** segment file → pending "id\0key" entries written in it */
const pending = new Map<string, Set<string>>();
/** journal id → segment holding its accept line + destinations still open */
const segmentOf = new Map<string, { seg: string; left: number }>();
let seq = 0;

function dataDir(): string {
    return resolve(process.env.DATA_DIR || resolve(process.cwd(), 'data'), 'delivery-journal');
}

function openSegment(): void {
    current = `seg-${Date.now()}-${String(seq++).padStart(4, '0')}.jsonl`;
    fd = openSync(resolve(dir, current), 'a');
    currentBytes = 0;
    currentOpenedAt = Date.now();
    pending.set(current, new Set());
}

function append(line: string): void {
    if (fd === null) return;
    const buf = Buffer.from(line + '\n');
    writeSync(fd, buf);
    currentBytes += buf.length;
}

function dropIfDone(seg: string): void {
    const set = pending.get(seg);
    if (!set || set.size > 0 || seg === current) return;
    pending.delete(seg);
    try { unlinkSync(resolve(dir, seg)); } catch { /* already gone */ }
}

function maybeRotate(): void {
    if (currentBytes < SEGMENT_MAX_BYTES && Date.now() - currentOpenedAt < SEGMENT_MAX_AGE_MS) return;
    const old = current;
    if (fd !== null) closeSync(fd);
    openSegment();
    dropIfDone(old);
}

/** Record a payload before its fan-out starts. No-op when the journal is off. */
export function journalAccept(rec: JournalRecord): void {
    if (!journalEnabled || fd === null || rec.keys.length === 0) return;
    maybeRotate();
    append(JSON.stringify({ a: 1, ...rec }));
    const set = pending.get(current)!;
    for (const k of rec.keys) set.add(rec.id + '\u0000' + k);
    segmentOf.set(rec.id, { seg: current, left: rec.keys.length });
}

/** One destination of a payload reached a final state (delivered, skipped, or handed to a persisted queue). */
export function journalDone(id: string, key: string): void {
    if (!journalEnabled || fd === null) return;
    const ref = segmentOf.get(id);
    if (!ref) return;
    const set = pending.get(ref.seg);
    if (!set || !set.delete(id + '\u0000' + key)) return;
    append(JSON.stringify({ d: id, k: key }));
    if (--ref.left <= 0) segmentOf.delete(id);
    dropIfDone(ref.seg);
}

/**
 * Open the journal and return what was accepted but never finished. The
 * returned records are already re-written into the new segment, so the old
 * segment files are removed before this returns.
 */
export function journalOpen(): JournalRecord[] {
    if (!journalEnabled) return [];
    journalClose();
    pending.clear();
    segmentOf.clear();
    dir = dataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const old = readdirSync(dir).filter(f => /^seg-.*\.jsonl$/.test(f)).sort();
    const recs = new Map<string, JournalRecord>();
    for (const f of old) {
        let text = '';
        try { text = readFileSync(resolve(dir, f), 'utf-8'); } catch { continue; }
        for (const line of text.split('\n')) {
            if (!line) continue;
            let o: any;
            try { o = JSON.parse(line); } catch { continue; } // a torn last line from a crash
            if (o.a === 1 && o.id) { const { a, ...r } = o; recs.set(o.id, r as JournalRecord); }
            else if (o.d) { const r = recs.get(o.d); if (r) r.keys = r.keys.filter(k => k !== o.k); }
        }
    }
    openSegment();
    const left = [...recs.values()].filter(r => r.keys.length > 0);
    for (const r of left) journalAccept(r);
    for (const f of old) { try { unlinkSync(resolve(dir, f)); } catch { /* ignore */ } }
    return left;
}

export function journalClose(): void {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } fd = null; }
}

/** For tests and the dashboard: how many destinations are still in flight. */
export function journalPendingCount(): number {
    let n = 0;
    for (const s of pending.values()) n += s.size;
    return n;
}
