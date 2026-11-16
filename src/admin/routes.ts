import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Context, Hono } from 'hono';

import { isAdminBearer } from '../auth.js';
import { clientIp, limitAuth, requestIsHttps } from '../client-ip.js';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { rotateRegistryKey } from '../identity.js';
import { decryptSecret, hashToken } from '../secret.js';
import type { Bot } from '../types.js';
import { ADMIN_COOKIE, createSession, readCookie, readSession, signSession } from '../session.js';
import { adminCss, adminJs, dashboardPage, loginPage, registerJs, registerPage } from './pages.js';

export function registerAdminRoutes(app: Hono, deps: Deps): void {
  app.get('/admin/app.css', (c) => c.body(adminCss, 200, { 'content-type': 'text/css; charset=utf-8' }));
  app.get('/admin/app.js', (c) =>
    c.body(adminJs, 200, { 'content-type': 'text/javascript; charset=utf-8' }),
  );
  app.get('/register/app.js', (c) =>
    c.body(registerJs, 200, { 'content-type': 'text/javascript; charset=utf-8' }),
  );

  app.get('/register', (c) => {
    const code = c.req.query('code') ?? '';
    return c.html(registerPage(code.slice(0, 120)));
  });

  app.get('/admin/login', (c) => c.html(loginPage()));

  app.post('/admin/login', async (c) => {
    await limitAuth(deps, c, 'login');
    const body = await readLogin(c);
    if (typeof body.token !== 'string' || !timingEqual(body.token, deps.config.adminToken)) {
      throw new HttpError(401, 'unauthorized', 'Admin token required');
    }
    const session = createSession(deps.now(), deps.config.adminSessionTtlSec);
    setSessionCookie(c, deps, signSession(session, deps.db.getServerSecret()));
    if (wantsJson(c)) return c.json({ ok: true, csrf: session.csrf });
    return c.redirect('/admin', 303);
  });

  app.post('/admin/logout', async (c) => {
    const session = currentSession(c, deps);
    await assertCsrf(c, session);
    c.header('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
    if (wantsJson(c)) return c.json({ ok: true });
    return c.redirect('/admin/login', 303);
  });

  app.get('/admin', (c) => {
    const session = requireSession(c, deps);
    return c.html(dashboardPage(session.csrf));
  });

  app.get('/admin/api/bots', async (c) => {
    await requireAdminAccess(c, deps, false);
    const bots = deps.db.listBots().map((bot) => presentAdminBot(bot));
    return c.json({ bots });
  });

  // Deliberate action with the widest secret exposure in the system (P0-6④):
  // a logged-in session AND its CSRF token are both mandatory, the bearer
  // token alone never unlocks decrypted contact details. Audited every time.
  app.get('/admin/api/bots/:id/credentials', async (c) => {
    const session = requireSession(c, deps);
    await assertCsrf(c, session);
    const id = c.req.param('id') ?? '';
    const bot = deps.db.getBot(id);
    if (!bot) throw new HttpError(404, 'not_found', 'Bot not found');
    deps.db.insertAudit({
      at: deps.now(),
      actor: 'admin',
      action: 'credentials.viewed',
      object: bot.id,
      // Field names only — never the decrypted values themselves (§4.1, §10.3).
      detail: JSON.stringify({ fields: ['webhook_url', 'webhook_auth_name', 'webhook_auth_value'] }),
      source: clientIp(c, deps.config.trustedProxies),
    });
    return c.json({
      bot: {
        id: bot.id,
        display_name: bot.displayName,
        webhook_url: decryptSecret(bot.webhookUrlEnc, deps.config.encryptionKey),
        webhook_auth_name: bot.webhookAuthName === '' ? null : bot.webhookAuthName,
        webhook_auth_value:
          bot.webhookAuthValueEnc === '' ? null : decryptSecret(bot.webhookAuthValueEnc, deps.config.encryptionKey),
        contact_version: bot.contactVersion,
      },
    });
  });

  // Registry signing key rotation (§7.4): the old public key stays in the
  // JWKS for the 1h retirement window, so outstanding tokens keep verifying.
  app.post('/admin/api/registry-keys/rotate', async (c) => {
    await requireAdminAccess(c, deps, true);
    return c.json(rotateRegistryKey(deps));
  });

  app.post('/admin/api/bots/:id/disable', async (c) => {
    await requireAdminAccess(c, deps, true);
    return setDisabled(c, deps, true);
  });

  app.post('/admin/api/bots/:id/enable', async (c) => {
    await requireAdminAccess(c, deps, true);
    return setDisabled(c, deps, false);
  });

  app.delete('/admin/api/bots/:id', async (c) => {
    await requireAdminAccess(c, deps, true);
    const id = c.req.param('id') ?? '';
    if (!deps.db.deleteBot(id)) throw new HttpError(404, 'not_found', 'Bot not found');
    deps.db.insertAudit({
      at: deps.now(),
      actor: 'admin',
      action: 'bot.deleted',
      object: id,
      detail: null,
      source: clientIp(c, deps.config.trustedProxies),
    });
    return c.json({ deleted: true, id });
  });

  app.get('/admin/api/invites', async (c) => {
    await requireAdminAccess(c, deps, false);
    return c.json({
      invites: deps.db.listInvites().map((invite) => ({
        id: invite.id,
        prefix: invite.codePrefix,
        label: invite.label,
        max_uses: invite.maxUses,
        uses: invite.uses,
        expires_at: invite.expiresAt === null ? null : new Date(invite.expiresAt).toISOString(),
        revoked: invite.revokedAt !== null,
        created_at: new Date(invite.createdAt).toISOString(),
      })),
    });
  });

  app.post('/admin/api/invites', async (c) => {
    await requireAdminAccess(c, deps, true);
    const body = await c.req.json().catch(() => {
      throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
    });
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
    }
    const record = body as Record<string, unknown>;
    const maxUses = record.max_uses === undefined ? 1 : Number(record.max_uses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
      throw new HttpError(400, 'invalid_request', 'max_uses must be an integer from 1 to 1000');
    }
    let expiresAt: number | null = null;
    if (record.ttl_sec !== undefined && record.ttl_sec !== null && record.ttl_sec !== '') {
      const ttl = Number(record.ttl_sec);
      if (!Number.isInteger(ttl) || ttl < 0 || ttl > 365 * 24 * 3600) {
        throw new HttpError(400, 'invalid_request', 'ttl_sec must be a non-negative integer');
      }
      expiresAt = deps.now() + ttl * 1000;
    }
    const label = record.label === undefined || record.label === null || record.label === '' ? null : String(record.label).slice(0, 80);
    const code = `inv_${randomBytes(24).toString('base64url')}`;
    const id = deps.db.insertInvite({
      codeHash: hashToken(code),
      codePrefix: code.slice(0, 12),
      label,
      maxUses,
      expiresAt,
      createdAt: deps.now(),
    });
    return c.json({
      invite: {
        id,
        code,
        prefix: code.slice(0, 12),
        max_uses: maxUses,
        expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
        register_url: `${deps.config.publicBaseUrl}/register?code=${encodeURIComponent(code)}`,
      },
    }, 201);
  });

  app.post('/admin/api/invites/:id/revoke', async (c) => {
    await requireAdminAccess(c, deps, true);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'invalid_request', 'Invite id is invalid');
    if (!deps.db.revokeInvite(id, deps.now())) throw new HttpError(404, 'not_found', 'Invite not found');
    return c.json({ revoked: true, id });
  });
}

