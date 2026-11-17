import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { newInquiryId } from './ids.js';
import { signInquiryPayload } from './identity.js';
import { buildContact, upsertGrantOnApproval, type ContactPayload } from './grants.js';
import { deliveryFailureReason } from './metrics.js';
import { decryptSecret } from './secret.js';
import { redactLogLine } from './redact.js';
import { BlockedAddressError, pinnedFetch, readCappedBody } from './ssrf.js';
import type { Bot, Inquiry, InquiryStatus } from './types.js';
import { iso } from './http.js';
import { VERSION } from './version.js';

/** delivering rows still around after this long are crash residue (design §6.5). */
const STUCK_DELIVERING_MS = 60_000;
/** Backstop cap on outbound deliveries per target bot (design §9.2). */
const OUTBOUND_DELIVERIES_PER_HOUR = 20;
const OUTBOUND_WINDOW_MS = 3_600_000;
/** Outbound response bodies are read up to 4KB and then cancelled (design §9.1). */
const RESPONSE_BODY_LIMIT = 4096;
const SWEEP_INTERVAL_MS = 60_000;

export type OpenResult =
  | { kind: 'contact'; grantId: string; contact: ContactPayload }
  | { kind: 'existing'; inquiry: Inquiry }
  | { kind: 'created'; inquiry: Inquiry };

/**
 * Rate-limit callbacks supplied by the route (design §9.2): a brand-new
 * inquiry pays the "initiate inquiry" budget, a controlled refresh through an
 * active grant pays the refresh budget shared with GET /v1/grants/:id/contact.
 */
export type InquiryLimits = {
  limitNew: () => void;
  limitRefresh: () => void;
};

/**
 * POST /v1/inquiries acceptance + dedup rules (design §5.4). Fully synchronous
 * so the database-level unique active index guarantees the pair invariant.
 */
export function openInquiry(deps: Deps, requester: Bot, to: unknown, limits: InquiryLimits): OpenResult {
  if (typeof to !== 'string' || to.trim() === '') {
    throw new HttpError(400, 'invalid_request', '"to" must be the id of the bot to inquire');
  }
  const targetId = to.trim();
  if (targetId === requester.id) {
    throw new HttpError(400, 'invalid_request', 'A bot cannot open an inquiry against itself');
  }
  const target = deps.db.getBot(targetId);
  if (!target) throw new HttpError(404, 'target_not_found', `No bot named "${targetId}" is registered`);

  sweepInquiries(deps);

  // Rule 1: active grant -> controlled refresh, never bother B again.
  const grant = deps.db.findGrantByPair(requester.id, targetId);
  if (grant && grant.revokedAt === null && grant.abandonedAt === null) {
    if (target.disabled) throw new HttpError(410, 'grant_inactive', 'The target bot is disabled');
    // Controlled refresh: charged to the refresh budget (30/min), not the
    // stricter "initiate inquiry" budget (F1, design §9.2).
    limits.limitRefresh();
    const now = deps.now();
    deps.db.updateGrant(grant.id, { refreshedAt: now, refreshedContactVersion: target.contactVersion });
    deps.metrics?.inc('grants_refresh_total');
    return { kind: 'contact', grantId: grant.id, contact: buildContact(deps, target, now) };
  }

  // Not a refresh, so this request pays the "initiate inquiry" budget.
  limits.limitNew();

  // Rule 2: active inquiry -> return it as-is, no new row, no reset of expires_at.
  const active = deps.db.getActiveInquiry(requester.id, targetId);
  if (active) return { kind: 'existing', inquiry: active };

  // Intake control runs before creation: blocked means no row and no outbound call.
  if (
    target.disabled ||
    target.intakeMode === 'none' ||
    (target.intakeMode === 'allowlist' && !(target.intakeAllowlist ?? []).includes(requester.id))
  ) {
    throw new HttpError(403, 'inquiry_blocked', 'The target bot does not accept inquiries from this bot');
  }

  const rate = deps.db.consumeRate(`pair:${requester.id}>${targetId}`, deps.now(), OUTBOUND_WINDOW_MS, deps.config.inquiryPairRatePerHour);
  if (!rate.allowed) {
    deps.metrics?.inc('rate_limited_total', { scope: 'pair' });
    throw new HttpError(
      429,
      'inquiry_rate_limited',
      'Too many new inquiries against this bot; wait before trying again',
      { 'retry-after': String(rate.retryAfterSec) },
      { retry_after: rate.retryAfterSec },
    );
  }

  const now = deps.now();
  const inquiry: Inquiry = {
    id: newInquiryId(),
    requesterId: requester.id,
    targetId,
    status: 'delivering',
    createdAt: now,
    expiresAt: now + deps.config.inquiryTtlSec * 1000,
    deliveredAt: null,
    decidedAt: null,
    deliveryError: null,
  };
  try {
    deps.db.insertInquiry(inquiry);
  } catch (err) {
    // Concurrent creation lost the race on the partial unique index.
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      const existing = deps.db.getActiveInquiry(requester.id, targetId);
      if (existing) return { kind: 'existing', inquiry: existing };
    }
    throw err;
  }
  deps.metrics?.inc('inquiries_created_total');
  deps.db.insertAudit({
    at: now,
    actor: requester.id,
    action: 'inquiry.created',
    object: inquiry.id,
    detail: JSON.stringify({ to: targetId }),
    source: null,
  });
  scheduleDelivery(deps, inquiry.id);
  return { kind: 'created', inquiry };
}

