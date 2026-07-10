/**
 * GoContact named instances — shared credential presets.
 *
 * A GoContact instance stores the base URL + credentials for one GoContact
 * deployment. Report feeds (and optionally connectors) reference an instance
 * by name so credentials only need to be updated in one place.
 *
 * Storage: data/gocontact-instances.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const FILE = resolve(DATA_DIR, 'gocontact-instances.json');

export interface GoContactInstance {
    /** Unique slug, e.g. "ucall-prod". Used as a foreign key in report feeds. */
    name: string;
    /** Human-readable label shown in the UI. */
    label?: string;
    baseUrl: string;
    username: string;
    password: string;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

let _instances: GoContactInstance[] = [];

export function loadInstances(): GoContactInstance[] {
    try {
        if (!existsSync(FILE)) return [];
        _instances = JSON.parse(readFileSync(FILE, 'utf-8')) as GoContactInstance[];
        return _instances;
    } catch {
        return [];
    }
}

export function saveInstances(list: GoContactInstance[]): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf-8');
    _instances = list;
}

export function getInstances(): GoContactInstance[] {
    return _instances;
}

export function findInstance(name: string): GoContactInstance | undefined {
    return _instances.find(i => i.name === name);
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateInstanceInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return 'Request body must be a JSON object';
    const f = input as Record<string, unknown>;

    if (!f.name || typeof f.name !== 'string') return '"name" is required';
    if (!/^[a-z0-9_-]+$/.test(f.name)) return '"name" must only contain lowercase letters, numbers, hyphens and underscores';
    if (f.name.length < 2 || f.name.length > 48) return '"name" must be 2–48 characters';

    if (f.label !== undefined && typeof f.label !== 'string') return '"label" must be a string';

    if (!f.baseUrl || typeof f.baseUrl !== 'string') return '"baseUrl" is required';
    try { new URL(f.baseUrl as string); } catch { return '"baseUrl" must be a valid URL'; }

    if (!f.username || typeof f.username !== 'string') return '"username" is required';
    if (!f.password || typeof f.password !== 'string') return '"password" is required';

    return null;
}
