import { Hono } from 'hono';
import type { Context } from 'hono';

import { loadRemoteAgent } from './a2a/card.js';
import { A2A_GATEWAY_ID } from './a2a/constants.js';
import { registerA2aRoutes } from './a2a/routes.js';
import { registerAdminRoutes } from './admin/routes.js';
import { isAdminBearer, requireAdmin, requireBot } from './auth.js';
import { limitAuth } from './client-ip.js';
import type { Deps } from './deps.js';
import { HttpError, isUniqueConstraint } from './errors.js';
import { presentMessage, presentOwnBot, presentPublicBot } from './present.js';
import { encryptSecret, hashToken, newA2aToken, newToken, type CryptoKeys } from './secret.js';
import { sendMessage } from './send.js';
import { assertWebhookUrl } from './ssrf.js';
import type { Bot, BotKind, BotPatch, SendInput } from './types.js';
import {
  isPlainObject,
  parseAllowlist,
  parseBotId,
  parseDisplayName,
  parseHeaderName,
  parseHeaderValue,
  parseIdempotencyKey,
  parseLimit,
  parseMessageBody,
  parseMetadata,
  parseReplyTo,
  parseThreadId,
  rejectUnknown,
} from './validate.js';
import { VERSION } from './version.js';

const MAX_REQUEST_CHARS = 65_536;

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    const type = c.res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      c.header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
    const path = c.req.path;
    if (path.startsWith('/admin') || path.startsWith('/register') || path.startsWith('/bots') || path.startsWith('/messages') || path.startsWith('/inbox')) {
      c.header('Cache-Control', 'no-store');
    }
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (err.headers) {
        for (const [key, value] of Object.entries(err.headers)) c.header(key, value);
      }
      return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
    }
    const message = err instanceof Error ? err.message : 'error';
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', error: message }));
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));

  app.get('/', (c) => c.json({ name: 'bot-relay', version: VERSION, health: '/health' }));

  app.get('/health', (c) => {
    if (!deps.db.ping()) {
      return c.json({ ok: false, version: VERSION, db: 'error' }, 503);
    }
    return c.json({ ok: true, version: VERSION, db: 'ok' });
  });

  app.post('/bots', async (c) => {
    await limitAuth(deps, c, 'register');
    const body = await readJsonObject(c);
    const inviteHash = inviteHashForRegistration(deps, c.req.header('authorization'), body.invite_code);
    return c.json(await performRegistration(deps, body, inviteHash), 201);
  });

  app.post('/register', async (c) => {
    await limitAuth(deps, c, 'register');
    const body = await readFlexibleObject(c);
    if (typeof body.invite_code !== 'string') {
      throw new HttpError(403, 'invite_invalid', 'Invite code required');
    }
    const created = await performRegistration(deps, body, hashToken(body.invite_code.trim()));
    return c.json(created, 201);
  });

