import type { Hono } from 'hono';

import { requireActiveBot, requireBot } from './auth.js';
import { limitAuth, limitKey } from './client-ip.js';
import type { Deps } from './deps.js';
import { HttpError, isUniqueConstraint } from './errors.js';
import { buildJwks, issueIdentityToken, verifyIdentityToken } from './identity.js';
import { decryptSecret, encryptSecret, hashToken, newToken } from './secret.js';
import { assertWebhookUrl } from './ssrf.js';
import type { Bot, BotPatch, Inquiry, InquiryStatus } from './types.js';
import { iso, readJsonObject, readOptionalJsonObject } from './http.js';
import { decideInquiry, getInquiryFor, listInquiriesFor, openInquiry, startInquirySweeper } from './inquiry.js';
import type { InquiryLimits } from './inquiry.js';
import { abandonGrant, listGrantsFor, refreshGrantContact, revokeGrant } from './grants.js';
import {
  parseBotId,
  parseCapabilities,
  parseDisplayName,
  parseHeaderName,
  parseHeaderValue,
  parseIntake,
  rejectUnknown,
} from './validate.js';

const INVITE_CODE = /^inv_[A-Za-z0-9_-]{16,80}$/;
const INQUIRY_STATUSES: InquiryStatus[] = ['delivering', 'pending', 'approved', 'rejected', 'expired', 'undelivered'];

export function registerV1Routes(app: Hono, deps: Deps): void {
  // Lazy-expiry sweeper; runs once at startup and then every 60s. It disarms
  // itself once the database is closed, and is stopped/drained at shutdown.
  deps.sweeper = startInquirySweeper(deps);

  registerRegistrationRoutes(app, deps);
  registerMeRoutes(app, deps);
  registerDirectoryRoutes(app, deps);
  registerInquiryRoutes(app, deps);
  registerGrantRoutes(app, deps);
  registerIdentityRoutes(app, deps);
}

/** Inter-bot authentication surface (design §5.6, §7). */
function registerIdentityRoutes(app: Hono, deps: Deps): void {
  // Disabled bots get no new proofs (§7.4): stop issuing at the door.
  //
  // Audience binding (anti-impersonation): every proof names the one bot it is
  // for (`aud`, required). The target must exist, be enabled, and share an
  // active grant with the caller in either direction (caller -> aud: aud
  // approved the caller; aud -> caller: the caller approved aud and may answer
  // it). Receivers require aud === their own id, so B cannot replay a proof
  // that A minted for B against C.
  app.post('/v1/identity-token', async (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `identity:${bot.id}`, deps.config.mutationRatePerMin);
    const body = await readOptionalJsonObject(c);
    rejectUnknown(body, ['aud']);
    if (body.aud === undefined || body.aud === null || body.aud === '') {
      throw new HttpError(400, 'aud_required', 'Name the bot you are about to call: {"aud":"<target bot id>"}');
    }
    const aud = parseBotId(body.aud, 'aud');
    if (aud === bot.id) throw new HttpError(400, 'invalid_request', 'aud must be another bot, not yourself');
    const target = deps.db.getBot(aud);
    if (!target || target.disabled) throw new HttpError(404, 'target_not_found', `No active bot "${aud}"`);
    if (!hasActiveGrantBetween(deps, bot.id, aud)) {
      throw new HttpError(
        403,
        'no_grant',
        `No active grant between you and "${aud}" in either direction; open an inquiry and get it approved first`,
      );
    }
    const issued = issueIdentityToken(deps, bot, aud);
    deps.metrics?.inc('identity_tokens_issued_total');
    return c.json({ token: issued.token, expires_at: iso(issued.expiresAt) });
  });

  // Online confirmation channel (§7.3 step 3): signature + expiry + status.
  app.post('/v1/identity/verify', async (c) => {
    const caller = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `verify:${caller.id}`, deps.config.defaultRatePerMin);
    const body = await readJsonObject(c);
    rejectUnknown(body, ['token', 'audience']);
    if (typeof body.token !== 'string' || body.token.trim() === '') {
      throw new HttpError(401, 'invalid_token', 'Provide the JWT string in the "token" field');
    }
    // Expected audience defaults to the verifying bot itself: the usual caller
    // is the receiver checking a proof that should have been minted for it.
    const audience = body.audience === undefined ? caller.id : parseBotId(body.audience, 'audience');
    const result = verifyIdentityToken(body.token, {
      jwks: buildJwks(deps),
      iss: deps.config.publicBaseUrl,
      now: deps.now(),
      aud: audience,
    });
    if (!result.valid) {
      deps.metrics?.inc('identity_verify_total', { result: 'invalid' });
      throw new HttpError(401, 'invalid_token', `The identity token is invalid (${result.reason})`, undefined, {
        reason: result.reason,
      });
    }
    const subject = deps.db.getBot(result.claims.sub);
    if (!subject) {
      // Signed proof of a bot that no longer exists: report it as gone.
      deps.metrics?.inc('identity_verify_total', { result: 'disabled' });
      return c.json({ valid: false, id: result.claims.sub, display_name: null, disabled: true });
    }
    deps.metrics?.inc('identity_verify_total', { result: subject.disabled ? 'disabled' : 'valid' });
    return c.json({ valid: !subject.disabled, id: subject.id, display_name: subject.displayName, disabled: subject.disabled });
  });

  // Real-time status lookup for the online revocation check (P0-7②).
  app.get('/v1/bots/:id/status', (c) => {
    const caller = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `status:${caller.id}`, deps.config.defaultRatePerMin);
    const target = deps.db.getBot(c.req.param('id') ?? '');
    if (!target) throw new HttpError(404, 'not_found', 'No such bot');
    return c.json({ id: target.id, display_name: target.displayName, disabled: target.disabled });
  });
}