/** POST /v1/inquiries/:id/decision — the only pending -> approved|rejected path. */
export function decideInquiry(deps: Deps, actor: Bot, inquiryId: string, decision: unknown): Inquiry {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new HttpError(400, 'invalid_request', 'decision must be "approve" or "reject"');
  }
  const inquiry = deps.db.getInquiry(inquiryId);
  if (!inquiry) throw new HttpError(404, 'not_found', 'No such inquiry');
  if (inquiry.targetId !== actor.id) {
    throw new HttpError(403, 'not_allowed', 'Only the target of this inquiry may decide it');
  }
  sweepInquiries(deps);
  const current = deps.db.getInquiry(inquiryId) ?? inquiry;
  if (current.status !== 'pending') {
    throw new HttpError(409, 'inquiry_closed', `This inquiry is ${current.status} and no longer awaits a decision`);
  }
  const now = deps.now();
  const next: InquiryStatus = decision === 'approve' ? 'approved' : 'rejected';
  const applied = deps.db.transaction(() => {
    if (!deps.db.transitionInquiry(inquiryId, 'pending', { status: next, decidedAt: now })) return false;
    if (next === 'approved') upsertGrantOnApproval(deps, current, now);
    return true;
  });
  if (!applied) {
    const raced = deps.db.getInquiry(inquiryId);
    throw new HttpError(409, 'inquiry_closed', `This inquiry is ${raced?.status ?? next} and no longer awaits a decision`);
  }
  deps.metrics?.inc('inquiry_outcome_total', { outcome: next });
  deps.db.insertAudit({
    at: now,
    actor: actor.id,
    action: 'inquiry.decided',
    object: inquiryId,
    detail: JSON.stringify({ decision }),
    source: null,
  });
  const updated = deps.db.getInquiry(inquiryId);
  if (!updated) throw new HttpError(500, 'internal', 'Inquiry disappeared after decision');
  return updated;
}

export function listInquiriesFor(deps: Deps, bot: Bot, role: 'requester' | 'target', status?: InquiryStatus): Inquiry[] {
  sweepInquiries(deps);
  return deps.db.listInquiries(role === 'requester' ? { requesterId: bot.id, status } : { targetId: bot.id, status });
}

export function getInquiryFor(deps: Deps, bot: Bot, id: string): Inquiry {
  sweepInquiries(deps);
  const inquiry = deps.db.getInquiry(id);
  if (!inquiry || (inquiry.requesterId !== bot.id && inquiry.targetId !== bot.id)) {
    throw new HttpError(404, 'not_found', 'No such inquiry');
  }
  return inquiry;
}

/** Lazy judgment: expire overdue pending inquiries and bury stuck deliveries. */
export function sweepInquiries(deps: Deps): void {
  if (deps.db.closed) return;
  const now = deps.now();
  const expired = deps.db.expirePendingInquiries(now);
  if (expired.length > 0) {
    deps.metrics?.inc('inquiry_outcome_total', { outcome: 'expired' }, expired.length);
    for (const id of expired) {
      deps.db.insertAudit({ at: now, actor: 'registry', action: 'inquiry.expired', object: id, detail: null, source: null });
    }
  }
  const stuck = deps.db.failStuckDeliveries(now, STUCK_DELIVERING_MS, 'timeout');
  if (stuck.length > 0) {
    deps.metrics?.inc('inquiry_outcome_total', { outcome: 'undelivered' }, stuck.length);
    deps.metrics?.inc('inquiry_delivery_failures_total', { reason: 'timeout' }, stuck.length);
    for (const id of stuck) {
      deps.db.insertAudit({
        at: now,
        actor: 'registry',
        action: 'inquiry.undelivered',
        object: id,
        detail: JSON.stringify({ reason: 'timeout' }),
        source: null,
      });
    }
  }
}

/** Periodic sweeper (60s) plus one run at startup (design §6.5). */
export function startInquirySweeper(deps: Deps): { stop: () => void; sweep: () => void } {
  sweepInquiries(deps);
  const timer = setInterval(() => sweepInquiries(deps), SWEEP_INTERVAL_MS);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    sweep: () => sweepInquiries(deps),
  };
}

function scheduleDelivery(deps: Deps, inquiryId: string): void {
  // The acceptance response never waits for the outbound call (design §6.3).
  const tasks = (deps.inflight ??= new Set<Promise<unknown>>());
  setImmediate(() => {
    const task = deliverInquiry(deps, inquiryId).finally(() => {
      tasks.delete(task);
    });
    tasks.add(task);
  });
}