async function performRegistration(deps: Deps, body: Record<string, unknown>, inviteHash: string | null): Promise<Record<string, unknown>> {
    rejectUnknown(body, [
      'id',
      'display_name',
      'webhook_url',
      'auth_header_name',
      'auth_header_value',
      'allowlist',
      'a2a_card_url',
      'accept_a2a',
      'invite_code',
    ]);
    const id = parseBotId(body.id);
    const displayName = parseDisplayName(body.display_name);
    const allowlist = parseAllowlist(body.allowlist);
    const peer = body.a2a_card_url !== undefined && body.a2a_card_url !== null;
    if (peer && body.webhook_url) {
      throw new HttpError(400, 'invalid_request', 'Set webhook_url or a2a_card_url, not both');
    }
    let kind: BotKind = 'relay';
    let webhookUrl = await parseOptionalWebhook(deps, peer ? undefined : body.webhook_url);
    let auth = peer ? { name: null as string | null, value: null as string | null } : parseCreateAuth(body.auth_header_name, body.auth_header_value);
    let a2aCardUrl: string | null = null;
    let a2aEndpoint: string | null = null;
    let a2aAuthIn: 'header' | 'query' | null = null;
    let a2aTenant: string | null = null;
    let acceptA2a = true;
    let a2aToken: string | undefined;
    if (peer) {
      if ('accept_a2a' in body && body.accept_a2a !== false) {
        throw new HttpError(400, 'invalid_request', 'External A2A agents are not hosted on this relay');
      }
      const remote = await loadRemoteAgent(deps, body.a2a_card_url, body.auth_header_name, body.auth_header_value);
      kind = 'a2a';
      webhookUrl = null;
      acceptA2a = false;
      a2aCardUrl = remote.cardUrl;
      a2aEndpoint = remote.endpoint;
      a2aAuthIn = remote.authIn;
      a2aTenant = remote.tenant;
      auth = { name: remote.authName, value: remote.authValue };
    } else if ('accept_a2a' in body) {
      acceptA2a = parseBool(body.accept_a2a, 'accept_a2a');
    }
    if (acceptA2a) a2aToken = newA2aToken();
    const token = newToken();
    const now = deps.now();
    try {
      deps.db.transaction(() => {
      if (inviteHash && !deps.db.consumeInvite(inviteHash, now)) {
        throw new HttpError(403, 'invite_invalid', 'Invite code is invalid, expired, revoked, or used up');
      }
      deps.db.insertBot({
        id,
        displayName,
        webhookUrl,
        authHeaderName: auth.name,
        authHeaderValueEnc: auth.value ? encryptSecret(auth.value, cryptoKeys(deps)) : null,
        tokenHash: hashToken(token),
        allowlist,
        kind,
        a2aCardUrl,
        a2aEndpoint,
        a2aInboundTokenHash: a2aToken ? hashToken(a2aToken) : null,
        acceptA2a,
        a2aAuthIn,
        a2aTenant,
        createdAt: now,
        updatedAt: now,
      });
      });
    } catch (err) {
      if (isUniqueConstraint(err, 'bots.id')) {
        throw new HttpError(409, 'already_registered', `Bot id "${id}" is already registered`);
      }
      throw err;
    }
    const bot = deps.db.getBot(id);
    if (!bot) throw new HttpError(500, 'internal', 'Bot disappeared after insert');
    return presentOwnBot(bot, token, a2aToken);
}

  app.get('/bots/me', (c) => {
    const bot = requireBot(deps, c.req.header('authorization'));
    return c.json(presentOwnBot(bot));
  });

  app.patch('/bots/me', async (c) => {
    const bot = requireBot(deps, c.req.header('authorization'));
    const body = await readJsonObject(c);
    rejectUnknown(body, [
      'display_name',
      'webhook_url',
      'auth_header_name',
      'auth_header_value',
      'allowlist',
      'rotate_token',
      'accept_a2a',
      'rotate_a2a_token',
    ]);
    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'invalid_request', 'No fields to update');
    }
    const patch: BotPatch = {};
    if ('display_name' in body) patch.displayName = parseDisplayName(body.display_name);
    if ('webhook_url' in body) {
      if (bot.kind === 'a2a') throw new HttpError(400, 'invalid_request', 'External A2A agents do not use webhook_url');
      patch.webhookUrl = await parseOptionalWebhook(deps, body.webhook_url);
    }
    if ('accept_a2a' in body) {
      if (bot.kind === 'a2a') throw new HttpError(400, 'invalid_request', 'External A2A agents are not hosted on this relay');
      patch.acceptA2a = parseBool(body.accept_a2a, 'accept_a2a');
    }
    if ('allowlist' in body) patch.allowlist = parseAllowlist(body.allowlist);
    applyAuthPatch(deps, bot, body, patch);

    let token: string | undefined;
    let a2aToken: string | undefined;
    if ('rotate_a2a_token' in body) {
      if (body.rotate_a2a_token !== true && body.rotate_a2a_token !== false) {
        throw new HttpError(400, 'invalid_request', 'rotate_a2a_token must be a boolean');
      }
      if (body.rotate_a2a_token === true) {
        if (bot.kind !== 'relay') throw new HttpError(400, 'invalid_request', 'Only hosted bots have an A2A token');
        a2aToken = newA2aToken();
        patch.a2aInboundTokenHash = hashToken(a2aToken);
      }
    }
    if (patch.acceptA2a === true && !bot.a2aInboundTokenHash && !a2aToken) {
      a2aToken = newA2aToken();
      patch.a2aInboundTokenHash = hashToken(a2aToken);
    }
    if ('rotate_token' in body) {
      if (body.rotate_token !== true && body.rotate_token !== false) {
        throw new HttpError(400, 'invalid_request', 'rotate_token must be a boolean');
      }
      if (body.rotate_token === true) {
        token = newToken();
        patch.tokenHash = hashToken(token);
      }
    }

    deps.db.updateBot(bot.id, patch, deps.now());
    const updated = deps.db.getBot(bot.id);
    if (!updated) throw new HttpError(500, 'internal', 'Bot disappeared after update');
    return c.json(presentOwnBot(updated, token, a2aToken));
  });

  app.delete('/bots/me', (c) => {
    const bot = requireBot(deps, c.req.header('authorization'));
    if (bot.id === A2A_GATEWAY_ID) throw new HttpError(400, 'invalid_request', 'The A2A gateway cannot be deleted');
    deps.db.deleteBot(bot.id);
    return c.json({ deleted: true, id: bot.id });
  });

  app.get('/bots/:id', (c) => {
    requireBot(deps, c.req.header('authorization'));
    const id = c.req.param('id');
    const bot = deps.db.getBot(id);
    if (!bot) throw new HttpError(404, 'not_found', 'Bot not found');
    return c.json(presentPublicBot(bot));
  });

  app.delete('/bots/:id', (c) => {
    requireAdmin(deps, c.req.header('authorization'));
    const id = c.req.param('id');
    if (id === A2A_GATEWAY_ID) throw new HttpError(400, 'invalid_request', 'The A2A gateway cannot be deleted');
    if (!deps.db.deleteBot(id)) throw new HttpError(404, 'not_found', 'Bot not found');
    return c.json({ deleted: true, id });
  });

  app.post('/messages', async (c) => {
    const sender = requireBot(deps, c.req.header('authorization'));
    const body = await readJsonObject(c);
    rejectUnknown(body, ['to', 'body', 'thread_id', 'reply_to', 'metadata']);
    const input: SendInput = {
      to: body.to === A2A_GATEWAY_ID ? A2A_GATEWAY_ID : parseBotId(body.to, 'to'),
      body: parseMessageBody(body.body, deps.config.bodyMaxChars),
      threadId: parseThreadId(body.thread_id),
      replyTo: parseReplyTo(body.reply_to),
      metadata: parseMetadata(body.metadata, deps.config.metadataMaxChars),
    };
    const idemHeader = c.req.header('idempotency-key');
    const idemKey = idemHeader === undefined ? null : parseIdempotencyKey(idemHeader);
    const result = await sendMessage(deps, sender, input, idemKey);
    if (result.replayed) c.header('idempotent-replayed', 'true');
    const attempts = deps.db.listAttempts(result.message.id);
    return c.json(presentMessage(result.message, deps.config.maxHops, attempts), result.replayed ? 200 : 202);
  });

  app.get('/messages/:id', (c) => {
    const bot = requireBot(deps, c.req.header('authorization'));
    const message = deps.db.getMessage(c.req.param('id'));
    if (!message || (message.fromId !== bot.id && message.toId !== bot.id)) {
      throw new HttpError(404, 'not_found', 'Message not found');
    }
    return c.json(presentMessage(message, deps.config.maxHops, deps.db.listAttempts(message.id)));
  });

  app.get('/inbox', (c) => {
    const bot = requireBot(deps, c.req.header('authorization'));
    const limit = parseLimit(c.req.query('limit'));
    const messages = deps.db.listInbox(bot.id, limit).map((message) => presentMessage(message, deps.config.maxHops));
    return c.json({ messages });
  });

  app.post('/inbox/ack', async (c) => {
    const bot = requireBot(deps, c.req.header('authorization'));
    const body = await readJsonObject(c);
    rejectUnknown(body, ['ids']);
    if (!Array.isArray(body.ids)) throw new HttpError(400, 'invalid_request', 'ids must be an array of message ids');
    if (body.ids.length > 100) throw new HttpError(400, 'invalid_request', 'ids cannot contain more than 100 entries');
    const ids: string[] = [];
    for (const id of body.ids) {
      if (typeof id !== 'string' || !/^msg_[A-Za-z0-9_-]{10,80}$/.test(id)) {
        throw new HttpError(400, 'invalid_request', 'ids must be relay message ids');
      }
      ids.push(id);
    }
    const acked = deps.db.ackInbox(bot.id, ids, deps.now());
    return c.json({ acked });
  });

  registerAdminRoutes(app, deps);
  registerA2aRoutes(app, deps);
  return app;
}