/**
 * POST /v1/register (JSON API) and the GET /register form page share this one
 * implementation: the page's fetch call posts the same fields to this route.
 */
function registerRegistrationRoutes(app: Hono, deps: Deps): void {
  app.post('/v1/register', async (c) => {
    await limitAuth(deps, c, 'register');
    const body = await readJsonObject(c);
    rejectUnknown(body, [
      'invite_code',
      'id',
      'display_name',
      'capabilities',
      'webhook_url',
      'webhook_auth_name',
      'webhook_auth_value',
      'intake',
    ]);
    const inviteHash = hashToken(parseInviteCode(body.invite_code));
    const id = parseBotId(body.id);
    const displayName = parseDisplayName(body.display_name);
    const capabilities = parseCapabilities(body.capabilities);
    const webhookUrl = await parseWebhookUrl(deps, body.webhook_url);
    const auth = parseWebhookAuth(body.webhook_auth_name, body.webhook_auth_value);
    const intake = parseIntake(body.intake);

    const token = newToken();
    const now = deps.now();
    try {
      deps.db.transaction(() => {
        if (!deps.db.consumeInvite(inviteHash, now)) {
          throw new HttpError(403, 'invite_invalid', 'Invite code is invalid, expired, revoked, or used up');
        }
        deps.db.insertBot({
          id,
          displayName,
          capabilities,
          webhookUrlEnc: encryptSecret(webhookUrl, deps.config.encryptionKey),
          webhookAuthName: auth.name,
          webhookAuthValueEnc: auth.value === null ? '' : encryptSecret(auth.value, deps.config.encryptionKey),
          tokenHash: hashToken(token),
          tokenSetAt: now,
          tokenRevokedAt: null,
          disabled: false,
          intakeMode: intake.mode,
          intakeAllowlist: intake.allowlist,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: null,
        });
      });
    } catch (err) {
      if (isUniqueConstraint(err, 'bots.id')) {
        throw new HttpError(409, 'id_taken', `Bot id "${id}" is already registered`);
      }
      throw err;
    }
    const bot = deps.db.getBot(id);
    if (!bot) throw new HttpError(500, 'internal', 'Bot disappeared after insert');
    return c.json({ bot: presentOwnBot(deps, bot), token, next_steps: nextSteps(deps, token) }, 201);
  });
}