/**
 * Shutdown handoff (F5): stop the sweeper and wait for in-flight deliveries so
 * none of them writes to a database that is already closed. Capped by the
 * delivery timeout so a hung webhook cannot stall shutdown.
 */
export async function stopBackgroundWork(deps: Deps, timeoutMs = 10_000): Promise<void> {
  deps.sweeper?.stop();
  const tasks = deps.inflight;
  if (!tasks || tasks.size === 0) return;
  await Promise.race([
    Promise.allSettled([...tasks]),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * The single outbound call site of the whole service: one POST of the inquiry
 * to the target's webhook, pinned, no redirects, no retry (design §6, §9.1).
 * The body is signed with the registry Ed25519 key so B can prove the
 * inquiry really came from the registry (§6.3, P0-5⑦); no symmetric secret
 * is ever shared with the receiver.
 */
async function deliverInquiry(deps: Deps, inquiryId: string): Promise<void> {
  try {
    if (deps.db.closed) return;
    const inquiry = deps.db.getInquiry(inquiryId);
    if (!inquiry || inquiry.status !== 'delivering') return;
    const target = deps.db.getBot(inquiry.targetId);
    if (!target) {
      markUndelivered(deps, inquiryId, 'connection_failed');
      return;
    }
    const rate = deps.db.consumeRate(`outbound:${target.id}`, deps.now(), OUTBOUND_WINDOW_MS, OUTBOUND_DELIVERIES_PER_HOUR);
    if (!rate.allowed) {
      markUndelivered(deps, inquiryId, 'rate_limited');
      return;
    }
    const url = decryptSecret(target.webhookUrlEnc, deps.config.encryptionKey);
    const requester = deps.db.getBot(inquiry.requesterId);
    const payload = JSON.stringify({
      type: 'inquiry',
      registry: deps.config.publicBaseUrl,
      inquiry_id: inquiry.id,
      from: inquiry.requesterId,
      from_display_name: requester?.displayName ?? '',
      to: inquiry.targetId,
      created_at: iso(inquiry.createdAt),
      expires_at: iso(inquiry.expiresAt),
    });
    const signature = signInquiryPayload(deps, payload);
    let response: Response;
    try {
      response = await pinnedFetch(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': `bot-relay/${VERSION}`,
            'x-bot-relay-signature': signature,
          },
          body: payload,
        },
        {
          allowHttp: deps.config.allowHttpWebhooks,
          allowPrivate: deps.config.allowPrivateWebhooks,
          lookupHost: deps.lookup,
          timeoutMs: deps.config.inquiryDeliveryTimeoutMs,
        },
      );
    } catch (err) {
      markUndelivered(deps, inquiryId, classifyDeliveryError(err));
      return;
    }
    await readCappedBody(response, RESPONSE_BODY_LIMIT);
    // The database may have closed while the outbound call was in flight;
    // do not write to it (F5).
    if (deps.db.closed) return;
    if (response.status >= 200 && response.status < 300) {
      if (deps.db.transitionInquiry(inquiryId, 'delivering', {
        status: 'pending',
        deliveredAt: deps.now(),
        deliveryError: null,
      })) {
        deps.metrics?.inc('inquiry_outcome_total', { outcome: 'pending' });
        deps.db.insertAudit({
          at: deps.now(),
          actor: 'registry',
          action: 'inquiry.delivered',
          object: inquiryId,
          detail: null,
          source: null,
        });
      }
    } else {
      markUndelivered(deps, inquiryId, 'http_5xx');
    }
  } catch (err) {
    // Never let a background delivery crash the process; state stays delivering
    // until the sweeper buries it. If the database closed mid-delivery, the
    // write failure is expected shutdown noise, not a real fault (F5).
    if (deps.db.closed) return;
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'inquiry_delivery_failed',
        inquiry_id: inquiryId,
        error: redactLogLine(err instanceof Error ? err.message : 'error'),
      }),
    );
  }
}

/** Shared terminal transition for a failed delivery: state, metric, audit. */
function markUndelivered(deps: Deps, inquiryId: string, reason: string): void {
  // Shutdown may close the database mid-delivery; leave the row for the
  // startup sweeper instead of writing to a closed handle (F5).
  if (deps.db.closed) return;
  if (!deps.db.transitionInquiry(inquiryId, 'delivering', { status: 'undelivered', deliveryError: reason })) return;
  deps.metrics?.inc('inquiry_outcome_total', { outcome: 'undelivered' });
  deps.metrics?.inc('inquiry_delivery_failures_total', { reason: deliveryFailureReason(reason) });
  deps.db.insertAudit({
    at: deps.now(),
    actor: 'registry',
    action: 'inquiry.undelivered',
    object: inquiryId,
    detail: JSON.stringify({ reason }),
    source: null,
  });
}

function classifyDeliveryError(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  if (err instanceof BlockedAddressError || cause instanceof BlockedAddressError) return 'blocked_address';
  if (cause?.message === 'unexpected redirect') return 'blocked_address';
  return 'connection_failed';
}
