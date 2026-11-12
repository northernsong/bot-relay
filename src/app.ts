import { Hono } from 'hono';
import type { Context } from 'hono';

import { requireAdmin, requireBot } from './auth.js';
import type { Deps } from './deps.js';
import { HttpError, isUniqueConstraint } from './errors.js';
import { presentMessage, presentOwnBot, presentPublicBot } from './present.js';
import { encryptSecret, newToken, hashToken } from './secret.js';
import { sendMessage } from './send.js';
import { assertWebhookUrl } from './ssrf.js';
import type { Bot, BotPatch, SendInput } from './types.js';
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
    requireAdmin(deps, c.req.header('authorization'));
    const body = await readJsonObject(c);
    rejectUnknown(body, ['id', 'display_name', 'webhook_url', 'auth_header_name', 'auth_header_value', 'allowlist']);
    const id = parseBotId(body.id);
    const displayName = parseDisplayName(body.display_name);
    const webhookUrl = await parseOptionalWebhook(deps, body.webhook_url);
    const allowlist = parseAllowlist(body.allowlist);
    const auth = parseCreateAuth(body.auth_header_name, body.auth_header_value);
    const token = newToken();
    const now = deps.now();
    try {
      deps.db.insertBot({
        id,
        displayName,
        webhookUrl,
        authHeaderName: auth.name,
        authHeaderValueEnc: auth.value ? encryptSecret(auth.value, deps.config.relaySecret) : null,
        tokenHash: hashToken(token),
        allowlist,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (isUniqueConstraint(err, 'bots.id')) {
        throw new HttpError(409, 'already_registered', `Bot id "${id}" is already registered`);
      }
      throw err;
    }
    const bot = deps.db.getBot(id);
    if (!bot) throw new HttpError(500, 'internal', 'Bot disappeared after insert');
    return c.json(presentOwnBot(bot, token), 201);
  });

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
    ]);
    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'invalid_request', 'No fields to update');
    }
    const patch: BotPatch = {};
    if ('display_name' in body) patch.displayName = parseDisplayName(body.display_name);
    if ('webhook_url' in body) patch.webhookUrl = await parseOptionalWebhook(deps, body.webhook_url);
    if ('allowlist' in body) patch.allowlist = parseAllowlist(body.allowlist);
    applyAuthPatch(deps, bot, body, patch);

    let token: string | undefined;
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
    return c.json(presentOwnBot(updated, token));
  });

  app.delete('/bots/me', (c) => {
    const bot = requireBot(deps, c.req.header('authorization'));
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
    if (!deps.db.deleteBot(id)) throw new HttpError(404, 'not_found', 'Bot not found');
    return c.json({ deleted: true, id });
  });

  app.post('/messages', async (c) => {
    const sender = requireBot(deps, c.req.header('authorization'));
    const body = await readJsonObject(c);
    rejectUnknown(body, ['to', 'body', 'thread_id', 'reply_to', 'metadata']);
    const input: SendInput = {
      to: parseBotId(body.to, 'to'),
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

  return app;
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
  if (valueAction === 'set') patch.authHeaderValueEnc = encryptSecret(newValue, deps.config.relaySecret);
  if (valueAction === 'clear') patch.authHeaderValueEnc = null;
}