/** Copy-paste next steps for the onboarding wizard (P1-2, design §14 stage D). */
function nextSteps(deps: Deps, token: string): Record<string, string> {
  const base = deps.config.publicBaseUrl;
  const auth = `Authorization: Bearer ${token}`;
  return {
    check_own_profile: `curl -s ${base}/v1/me -H '${auth}'`,
    directory_lookup: `curl -s ${base}/v1/directory -H '${auth}'`,
    open_inquiry: `curl -s -X POST ${base}/v1/inquiries -H '${auth}' -H 'content-type: application/json' -d '{"to":"target-bot-id"}'`,
    get_identity_token: `curl -s -X POST ${base}/v1/identity-token -H '${auth}' -H 'content-type: application/json' -d '{"aud":"<peer bot id>"}'`,
    call_peer_directly: `curl -s -X POST '<peer webhook_url>' -H '<peer webhook_auth_name>: <peer webhook_auth_value>' -H '${IDENTITY_HEADER}: <fresh token from get_identity_token>' -H 'content-type: application/json' -d '{...}'`,
  };
}

/** True when caller and peer share a non-revoked, non-abandoned grant, either direction. */
function hasActiveGrantBetween(deps: Deps, a: string, b: string): boolean {
  return [deps.db.findGrantByPair(a, b), deps.db.findGrantByPair(b, a)].some(
    (grant) => grant !== undefined && grant.revokedAt === null && grant.abandonedAt === null,
  );
}

/**
 * The header every direct bot-to-bot call must carry. The registry is not on
 * the call path, so it cannot add it for the caller: without it the receiver
 * has no proof of who is calling (design §7.1).
 */
const IDENTITY_HEADER = 'X-Bot-Relay-Identity';

/** Static how-to for direct calls, returned by GET /v1/me (never contains secrets). */
function directCallGuide(deps: Deps): Record<string, string | boolean> {
  const base = deps.config.publicBaseUrl;
  return {
    required: true,
    header: IDENTITY_HEADER,
    get_token: `POST ${base}/v1/identity-token (Authorization: Bearer <your br_ token>) body {"aud":"<peer bot id>"} -> {"token":"eyJ...","expires_at":"..."}. aud is required; you need an active grant with that peer (either direction).`,
    rule: `Every direct call to a peer webhook must carry ${IDENTITY_HEADER}: <token minted for that peer> next to the peer's own webhook auth header. Fetch a fresh token per call (valid <= 300s); never reuse one minted for another peer.`,
    receiver_check: `Verify ${IDENTITY_HEADER} against ${base}/.well-known/bot-relay/jwks.json (EdDSA, iss=${base}, aud=<your own bot id>, exp); reject the call if it is missing, invalid, or aud is not you. Inquiries from the registry carry X-Bot-Relay-Signature instead.`,
    guide: 'docs/AGENT_GUIDE.md §5.2-5.4',
  };
}

