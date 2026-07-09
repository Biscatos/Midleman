/**
 * GoContact Report Feed — types.
 *
 * A ReportFeed authenticates with a GoContact instance, triggers a report job,
 * polls for completion, parses the CSV response, applies a field projection,
 * caches the result, and exposes the data via a keyed HTTP endpoint.
 *
 * Audio files referenced in the report can be streamed through a separate
 * cookie-session proxy without buffering in Midleman.
 */

/**
 * All valid ownerType values accepted by GoContact's Report Designer API.
 * Source: POST_buildReport documentation (same values used in generateReport).
 */
export type GoContactOwnerType =
    | 'campaign'           // Outbound Voice
    | 'queue'              // Inbound Voice
    | 'ticket'             // Ticket Queues
    | 'ivr_campaigns'      // IVR Campaigns
    | 'assisted_transfer'  // Assisted Transfer
    | 'callbacks'          // Voice Callbacks
    | 'agents'             // Events Log
    | 'webchat'            // Webchat
    | 'webchat_sessions'   // Webchat Sessions
    | 'ticket_agent_times' // Ticket Agent Times
    | 'on_hook_attempt'    // On-Hook Attempts
    | 'quality'            // Quality
    | 'elearning'          // E-Learning
    | 'scripts';           // Scripts

/** Date range for the report job. */
export type DateRangeConfig =
    | { type: 'relative'; days: number }
    | { type: 'fixed'; startDate: string; endDate: string };

export interface ReportFeed {
    name: string;

    // ── GoContact instance ──────────────────────────────────────────────────
    baseUrl: string;     // e.g. "https://go.ucall.co.ao" (no trailing slash)
    username: string;
    password: string;    // stored as-is (same pattern as connector credentials)

    // ── Report job parameters ───────────────────────────────────────────────
    templateId: string;
    ownerType: GoContactOwnerType;
    ownerIds: string[];
    dataType?: number;           // default 0 — report type, varies per ownerType
    language?: string;           // default "en"
    includeAllOwners?: boolean;  // default false

    // ── Date range ──────────────────────────────────────────────────────────
    dateRange: DateRangeConfig;

    // ── Cache / refresh ─────────────────────────────────────────────────────
    /** Seconds to serve cached data before re-fetching. 0 = always fresh. */
    ttlSeconds: number;
    /** Seconds between automatic background refreshes. 0 = manual only. */
    autoRefreshInterval?: number;
    /** Max poll attempts waiting for the report job. Default 30 (~5 min at 10s). */
    maxPollAttempts?: number;

    // ── Consumer auth ───────────────────────────────────────────────────────
    /** API keys granted to consumers. Stored plaintext; generate with crypto. */
    apiKeys: string[];

    // ── Field projection ────────────────────────────────────────────────────
    /** Maps source CSV column name → output field name. */
    fieldMap?: Record<string, string>;
    /** When true, columns not present in fieldMap are also included (as-is). */
    includeUnmapped?: boolean;

    // ── Audio streaming ─────────────────────────────────────────────────────
    audio?: {
        enabled: boolean;
        /** CSV column that holds the relative audio path (e.g. "record_address"). */
        addressField: string;
    };
}

/** Runtime in-memory cache entry for one feed. */
export interface ReportCacheEntry {
    /** Projected rows (field map already applied). */
    rows: Record<string, string>[];
    /** Raw rows (before projection) — needed for audio path lookup. */
    rawRows: Record<string, string>[];
    /** Unix ms when this data was fetched. */
    fetchedAt: number;
    rowCount: number;
    /** The report job id that produced this data. */
    jobId?: string;
}