function inviteHashForRegistration(deps: Deps, authorization: string | undefined, inviteCode: unknown): string | null {
  if (isAdminBearer(deps, authorization)) return null;
  if (typeof inviteCode !== 'string' || !/^inv_[A-Za-z0-9_-]{16,80}$/.test(inviteCode.trim())) {
    throw new HttpError(401, 'unauthorized', 'Admin token or invite code required', { 'www-authenticate': 'Bearer' });
  }
  return hashToken(inviteCode.trim());
}

async function readFlexibleObject(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType === 'application/x-www-form-urlencoded') {
    const raw = await c.req.text();
    const params = new URLSearchParams(raw);
    const body: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) body[key] = value;
    return body;
  }
  return readJsonObject(c);
}

function cryptoKeys(deps: Deps): CryptoKeys {
  return { relaySecret: deps.config.relaySecret, encryptionKey: deps.config.encryptionKey };
}

function parseBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_request', `${field} must be a boolean`);
  return value;
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type');
  if (!contentType || contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const advertised = c.req.header('content-length');
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > MAX_REQUEST_CHARS) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  const raw = await c.req.text();
  if (raw.length > MAX_REQUEST_CHARS) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  if (!raw.trim()) throw new HttpError(400, 'invalid_json', 'Request body is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  return parsed;
}

