/**
 * Business-hours ("horário de atendimento") evaluation for connectors.
 *
 * A connector can declare a weekly recurring schedule of OPEN hours. When a
 * customer message arrives OUTSIDE those hours, the connector sends a single
 * configured out-of-hours reply (see connector-server deliverInbound).
 *
 * Design notes:
 *  - The schedule is evaluated against the wall clock in a fixed IANA timezone
 *    (default Africa/Luanda — UTC+1, no DST). We read the *instant* via
 *    Date.now()/the passed Date and convert with Intl, never via the server's
 *    local getHours(): a drifted server clock at a minute boundary is noise at
 *    this granularity, and the timezone of the host is irrelevant.
 *  - A day with no ranges = closed all day. An empty/absent weekly schedule =
 *    closed always; validateConnectorInput forbids enabling the feature with no
 *    open ranges so this can never silently black-hole a connector.
 *  - Overnight ranges (e.g. 20:00–04:00) are NOT supported in v1: each range
 *    must have start < end. Daytime call-center hours only for now.
 */

export interface TimeRange {
  /** "HH:MM" (24h, local to the schedule timezone). */
  start: string;
  end: string;
}

export interface DaySchedule {
  /** Day of week, 0 = Sunday … 6 = Saturday (matches Date.getUTCDay()). */
  day: number;
  ranges: TimeRange[];
}

export const DEFAULT_BUSINESS_TZ = 'Africa/Luanda';

/** Parse "HH:MM" → minutes since midnight, or null if malformed/out of range. */
export function parseTimeToMinutes(t: unknown): number | null {
  if (typeof t !== 'string') return null;
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** True if `tz` is a timezone Intl can resolve. */
export function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** The wall clock (day-of-week + minutes since midnight) at `now` in `tz`. */
export function wallClockInTz(now: Date, tz: string): { dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  let hh = 0, mm = 0, wd = 'Sun';
  for (const p of parts) {
    if (p.type === 'hour') hh = Number(p.value);
    else if (p.type === 'minute') mm = Number(p.value);
    else if (p.type === 'weekday') wd = p.value;
  }
  return { dow: WEEKDAY_INDEX[wd] ?? 0, minutes: hh * 60 + mm };
}

/** Is `now` within the connector's open hours? Closed (false) when there is no
 *  schedule or the current time falls in no open range for the current day. */
export function isWithinBusinessHours(
  weekly: DaySchedule[] | undefined,
  timezone: string | undefined,
  now: Date,
): boolean {
  if (!weekly || weekly.length === 0) return false;
  const tz = isValidTimeZone(timezone) ? (timezone as string) : DEFAULT_BUSINESS_TZ;
  const { dow, minutes } = wallClockInTz(now, tz);
  const day = weekly.find(d => d.day === dow);
  if (!day || !day.ranges || day.ranges.length === 0) return false;
  return day.ranges.some(r => {
    const s = parseTimeToMinutes(r.start);
    const e = parseTimeToMinutes(r.end);
    if (s == null || e == null) return false;
    // [start, end): open at start, closed exactly at end.
    return minutes >= s && minutes < e;
  });
}

/**
 * Validate a weekly schedule (the structured shape that is persisted). Returns
 * `{ error }` on the first problem, or `{ open }` with the total number of open
 * ranges across the week. Used by both API validation and the save handler.
 */
export function validateWeekly(weekly: unknown): { error: string } | { open: number } {
  if (weekly === undefined || weekly === null) return { open: 0 };
  if (!Array.isArray(weekly)) return { error: '"weekly" must be an array of { day, ranges }' };
  let open = 0;
  const seenDays = new Set<number>();
  for (const d of weekly) {
    if (!d || typeof d !== 'object') return { error: 'each "weekly" entry must be an object' };
    const day = (d as Record<string, unknown>).day;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
      return { error: '"weekly[].day" must be an integer 0–6 (0 = Sunday)' };
    }
    if (seenDays.has(day)) return { error: `duplicate "weekly" entry for day ${day}` };
    seenDays.add(day);
    const ranges = (d as Record<string, unknown>).ranges;
    if (!Array.isArray(ranges)) return { error: `"weekly" day ${day}: ranges must be an array` };
    const mins: Array<[number, number]> = [];
    for (const r of ranges) {
      if (!r || typeof r !== 'object') return { error: `"weekly" day ${day}: invalid range entry` };
      const s = parseTimeToMinutes((r as Record<string, unknown>).start);
      const e = parseTimeToMinutes((r as Record<string, unknown>).end);
      if (s == null || e == null) return { error: `"weekly" day ${day}: times must be HH:MM (00:00–23:59)` };
      if (s >= e) return { error: `"weekly" day ${day}: range start must be before end (overnight ranges are not supported)` };
      mins.push([s, e]);
      open++;
    }
    mins.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < mins.length; i++) {
      if (mins[i][0] < mins[i - 1][1]) return { error: `"weekly" day ${day}: overlapping time ranges` };
    }
  }
  return { open };
}
