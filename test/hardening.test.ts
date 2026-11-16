import { afterEach, describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, newToken } from '../src/secret.js';
import { ADMIN, api, createInvite, expectStatus, login, makeApp, registerBot, startServer } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

describe('encryption', () => {
  it('seals with the single ENCRYPTION_KEY-derived key and refuses other versions', () => {
    const enc = encryptSecret('hook-secret', 'dedicated-encryption-key');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('hook-secret');
    expect(decryptSecret(enc, 'dedicated-encryption-key')).toBe('hook-secret');
    expect(() => decryptSecret(enc, 'different-key-entirely-0123456789')).toThrow();
    expect(() => decryptSecret('v2:whatever', 'dedicated-encryption-key')).toThrow(/unknown secret version/);
  });

  it('stores webhook contact details encrypted at rest', async () => {
    const hookUrl = 'http://127.0.0.1:9/hook/secret-path';
    const secret = 'super-secret-webhook-key';
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const invite = await createInvite(app, session);
    const created = expectStatus(
      await api(app, '/v1/register', {
        body: {
          invite_code: invite.code,
          id: 'alice',
          display_name: 'Alice',
          webhook_url: hookUrl,
          webhook_auth_name: 'Authorization',
          webhook_auth_value: `Bearer ${secret}`,
        },
      }),
      201,
    );
    expect(created.token).toMatch(/^br_/);
    expect(newToken()).toMatch(/^br_/);
    const stored = deps.db.getBot('alice');
    expect(stored?.webhookUrlEnc).toBeTruthy();
    expect(stored?.webhookAuthValueEnc).toBeTruthy();
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain(hookUrl);
    expect(raw).not.toContain(secret);
    expect(decryptSecret(stored!.webhookUrlEnc, deps.config.encryptionKey)).toBe(hookUrl);
    expect(decryptSecret(stored!.webhookAuthValueEnc, deps.config.encryptionKey)).toBe(`Bearer ${secret}`);
  });
});