/** The regular list never includes webhook URLs or secrets (P0-6). */
function presentAdminBot(bot: Bot) {
  return {
    id: bot.id,
    display_name: bot.displayName,
    capabilities: bot.capabilities,
    disabled: bot.disabled,
    created_at: new Date(bot.createdAt).toISOString(),
    updated_at: new Date(bot.updatedAt).toISOString(),
    last_seen_at: bot.lastSeenAt === null ? null : new Date(bot.lastSeenAt).toISOString(),
    token_set_at: new Date(bot.tokenSetAt).toISOString(),
    webhook_secret_set_at: new Date(bot.webhookSecretSetAt).toISOString(),
  };
}

function setDisabled(c: Context, deps: Deps, disabled: boolean) {
  const id = c.req.param('id') ?? '';
  const bot = deps.db.getBot(id);
  if (!bot) throw new HttpError(404, 'not_found', 'Bot not found');
  const now = deps.now();
  deps.db.updateBot(id, { disabled }, now);
  deps.db.insertAudit({
    at: now,
    actor: 'admin',
    action: disabled ? 'bot.disabled' : 'bot.enabled',
    object: id,
    detail: null,
    source: clientIp(c, deps.config.trustedProxies),
  });
  return c.json({ id, disabled });
}

async function requireAdminAccess(c: Context, deps: Deps, mutate: boolean): Promise<void> {
  if (isAdminBearer(deps, c.req.header('authorization'))) return;
  const session = requireSession(c, deps);
  if (mutate) await assertCsrf(c, session);
}

function requireSession(c: Context, deps: Deps) {
  const session = currentSession(c, deps);
  if (!session) throw new HttpError(401, 'unauthorized', 'Admin login required');
  return session;
}

function currentSession(c: Context, deps: Deps) {
  const raw = readCookie(c.req.header('cookie'), ADMIN_COOKIE);
  return readSession(raw ?? undefined, deps.db.getServerSecret(), deps.now());
}

async function assertCsrf(c: Context, session: { csrf: string } | null): Promise<void> {
  if (!session) throw new HttpError(401, 'unauthorized', 'Admin login required');
  let provided = c.req.header('x-csrf-token') ?? '';
  if (!provided && (c.req.header('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
    provided = new URLSearchParams(await c.req.text()).get('csrf') ?? '';
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(session.csrf);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(403, 'csrf', 'CSRF token missing or invalid');
  }
}

function setSessionCookie(c: Context, deps: Deps, value: string): void {
  const secure = requestIsHttps(c, deps.config.trustedProxies) ? '; Secure' : '';
  const maxAge = deps.config.adminSessionTtlSec;
  c.header('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${maxAge}${secure}`);
}

function wantsJson(c: Context): boolean {
  const accept = c.req.header('accept') ?? '';
  const type = c.req.header('content-type') ?? '';
  return accept.includes('application/json') || type.includes('application/json');
}

async function readLogin(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(await c.req.text());
    return { token: params.get('token') ?? '' };
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  return body as Record<string, unknown>;
}

function timingEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
