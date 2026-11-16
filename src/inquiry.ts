import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { newInquiryId } from './ids.js';
import { signInquiryPayload } from './identity.js';
import { buildContact, upsertGrantOnApproval, type ContactPayload } from './grants.js';
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
 * POST /v1/inquiries acceptance + dedup rules (design §5.4). Fully synchronous
 * so the database-level unique active index guarantees the pair invariant.
 */
export function openInquiry(deps: Deps, requester: Bot, to: unknown): OpenResult {
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
    const now = deps.now();
    deps.db.updateGrant(grant.id, { refreshedAt: now, refreshedContactVersion: target.contactVersion });
    return { kind: 'contact', grantId: grant.id, contact: buildContact(deps, target, now) };
  }

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
  deps.db.expirePendingInquiries(now);
  deps.db.failStuckDeliveries(now, STUCK_DELIVERING_MS, 'timeout');
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
  setImmediate(() => {
    void deliverInquiry(deps, inquiryId);
  });
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
      deps.db.transitionInquiry(inquiryId, 'delivering', { status: 'undelivered', deliveryError: 'connection_failed' });
      return;
    }
    const rate = deps.db.consumeRate(`outbound:${target.id}`, deps.now(), OUTBOUND_WINDOW_MS, OUTBOUND_DELIVERIES_PER_HOUR);
    if (!rate.allowed) {
      deps.db.transitionInquiry(inquiryId, 'delivering', { status: 'undelivered', deliveryError: 'rate_limited' });
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
      deps.db.transitionInquiry(inquiryId, 'delivering', { status: 'undelivered', deliveryError: classifyDeliveryError(err) });
      return;
    }
    await readCappedBody(response, RESPONSE_BODY_LIMIT);
    if (response.status >= 200 && response.status < 300) {
      deps.db.transitionInquiry(inquiryId, 'delivering', {
        status: 'pending',
        deliveredAt: deps.now(),
        deliveryError: null,
      });
    } else {
      deps.db.transitionInquiry(inquiryId, 'delivering', { status: 'undelivered', deliveryError: 'http_5xx' });
    }
  } catch (err) {
    // Never let a background delivery crash the process; state stays delivering
    // until the sweeper buries it.
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

function classifyDeliveryError(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  if (err instanceof BlockedAddressError || cause instanceof BlockedAddressError) return 'blocked_address';
  if (cause?.message === 'unexpected redirect') return 'blocked_address';
  return 'connection_failed';
}