describe('invite lifecycle', () => {
  it('issues single-use invites and enforces use limits, expiry, and revocation', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    let now = 1_700_000_000_000;
    deps.now = () => now;
    const session = await login(app);

    const created = expectStatus(
      await api(app, '/admin/api/invites', { body: { max_uses: 1, label: 'alice' }, headers: session.headers }),
      201,
    );
    expect(created.invite.code).toMatch(/^inv_/);
    expect(created.invite.register_url).toBe(`https://relay.example.test/register?code=${encodeURIComponent(created.invite.code)}`);
    const listed = expectStatus(await api(app, '/admin/api/invites', { headers: session.headers }), 200);
    expect(JSON.stringify(listed)).not.toContain(created.invite.code);
    expect(listed.invites[0].prefix).toBe(created.invite.prefix);

    const page = await api(app, `/register?code=${created.invite.code}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.text).toContain(created.invite.code);
    expect(page.text).not.toContain('cdn');

    const token = await registerBot(app, { id: 'alice', invite: created.invite.code });    expect(token).toMatch(/^br_/);
    const again = await api(app, '/v1/register', {
      body: { invite_code: created.invite.code, id: 'bob', display_name: 'Bob', webhook_url: 'http://127.0.0.1:9/hook' },
    });
    expectStatus(again, 403);
    expect(again.json.error.code).toBe('invite_invalid');

    const multi = await createInvite(app, session, { max_uses: 2, ttl_sec: 10 });
    await registerBot(app, { id: 'bob', invite: multi.code });
    now += 11_000;
    const expired = await api(app, '/v1/register', {
      body: { invite_code: multi.code, id: 'cara', display_name: 'Cara', webhook_url: 'http://127.0.0.1:9/hook' },
    });
    expectStatus(expired, 403);
    expect(expired.json.error.code).toBe('invite_invalid');

    const fresh = await createInvite(app, session);
    expectStatus(
      await api(app, `/admin/api/invites/${fresh.id}/revoke`, { method: 'POST', headers: session.headers }),
      200,
    );
    const revoked = await api(app, '/v1/register', {
      body: { invite_code: fresh.code, id: 'cara', display_name: 'Cara', webhook_url: 'http://127.0.0.1:9/hook' },
    });
    expectStatus(revoked, 403);
    expect(revoked.json.error.code).toBe('invite_invalid');

    // Unknown and malformed codes share the same error as used-up ones.
    for (const code of ['inv_totally-made-up-code-1234', 'not-invite', '']) {
      const bad = await api(app, '/v1/register', {
        body: { invite_code: code, id: 'dave', display_name: 'Dave', webhook_url: 'http://127.0.0.1:9/hook' },
      });
      expectStatus(bad, 403);
      expect(bad.json.error.code).toBe('invite_invalid');
    }
  });
});

describe('admin console', () => {
  it('requires a session cookie, enforces CSRF, and never lists contact details', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const invite = await createInvite(app, session);
    await registerBot(app, {
      id: 'alice',
      invite: invite.code,
      extra: { webhook_url: 'http://127.0.0.1:9/hook/secret', webhook_auth_name: 'Authorization', webhook_auth_value: 'Bearer super-secret' },
    });

    expectStatus(await api(app, '/admin/api/bots'), 401);
    const noCsrf = await api(app, '/admin/api/bots/alice/disable', {
      method: 'POST',
      headers: { cookie: session.cookie },
    });
    expectStatus(noCsrf, 403);
    expect(noCsrf.json.error.code).toBe('csrf');

    const bearer = expectStatus(await api(app, '/admin/api/bots', { token: ADMIN }), 200);
    const listed = bearer.bots.find((bot: { id: string }) => bot.id === 'alice');
    expect(listed.disabled).toBe(false);
    expect(listed.token_set_at).toBeTruthy();
    expect(listed.webhook_secret_set_at).toBeTruthy();
    const serialized = JSON.stringify(bearer);
    expect(serialized).not.toContain('webhook_url');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('/hook/secret');
    expect(listed).not.toHaveProperty('token_hash');

    expectStatus(await api(app, '/admin/api/bots/alice/disable', { method: 'POST', headers: session.headers }), 200);
    const disabledList = expectStatus(await api(app, '/admin/api/bots', { headers: session.headers }), 200);
    expect(disabledList.bots.find((bot: { id: string }) => bot.id === 'alice').disabled).toBe(true);
    expectStatus(await api(app, '/admin/api/bots/alice/enable', { method: 'POST', headers: session.headers }), 200);
    const enabledList = expectStatus(await api(app, '/admin/api/bots', { headers: session.headers }), 200);
    expect(enabledList.bots.find((bot: { id: string }) => bot.id === 'alice').disabled).toBe(false);

    expectStatus(await api(app, '/admin/api/bots/alice', { method: 'DELETE', headers: session.headers }), 200);
    expectStatus(await api(app, '/admin/api/bots/alice', { method: 'DELETE', headers: session.headers }), 404);
    expect(deps.db.getBot('alice')).toBeUndefined();

    // Cloudflare Access headers no longer grant admin access (N8).
    expectStatus(
      await api(app, '/admin/api/bots', { headers: { 'cf-access-authenticated-user-email': 'owner@example.com' } }),
      401,
    );
  });

  it('signs sessions with the stored server secret', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const first = await login(app);
    expect(deps.db.getServerSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(deps.db.getServerSecret()).toBe(deps.db.getServerSecret());
    const again = expectStatus(await api(app, '/admin/api/bots', { headers: first.headers }), 200);
    expect(again.bots).toEqual([]);
  });
});

describe('source identification', () => {
  it('ignores forwarded headers when the peer is not trusted', async () => {
    const { app, deps } = makeApp({ loginRatePerMin: 2, trustedProxies: ['10.0.0.0/8'] });
    open.push({ close: () => deps.db.close() });
    const served = await startServer(app);
    open.push(served);
    for (const ip of ['1.1.1.1', '2.2.2.2']) {
      const res = await fetch(`${served.url}/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ token: 'wrong-token-value' }),
      });
      expect(res.status).toBe(401);
    }
    const limited = await fetch(`${served.url}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'cf-connecting-ip': '3.3.3.3' },
      body: JSON.stringify({ token: 'wrong-token-value' }),
    });
    expect(limited.status).toBe(429);
  });

  it('trusts CF-Connecting-IP only from a trusted loopback peer', async () => {
    const { app, deps } = makeApp({ loginRatePerMin: 1 });
    open.push({ close: () => deps.db.close() });
    const served = await startServer(app);
    open.push(served);

    // Peer 127.0.0.1 is trusted: each CF-Connecting-IP gets its own bucket.
    const one = await fetch(`${served.url}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'cf-connecting-ip': '1.1.1.1' },
      body: JSON.stringify({ token: 'wrong-token-value' }),
    });
    expect(one.status).toBe(401);
    const oneAgain = await fetch(`${served.url}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'cf-connecting-ip': '1.1.1.1' },
      body: JSON.stringify({ token: 'wrong-token-value' }),
    });
    expect(oneAgain.status).toBe(429);
    const other = await fetch(`${served.url}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'cf-connecting-ip': '2.2.2.2' },
      body: JSON.stringify({ token: ADMIN }),
    });
    expect(other.status).toBe(200);

    // x-forwarded-for is never used for identification.
    const forwarded = await fetch(`${served.url}/admin/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-forwarded-for': '9.9.9.9, 8.8.8.8',
      },
      body: JSON.stringify({ token: ADMIN }),
    });
    expect(forwarded.status).toBe(200);

    // x-forwarded-proto from the trusted peer marks the session cookie Secure.
    const secure = await fetch(`${served.url}/admin/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'cf-connecting-ip': '4.4.4.4',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ token: ADMIN }),
    });
    expect(secure.status).toBe(200);
    expect(secure.headers.get('set-cookie')).toMatch(/Secure/);
    expect(secure.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(secure.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
  });
});

describe('health and headers', () => {
  it('serves /health with security headers while the store is up', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const health = await api(app, '/health');
    expectStatus(health, 200);
    expect(health.json.ok).toBe(true);
    expect(health.json.db).toBe('ok');
    expect(typeof health.json.version).toBe('string');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    expect(health.headers.get('referrer-policy')).toBe('no-referrer');

    const session = await login(app);
    const adminPage = await api(app, '/admin', { headers: { cookie: session.cookie } });
    expect(adminPage.status).toBe(200);
    expect(adminPage.headers.get('cache-control')).toBe('no-store');
    expect(adminPage.headers.get('content-security-policy')).toContain("default-src 'none'");

    const notFound = await api(app, '/nope');
    expectStatus(notFound, 404);
    expect(notFound.json.error.code).toBe('not_found');

    const badJson = await api(app, '/v1/register', {
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expectStatus(badJson, 400);
  });
});
