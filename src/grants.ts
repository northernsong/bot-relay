import { newGrantId } from './ids.js';
import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { decryptSecret, encryptSecret } from './secret.js';
import type { Bot, Grant, Inquiry } from './types.js';
import { iso } from './http.js';

/** Contact details handed to the authorized requester only (design §5.5, §8). */
export type ContactPayload = {
  webhook_url: string;
  webhook_auth_name: string | null;
  webhook_auth_value: string | null;
  contact_version: number;
  fetched_at: string;
};

/**
 * Called inside the approval transaction: first approval inserts the grant,
 * a later approval after revoke/abandon re-activates the same row (design §4.1).
 */
export function upsertGrantOnApproval(deps: Deps, inquiry: Inquiry, now: number): Grant {
  const existing = deps.db.findGrantByPair(inquiry.requesterId, inquiry.targetId);
  if (!existing) {
    const grant: Grant = {
      id: newGrantId(),
      requesterId: inquiry.requesterId,
      targetId: inquiry.targetId,
      inquiryId: inquiry.id,
      grantedAt: now,
      revokedAt: null,
      abandonedAt: null,
      refreshedAt: null,
      refreshedContactVersion: null,
    };
    deps.db.insertGrant(grant);
    return grant;
  }
  const patch: Partial<Omit<Grant, 'id'>> = {
    inquiryId: inquiry.id,
    grantedAt: now,
    revokedAt: null,
    abandonedAt: null,
    refreshedAt: null,
    refreshedContactVersion: null,
  };
  deps.db.updateGrant(existing.id, patch);
  return { ...existing, ...patch };
}

/**
 * Controlled refresh: the only channel (besides an already-active grant on
 * POST /v1/inquiries) through which contact details ever leave the registry.
 */
export function refreshGrantContact(deps: Deps, requester: Bot, grantId: string): { grant_id: string; contact: ContactPayload } {
  const grant = deps.db.getGrant(grantId);
  if (!grant || grant.requesterId !== requester.id) throw new HttpError(404, 'not_found', 'No such grant');
  assertGrantActive(grant);
  const target = deps.db.getBot(grant.targetId);
  if (!target) throw new HttpError(404, 'not_found', 'No such grant');
  if (target.disabled) throw new HttpError(410, 'grant_inactive', 'The target bot is disabled');
  const now = deps.now();
  deps.db.updateGrant(grant.id, { refreshedAt: now, refreshedContactVersion: target.contactVersion });
  deps.metrics?.inc('grants_refresh_total');
  return { grant_id: grant.id, contact: buildContact(deps, target, now) };
}

/** Build the contact payload and record the fetch timestamp. */
export function buildContact(deps: Deps, target: Bot, now: number): ContactPayload {
  return {
    webhook_url: decryptSecret(target.webhookUrlEnc, deps.config.encryptionKey),
    webhook_auth_name: target.webhookAuthName === '' ? null : target.webhookAuthName,
    webhook_auth_value:
      target.webhookAuthValueEnc === '' ? null : decryptSecret(target.webhookAuthValueEnc, deps.config.encryptionKey),
    contact_version: target.contactVersion,
    fetched_at: iso(now),
  };
}

export function abandonGrant(deps: Deps, requester: Bot, grantId: string): void {
  const grant = deps.db.getGrant(grantId);
  if (!grant || grant.requesterId !== requester.id) throw new HttpError(404, 'not_found', 'No such grant');
  if (grant.revokedAt !== null || grant.abandonedAt !== null) {
    throw new HttpError(409, 'grant_inactive', 'This grant is no longer active');
  }
  const now = deps.now();
  deps.db.updateGrant(grant.id, { abandonedAt: now });
  deps.db.insertAudit({
    at: now,
    actor: requester.id,
    action: 'grant.abandoned',
    object: grant.id,
    detail: JSON.stringify({ peer: grant.targetId }),
    source: null,
  });
}

export function revokeGrant(
  deps: Deps,
  target: Bot,
  grantId: string,
  rotateWebhookSecret?: string,
): { revoked: boolean; webhook_secret_rotated: boolean } {
  const grant = deps.db.getGrant(grantId);
  if (!grant || grant.targetId !== target.id) throw new HttpError(404, 'not_found', 'No such grant');
  if (grant.revokedAt !== null || grant.abandonedAt !== null) {
    throw new HttpError(409, 'grant_inactive', 'This grant is no longer active');
  }
  const now = deps.now();
  let rotated = false;
  deps.db.transaction(() => {
    deps.db.updateGrant(grant.id, { revokedAt: now });
    if (rotateWebhookSecret !== undefined) {
      deps.db.updateBot(
        target.id,
        {
          webhookAuthValueEnc: encryptSecret(rotateWebhookSecret, deps.config.encryptionKey),
          contactVersion: target.contactVersion + 1,
          webhookSecretSetAt: now,
        },
        now,
      );
      rotated = true;
    }
  });
  deps.db.insertAudit({
    at: now,
    actor: target.id,
    action: 'grant.revoked',
    object: grant.id,
    detail: JSON.stringify({ requester: grant.requesterId, rotated_webhook_secret: rotated }),
    source: null,
  });
  if (rotated) {
    deps.db.insertAudit({
      at: now,
      actor: target.id,
      action: 'webhook.rotated',
      object: target.id,
      detail: JSON.stringify({ reason: 'grant.revoked' }),
      source: null,
    });
  }
  return { revoked: true, webhook_secret_rotated: rotated };
}

export function listGrantsFor(deps: Deps, bot: Bot, role: 'given' | 'received'): Array<Record<string, unknown>> {
  const grants = role === 'given' ? deps.db.listGrants({ targetId: bot.id }) : deps.db.listGrants({ requesterId: bot.id });
  return grants.map((grant) => {
    const peerId = role === 'given' ? grant.requesterId : grant.targetId;
    const peer = deps.db.getBot(peerId);
    return {
      id: grant.id,
      peer: { id: peerId, display_name: peer?.displayName ?? '' },
      inquiry_id: grant.inquiryId,
      granted_at: iso(grant.grantedAt),
      refreshed_at: grant.refreshedAt === null ? null : iso(grant.refreshedAt),
      revoked_at: grant.revokedAt === null ? null : iso(grant.revokedAt),
      abandoned_at: grant.abandonedAt === null ? null : iso(grant.abandonedAt),
    };
  });
}

function assertGrantActive(grant: Grant): void {
  if (grant.revokedAt !== null || grant.abandonedAt !== null) {
    throw new HttpError(410, 'grant_inactive', 'This grant was revoked or abandoned');
  }
}
