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

/** Comparison operators available for consumer-side filtering. */
export type FieldFilterOperator =
    | 'equals' | 'notEquals'
    | 'contains' | 'startsWith'
    | 'gt' | 'gte' | 'lt' | 'lte';

/** Per-field filter configuration stored in feed config. */
export interface FieldFilterConfig {
    /** Auto-detected or manually overridden field type. */
    type: 'string' | 'number' | 'date' | 'boolean';
    /**
     * Operators enabled for this field. When omitted, defaults are used per type:
     * - string: equals, contains, startsWith
     * - number: equals, gte, lte, gt, lt
     * - date:   gte, lte
     * - boolean: equals
     */
    operators?: FieldFilterOperator[];
}

export interface ReportFeed {
    name: string;

    // ── Namespace routing (optional) ────────────────────────────────────────────
    /**
     * Group namespace. When set, this feed is also accessible at
     * /reports/:group/:slug (in addition to /reports/:name).
     * Multiple feeds with the same group share one API doc scoped to the group.
     */
    group?: string;
    /**
     * Endpoint slug within the group (e.g. "voice", "webchat", "ticket").
     * Required when group is set. Used as the last path segment in group routes.
     */
    slug?: string;

    // ── GoContact credentials ───────────────────────────────────────────────
    /**
     * Reference a named GoContact instance (see src/gocontact/instances.ts).
     * When set, baseUrl/username/password are resolved from the instance at
     * fetch time — credentials only need to be updated in one place.
     * Either instanceName OR all three of baseUrl/username/password required.
     */
    instanceName?: string;
    baseUrl?: string;    // e.g. "https://go.ucall.co.ao" (no trailing slash)
    username?: string;
    password?: string;   // stored as-is (same pattern as connector credentials)

    // ── Report job parameters ───────────────────────────────────────────────
    templateId: string;
    ownerType: GoContactOwnerType;
    ownerIds: string[];
    dataType?: number | string;  // int for voice (0), string for webchat ("sessions")
    language?: string;           // default "en"
    includeAllOwners?: boolean;  // default false

    // ── Date range ──────────────────────────────────────────────────────────
    dateRange: DateRangeConfig;

    // ── Cache / refresh ─────────────────────────────────────────────────────
    /** @deprecated No longer used — API reads from SQLite, refreshes are explicit. Kept for backward compat. */
    ttlSeconds?: number;
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
    /**
     * Per-field filter configuration. Key = output field name (after projection).
     * Defines the detected type and enabled filter operators for consumer queries.
     * Query syntax: ?field=value (equals), ?field__gte=value (explicit operator).
     */
    fieldFilters?: Record<string, FieldFilterConfig>;

    // ── Detail route ────────────────────────────────────────────────────────
    /** Enable GET /reports/:name/:id — filters rows by idField === id */
    detail?: {
        /** CSV column used as the row identifier (e.g. "ChatId", "CallUUID"). */
        idField: string;
        /**
         * Optional: name of another feed whose cached data is searched instead
         * of this feed's own rows. Useful for webchat: sessions feed points to
         * the messages feed, so /:chatId returns the full conversation history.
         */
        sourceFeed?: string;
        /**
         * Projected field name in the sourceFeed to match against the :id param.
         * Defaults to detail.idField (resolved through srcFeed.fieldMap) when omitted.
         * Set this when the source feed uses a different field name for the same concept.
         */
        sourceIdField?: string;
        /**
         * When true (and sourceFeed is set), the matching row from THIS feed is
         * also included in the response as `summary`. Use on the sessions feed so
         * a single /:chatId call returns both the session metadata and all messages.
         */
        mergeParent?: boolean;
    };

    // ── Audio streaming ─────────────────────────────────────────────────────
    audio?: {
        enabled: boolean;
        /**
         * CSV column that holds the relative audio path (e.g. "CallRecordAddress").
         * The path is looked up from cached rows by idField — never accepted
         * directly from the client to prevent open-proxy abuse.
         */
        addressField: string;
        /** CSV column used to look up the row (e.g. "CallUUID"). Defaults to detail.idField. */
        idField?: string;
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