function registerMeRoutes(app: Hono, deps: Deps): void {
  // Disabled bots may inspect their own status (P0-2④ / N4).
  app.get('/v1/me', (c) => {
    const bot = requireBot(deps, c.req.header('authorization'));
    return c.json({ bot: presentOwnBot(deps, bot), direct_call: directCallGuide(deps) });
  });

  app.patch('/v1/me', async (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    const body = await readJsonObject(c);
    rejectUnknown(body, ['display_name', 'capabilities', 'webhook_url', 'webhook_auth_name', 'webhook_auth_value', 'intake']);

    const patch: BotPatch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'display_name')) {
      patch.displayName = parseDisplayName(body.display_name);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'capabilities')) {
      patch.capabilities = parseCapabilities(body.capabilities);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'intake')) {
      const intake = parseIntake(body.intake);
      patch.intakeMode = intake.mode;
      patch.intakeAllowlist = intake.allowlist;
    }
    if (body.webhook_url !== undefined) {
      if (body.webhook_url === null) throw new HttpError(400, 'invalid_request', 'webhook_url cannot be removed');
      patch.webhookUrlEnc = encryptSecret(await parseWebhookUrl(deps, body.webhook_url), deps.config.encryptionKey);
    }

    let contactChanged = false;
    if (body.webhook_url !== undefined) contactChanged = true;
    if (body.webhook_auth_name !== undefined || body.webhook_auth_value !== undefined) {
      const oldName = bot.webhookAuthName;
      const oldValue = bot.webhookAuthValueEnc === '' ? null : decryptSecret(bot.webhookAuthValueEnc, deps.config.encryptionKey);
      const nextName =
        body.webhook_auth_name === undefined
          ? oldName
          : body.webhook_auth_name === null
            ? ''
            : parseHeaderName(body.webhook_auth_name);
      const nextValue =
        body.webhook_auth_value === undefined
          ? oldValue
          : body.webhook_auth_value === null
            ? null
            : parseHeaderValue(body.webhook_auth_value);
      if ((nextName === '') !== (nextValue === null)) {
        throw new HttpError(400, 'invalid_request', 'webhook_auth_name and webhook_auth_value must be set together');
      }
      if (nextName !== oldName || nextValue !== oldValue) {
        patch.webhookAuthName = nextName;
        patch.webhookAuthValueEnc = nextValue === null ? '' : encryptSecret(nextValue, deps.config.encryptionKey);
        contactChanged = true;
        if (nextValue !== null && nextValue !== oldValue) patch.webhookSecretSetAt = deps.now();
      }
    }
    if (contactChanged) patch.contactVersion = bot.contactVersion + 1;

    const now = deps.now();
    deps.db.updateBot(bot.id, patch, now);
    if (patch.webhookSecretSetAt !== undefined) {
      deps.db.insertAudit({
        at: now,
        actor: bot.id,
        action: 'webhook.rotated',
        object: bot.id,
        detail: JSON.stringify({ reason: 'me.patch' }),
        source: null,
      });
    }
    const updated = deps.db.getBot(bot.id);
    if (!updated) throw new HttpError(500, 'internal', 'Bot disappeared after update');
    return c.json({ bot: presentOwnBot(deps, updated) });
  });

  app.post('/v1/me/token/rotate', (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `token:${bot.id}`, deps.config.mutationRatePerMin);
    const token = newToken();
    const now = deps.now();
    deps.db.updateBot(bot.id, { tokenHash: hashToken(token), tokenSetAt: now }, now);
    deps.db.insertAudit({
      at: now,
      actor: bot.id,
      action: 'token.rotated',
      object: bot.id,
      detail: null,
      source: null,
    });
    return c.json({ token });
  });

  app.post('/v1/me/token/revoke', (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `token:${bot.id}`, deps.config.mutationRatePerMin);
    const now = deps.now();
    deps.db.updateBot(bot.id, { tokenRevokedAt: now }, now);
    deps.db.insertAudit({
      at: now,
      actor: bot.id,
      action: 'token.revoked',
      object: bot.id,
      detail: null,
      source: null,
    });
    return c.json({ revoked: true });
  });
}

function registerDirectoryRoutes(app: Hono, deps: Deps): void {
  app.get('/v1/directory', (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `directory:${bot.id}`, deps.config.defaultRatePerMin);
    deps.metrics?.inc('directory_lookups_total');
    return c.json({ bots: deps.db.listBots().map(presentDirectoryBot) });
  });

  app.get('/v1/directory/:id', (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `directory:${bot.id}`, deps.config.defaultRatePerMin);
    deps.metrics?.inc('directory_lookups_total');
    const target = deps.db.getBot(c.req.param('id') ?? '');
    if (!target) throw new HttpError(404, 'not_found', 'No such bot');
    return c.json({ bot: presentDirectoryBot(target) });
  });
}

