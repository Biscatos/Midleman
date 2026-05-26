// Notification dispatcher: routes domain events to subscribed groups via
// email and/or SMS. Loosely coupled to the rest of the codebase — callers
// invoke `emitNotificationEvent(category, severity, payload)` and the
// dispatcher handles rule evaluation, channel selection, per-recipient
// delivery and audit logging.
//
// Channel-by-severity default (override at the rule level):
//   info     → email
//   warning  → email
//   critical → email + sms
//
// Per-recipient try/catch isolation: one bad email/phone does NOT abort the
// fan-out. Each outcome is logged independently in email_send_log /
// sms_send_log with a shared notification_id.

import {
    listNotificationRules,
    getNotificationGroup,
    createNotificationLogEntry,
    logEmailSend,
    setNotificationCacheInvalidator,
    type NotificationSeverity,
    type NotificationChannel,
    type NotificationRule,
    type ResolvedRecipient,
} from '../auth/auth';
import { sendMail, isSmtpConfigured } from './smtp';
import { sendSms, isSmsConfigured } from './sms';
import { logSmsSend } from '../auth/auth';

const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, warning: 1, critical: 2 };

function defaultChannelsFor(severity: NotificationSeverity): NotificationChannel[] {
    return severity === 'critical' ? ['email', 'sms'] : ['email'];
}

function categoryMatches(pattern: string, category: string): boolean {
    const p = pattern.trim();
    if (!p || p === '*') return true;
    if (p === category) return true;
    if (p.endsWith('.*')) {
        const prefix = p.slice(0, -2);
        return category === prefix || category.startsWith(prefix + '.');
    }
    return false;
}

function severityMeets(rule: NotificationRule, severity: NotificationSeverity): boolean {
    return SEVERITY_RANK[severity] >= SEVERITY_RANK[rule.minSeverity];
}

// ─── Hot-path cache ─────────────────────────────────────────────────────────
// Avoids hitting SQLite on every emit. Invalidated when any rule/group CRUD
// mutates the underlying tables (auth.ts calls _invalidate via setNotificationCacheInvalidator).

let _rulesCache: NotificationRule[] | null = null;
function _invalidate(): void { _rulesCache = null; }
setNotificationCacheInvalidator(_invalidate);

function rules(): NotificationRule[] {
    if (_rulesCache === null) _rulesCache = listNotificationRules().filter(r => r.enabled);
    return _rulesCache;
}

/** Cheap negative lookup used by hot-path emitters before they even build a
 *  payload. Returns false when no enabled rule could ever match. */
export function hasAnyRuleMatching(category: string, severity: NotificationSeverity): boolean {
    for (const r of rules()) {
        if (categoryMatches(r.categoryPattern, category) && severityMeets(r, severity)) return true;
    }
    return false;
}

// ─── Public emit API ────────────────────────────────────────────────────────

export interface NotificationEvent {
    category: string;
    severity: NotificationSeverity;
    subject: string;
    /** Plain-text body. Email gets a <pre> wrap; SMS is truncated to 160 chars. */
    body: string;
    /** Optional structured payload for the audit log. */
    payload?: Record<string, unknown>;
    /** Mark as a test send (does not affect delivery, only the audit row). */
    isTest?: boolean;
}

export interface NotificationDispatchResult {
    notificationId: number;
    matchedRuleId: number | null;
    matchedGroupId: number | null;
    recipientsTotal: number;
    recipientsOk: number;
    recipientsFailed: number;
    /** Per-recipient diagnostics. Useful for "Send test" UIs. */
    attempts: Array<{
        memberId: number;
        proxyUserId: number | null;
        channel: NotificationChannel;
        target: string;
        ok: boolean;
        error?: string;
    }>;
}

/** Fire a notification event. Picks the first matching enabled rule (sorted by
 *  priority asc, then id asc), dispatches to that rule's group, and logs the
 *  outcome. Returns null if no rule matched (event silently dropped). */
export async function emitNotificationEvent(evt: NotificationEvent): Promise<NotificationDispatchResult | null> {
    const matched = rules().find(r => categoryMatches(r.categoryPattern, evt.category) && severityMeets(r, evt.severity));
    if (!matched) return null;
    return dispatchToGroup(evt, matched);
}

