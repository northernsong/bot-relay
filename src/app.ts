import { Hono } from 'hono';
import type { Context } from 'hono';

import { registerAdminRoutes } from './admin/routes.js';
import { limitAuth } from './client-ip.js';
import type { Deps } from './deps.js';
import { HttpError, isUniqueConstraint } from './errors.js';
import { decryptSecret, encryptSecret, hashToken, newToken } from './secret.js';
import { assertWebhookUrl } from './ssrf.js';
import type { Bot } from './types.js';
import {
  isPlainObject,
  parseBotId,
  parseCapabilities,
  parseDisplayName,
  parseHeaderName,
  parseHeaderValue,
  parseIntake,
  rejectUnknown,
} from './validate.js';
import { VERSION } from './version.js';

const MAX_REQUEST_CHARS = 65_536;
const INVITE_CODE = /^inv_[A-Za-z0-9_-]{16,80}$/;

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
    if (path.startsWith('/admin') || path.startsWith('/register') || path.startsWith('/v1')) {
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
    return c.json({ bot: presentOwnBot(deps, bot), token }, 201);
  });

  registerAdminRoutes(app, deps);
  return app;
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

function presentOwnBot(deps: Deps, bot: Bot): Record<string, unknown> {
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
    webhook_auth_value: bot.webhookAuthValueEnc === '' ? null : decryptSecret(bot.webhookAuthValueEnc, deps.config.encryptionKey),
    intake,
    contact_version: bot.contactVersion,
    disabled: bot.disabled,
    token_set_at: iso(bot.tokenSetAt),
    created_at: iso(bot.createdAt),
    updated_at: iso(bot.updatedAt),
  };
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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