async function parseOptionalWebhook(deps: Deps, value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url must be an https URL');
  }
  return assertWebhookUrl(value, {
    allowHttp: deps.config.allowHttpWebhooks,
    allowPrivate: deps.config.allowPrivateWebhooks,
    lookupHost: deps.lookup,
  });
}

function parseCreateAuth(nameRaw: unknown, valueRaw: unknown): { name: string | null; value: string | null } {
  const nameMissing = nameRaw === undefined || nameRaw === null;
  const valueMissing = valueRaw === undefined || valueRaw === null || valueRaw === '';
  if (nameMissing && valueMissing) return { name: null, value: null };
  if (nameMissing || valueMissing) {
    throw new HttpError(400, 'invalid_request', 'auth_header_name and auth_header_value must be set together');
  }
  return { name: parseHeaderName(nameRaw), value: parseHeaderValue(valueRaw) };
}

function applyAuthPatch(deps: Deps, bot: Bot, body: Record<string, unknown>, patch: BotPatch): void {
  const nameIn = 'auth_header_name' in body;
  const valueIn = 'auth_header_value' in body;
  if (!nameIn && !valueIn) return;

  let name = bot.authHeaderName;
  if (nameIn) {
    if (body.auth_header_name === null) name = null;
    else name = parseHeaderName(body.auth_header_name);
  }
  if (name === null && valueIn && body.auth_header_value) {
    throw new HttpError(400, 'invalid_request', 'Cannot set auth_header_value while clearing auth_header_name');
  }

  let valueAction: 'keep' | 'clear' | 'set' = 'keep';
  let newValue = '';
  if (valueIn) {
    if (body.auth_header_value === null || body.auth_header_value === '') valueAction = 'clear';
    else {
      valueAction = 'set';
      newValue = parseHeaderValue(body.auth_header_value);
    }
  }
  if (name === null) valueAction = 'clear';

  if (name && valueAction === 'clear') {
    throw new HttpError(400, 'invalid_request', 'auth_header_name requires auth_header_value');
  }
  if (name && valueAction === 'keep' && !bot.authHeaderValueEnc) {
    throw new HttpError(400, 'invalid_request', 'auth_header_name requires auth_header_value');
  }
  if (!name && valueAction === 'set') {
    throw new HttpError(400, 'invalid_request', 'auth_header_value requires auth_header_name');
  }

  patch.authHeaderName = name;
  if (valueAction === 'set') patch.authHeaderValueEnc = encryptSecret(newValue, cryptoKeys(deps));
  if (valueAction === 'clear') patch.authHeaderValueEnc = null;
}