/** Explicit dispatch to a specific group (e.g. for "Send test" buttons). */
export async function dispatchTestToGroup(groupId: number, severity: NotificationSeverity = 'info'): Promise<NotificationDispatchResult | null> {
    const fakeRule: NotificationRule = {
        id: 0,
        name: 'manual_test',
        categoryPattern: 'test',
        minSeverity: severity,
        groupId,
        channelsOverride: ['email', 'sms'],
        priority: 0,
        enabled: true,
        createdAt: '',
    };
    return dispatchToGroup({
        category: 'test',
        severity,
        subject: 'TEST: Midleman notification',
        body: 'TEST: this is a test notification triggered from the dashboard. No action required.',
        isTest: true,
    }, fakeRule);
}

async function dispatchToGroup(evt: NotificationEvent, rule: NotificationRule): Promise<NotificationDispatchResult | null> {
    const group = getNotificationGroup(rule.groupId);
    if (!group) return null;
    const channels = rule.channelsOverride && rule.channelsOverride.length
        ? rule.channelsOverride
        : defaultChannelsFor(evt.severity);
    const wantEmail = channels.includes('email');
    const wantSms = channels.includes('sms');
    const recipients = group.resolved;

    // Pre-create log row so per-recipient logs can reference it. We patch
    // counts at the end with a follow-up UPDATE — keeps the foreign key
    // available even if the process crashes mid-send.
    const notificationId = createNotificationLogEntry({
        category: evt.category,
        severity: evt.severity,
        subject: evt.subject,
        body: evt.body,
        payloadJson: evt.payload ? JSON.stringify(evt.payload) : null,
        matchedRuleId: rule.id || null,
        matchedGroupId: group.id,
        recipientsTotal: recipients.length,
        recipientsOk: 0,
        recipientsFailed: 0,
        isTest: !!evt.isTest,
    });

    const attempts: NotificationDispatchResult['attempts'] = [];
    let ok = 0;
    let failed = 0;

    const subjectPrefix = evt.isTest ? '[TEST] ' : evt.severity === 'critical' ? '[CRITICAL] ' : '';
    const fullSubject = subjectPrefix + evt.subject;
    const bodyHtml = `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px">${escapeHtml(evt.body)}</pre>`;

    for (const r of recipients) {
        if (wantEmail && r.email) {
            const outcome = await tryEmail(r, fullSubject, evt.body, bodyHtml);
            attempts.push({ memberId: r.memberId, proxyUserId: r.proxyUserId, channel: 'email', target: r.email, ok: outcome.ok, error: outcome.error });
            logEmailSend({
                notificationId,
                userId: r.proxyUserId,
                toAddress: r.email,
                subject: fullSubject,
                success: outcome.ok,
                error: outcome.error || null,
                purpose: evt.category,
            });
            if (outcome.ok) ok++; else failed++;
        }
        if (wantSms && r.phone) {
            const outcome = await trySms(r, evt.body);
            attempts.push({ memberId: r.memberId, proxyUserId: r.proxyUserId, channel: 'sms', target: r.phone, ok: outcome.ok, error: outcome.error });
            if (outcome.attempts) {
                for (const a of outcome.attempts) {
                    logSmsSend({
                        userId: r.proxyUserId,
                        toNumber: r.phone,
                        provider: a.provider,
                        success: a.ok,
                        error: a.error || null,
                        purpose: evt.category,
                    });
                }
            }
            if (outcome.ok) ok++; else failed++;
        }
    }

    // Patch the master row with final counts.
    try {
        // Lazy import to avoid circular dependency at module load.
        const { updateNotificationLogCounts } = await import('../auth/auth') as any;
        if (typeof updateNotificationLogCounts === 'function') {
            updateNotificationLogCounts(notificationId, ok, failed);
        }
    } catch {}

    return {
        notificationId,
        matchedRuleId: rule.id || null,
        matchedGroupId: group.id,
        recipientsTotal: recipients.length,
        recipientsOk: ok,
        recipientsFailed: failed,
        attempts,
    };
}

async function tryEmail(r: ResolvedRecipient, subject: string, text: string, html: string): Promise<{ ok: boolean; error?: string }> {
    if (!isSmtpConfigured()) return { ok: false, error: 'SMTP not configured' };
    try {
        const res = await sendMail({ to: r.email, subject, text, html });
        return { ok: !!res.ok, error: res.error };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}

async function trySms(r: ResolvedRecipient, body: string): Promise<{ ok: boolean; error?: string; attempts?: any[] }> {
    if (!isSmsConfigured()) return { ok: false, error: 'SMS not configured' };
    try {
        const res = await sendSms(r.phone, body);
        return { ok: !!res.ok, error: res.error, attempts: res.attempts };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}