function registerInquiryRoutes(app: Hono, deps: Deps): void {
  app.post('/v1/inquiries', async (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    // Budgets per design §9.2: a brand-new inquiry consumes the "initiate
    // inquiry" bucket (10/min), while a controlled refresh through an active
    // grant consumes the refresh bucket shared with GET /v1/grants/:id/contact
    // (30/min) — a refresh must not pay the stricter initiation price (F1).
    const limits: InquiryLimits = {
      limitNew: () => limitKey(deps, `inquiry:${bot.id}`, deps.config.inquiryRatePerMin),
      limitRefresh: () => limitKey(deps, `refresh:${bot.id}`, deps.config.mutationRatePerMin),
    };
    const body = await readJsonObject(c);
    rejectUnknown(body, ['to']);
    const result = openInquiry(deps, bot, body.to, limits);
    if (result.kind === 'contact') {
      return c.json({ status: 'approved', grant_id: result.grantId, contact: result.contact });
    }
    if (result.kind === 'existing') {
      return c.json({ inquiry: presentInquiry(result.inquiry) });
    }
    return c.json({ inquiry: presentInquiry(result.inquiry) }, 202);
  });

  app.get('/v1/inquiries', (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `inquiries_read:${bot.id}`, deps.config.defaultRatePerMin);
    const role = c.req.query('role') ?? 'requester';
    if (role !== 'requester' && role !== 'target') {
      throw new HttpError(400, 'invalid_request', 'role must be "requester" or "target"');
    }
    const statusParam = c.req.query('status');
    let status: InquiryStatus | undefined;
    if (statusParam !== undefined) {
      if (!INQUIRY_STATUSES.includes(statusParam as InquiryStatus)) {
        throw new HttpError(400, 'invalid_request', `status must be one of: ${INQUIRY_STATUSES.join(', ')}`);
      }
      status = statusParam as InquiryStatus;
    }
    return c.json({ inquiries: listInquiriesFor(deps, bot, role, status).map(presentInquiry) });
  });

  app.get('/v1/inquiries/:id', (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `inquiries_read:${bot.id}`, deps.config.defaultRatePerMin);
    return c.json({ inquiry: presentInquiry(getInquiryFor(deps, bot, c.req.param('id') ?? '')) });
  });

  app.post('/v1/inquiries/:id/decision', async (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `decision:${bot.id}`, deps.config.mutationRatePerMin);
    const body = await readJsonObject(c);
    rejectUnknown(body, ['decision']);
    const inquiry = decideInquiry(deps, bot, c.req.param('id') ?? '', body.decision);
    return c.json({ inquiry: presentInquiry(inquiry) });
  });
}

function registerGrantRoutes(app: Hono, deps: Deps): void {
  app.get('/v1/grants', (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `grants_read:${bot.id}`, deps.config.defaultRatePerMin);
    const role = c.req.query('role') ?? 'received';
    if (role !== 'given' && role !== 'received') {
      throw new HttpError(400, 'invalid_request', 'role must be "given" or "received"');
    }
    return c.json({ grants: listGrantsFor(deps, bot, role) });
  });

  app.get('/v1/grants/:id/contact', (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `refresh:${bot.id}`, deps.config.mutationRatePerMin);
    const { grant_id, contact } = refreshGrantContact(deps, bot, c.req.param('id') ?? '');
    return c.json({ grant_id, ...contact });
  });

  app.post('/v1/grants/:id/abandon', async (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `abandon:${bot.id}`, deps.config.mutationRatePerMin);
    const body = await readOptionalJsonObject(c);
    rejectUnknown(body, []);
    abandonGrant(deps, bot, c.req.param('id') ?? '');
    return c.json({ abandoned: true });
  });

  app.post('/v1/grants/:id/revoke', async (c) => {
    const bot = requireActiveBot(deps, c.req.header('authorization'));
    limitKey(deps, `revoke:${bot.id}`, deps.config.mutationRatePerMin);
    const body = await readOptionalJsonObject(c);
    rejectUnknown(body, ['rotate_webhook_secret']);
    const rotate =
      body.rotate_webhook_secret === undefined || body.rotate_webhook_secret === null
        ? undefined
        : parseHeaderValue(body.rotate_webhook_secret);
    return c.json(revokeGrant(deps, bot, c.req.param('id') ?? '', rotate));
  });
}

function parseInviteCode(value: unknown): string {
  if (typeof value !== 'string' || !INVITE_CODE.test(value.trim())) {
    throw new HttpError(403, 'invite_invalid', 'Invite code required');
  }
  return value.trim();
}

async function parseWebhookUrl(deps: Deps, value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url must be an https URL');
  }
  return assertWebhookUrl(value, {
    allowHttp: deps.config.allowHttpWebhooks,
    allowPrivate: deps.config.allowPrivateWebhooks,
    lookupHost: deps.lookup,
  });
}

function parseWebhookAuth(nameRaw: unknown, valueRaw: unknown): { name: string; value: string | null } {
  const nameMissing = nameRaw === undefined || nameRaw === null || nameRaw === '';
  const valueMissing = valueRaw === undefined || valueRaw === null || valueRaw === '';
  if (nameMissing && valueMissing) return { name: '', value: null };
  if (nameMissing || valueMissing) {
    throw new HttpError(400, 'invalid_request', 'webhook_auth_name and webhook_auth_value must be set together');
  }
  return { name: parseHeaderName(nameRaw), value: parseHeaderValue(valueRaw) };
}

/** Full self profile: the only place a bot sees its own contact details. */
export function presentOwnBot(deps: Deps, bot: Bot): Record<string, unknown> {
  const intake =
    bot.intakeMode === 'allowlist'
      ? { mode: bot.intakeMode, allowlist: bot.intakeAllowlist ?? [] }
      : { mode: bot.intakeMode };
  return {
    id: bot.id,
    display_name: bot.displayName,
    capabilities: bot.capabilities,
    webhook_url: decryptSecret(bot.webhookUrlEnc, deps.config.encryptionKey),
    webhook_auth_name: bot.webhookAuthName === '' ? null : bot.webhookAuthName,
    webhook_auth_value:
      bot.webhookAuthValueEnc === ''
        ? null
        : decryptSecret(bot.webhookAuthValueEnc, deps.config.encryptionKey),
    intake,
    contact_version: bot.contactVersion,
    disabled: bot.disabled,
    token_set_at: iso(bot.tokenSetAt),
    webhook_secret_set_at: iso(bot.webhookSecretSetAt),
    created_at: iso(bot.createdAt),
    updated_at: iso(bot.updatedAt),
  };
}

/** Directory entries never contain contact details (P0-4①). */
export function presentDirectoryBot(bot: Bot): Record<string, unknown> {
  return {
    id: bot.id,
    display_name: bot.displayName,
    capabilities: bot.capabilities,
    status: bot.disabled ? 'disabled' : 'active',
    updated_at: iso(bot.updatedAt),
  };
}

export function presentInquiry(inquiry: Inquiry): Record<string, unknown> {
  return {
    id: inquiry.id,
    from: inquiry.requesterId,
    to: inquiry.targetId,
    status: inquiry.status,
    created_at: iso(inquiry.createdAt),
    expires_at: iso(inquiry.expiresAt),
    delivered_at: inquiry.deliveredAt === null ? null : iso(inquiry.deliveredAt),
    decided_at: inquiry.decidedAt === null ? null : iso(inquiry.decidedAt),
    delivery_error: inquiry.deliveryError,
  };
}
