import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { BlockedAddressError, pinnedFetch } from '../src/ssrf.js';
import { decryptSecret, encryptSecret } from '../src/secret.js';
import { ADMIN, api, expectStatus, makeApp, SECRET } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

describe('encryption key separation', () => {
  it('keeps v1 ciphertext readable and writes v2 when ENCRYPTION_KEY is set', () => {
    const legacy = encryptSecret('hook-secret', SECRET);
    expect(legacy.startsWith('v1:')).toBe(true);
    const keys = { relaySecret: SECRET, encryptionKey: 'dedicated-encryption-key' };
    expect(decryptSecret(legacy, keys)).toBe('hook-secret');
    const next = encryptSecret('hook-secret', keys);
    expect(next.startsWith('v2:')).toBe(true);
    expect(decryptSecret(next, keys)).toBe('hook-secret');
    expect(() => decryptSecret(next, SECRET)).toThrow(/missing encryption key/);
  });

  it('stores new webhook credentials with the dedicated key', async () => {
    const { app, deps } = makeApp({ encryptionKey: 'dedicated-encryption-key' });
    open.push({ close: () => deps.db.close() });
    expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: {
          id: 'alice',
          display_name: 'Alice',
          auth_header_name: 'Authorization',
          auth_header_value: 'Bearer hook-secret',
        },
      }),
      201,
    );
    const stored = deps.db.getBot('alice')?.authHeaderValueEnc ?? '';
    expect(stored.startsWith('v2:')).toBe(true);
    expect(stored).not.toContain('hook-secret');
    expect(decryptSecret(stored, { relaySecret: SECRET, encryptionKey: 'dedicated-encryption-key' })).toBe('Bearer hook-secret');
  });
});

describe('invites, admin session, and disabled bots', () => {
  it('issues a single-use invite, registers without the admin token, and enforces expiry and revoke', async () => {
    const { app, deps } = makeApp({ authRateLimitMax: 20 });
    open.push({ close: () => deps.db.close() });
    let now = 1_700_000_000_000;
    deps.now = () => now;
    const session = await login(app);
    const created = expectStatus(
      await api(app, '/admin/api/invites', {
        body: { max_uses: 1, label: 'alice' },
        headers: session.headers,
      }),
      201,
    );
    expect(created.invite.code).toMatch(/^inv_/);
    expect(created.invite.register_url).toContain('/register?code=');
    const listed = expectStatus(await api(app, '/admin/api/invites', { headers: session.headers }), 200);
    expect(JSON.stringify(listed)).not.toContain(created.invite.code);
    expect(listed.invites[0].prefix).toBe(created.invite.prefix);

    const page = await api(app, `/register?code=${created.invite.code}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.text).toContain(created.invite.code);
    expect(page.text).not.toContain('cdn');

    const registered = expectStatus(
      await api(app, '/register', {
        body: { invite_code: created.invite.code, id: 'alice', display_name: 'Alice' },
      }),
      201,
    );
    expect(registered.token).toMatch(/^rl_/);
    expect(registered.a2a_token).toMatch(/^a2a_/);
    const again = await api(app, '/register', {
      body: { invite_code: created.invite.code, id: 'bob', display_name: 'Bob' },
    });
    expectStatus(again, 403);

    const multi = expectStatus(
      await api(app, '/admin/api/invites', {
        body: { max_uses: 2, ttl_sec: 10 },
        headers: session.headers,
      }),
      201,
    );
    expectStatus(
      await api(app, '/bots', { body: { invite_code: multi.invite.code, id: 'bob', display_name: 'Bob' } }),
      201,
    );
    now += 11_000;
    const expired = await api(app, '/bots', { body: { invite_code: multi.invite.code, id: 'cara', display_name: 'Cara' } });
    expectStatus(expired, 403);

    const fresh = expectStatus(
      await api(app, '/admin/api/invites', { body: { max_uses: 1 }, headers: session.headers }),
      201,
    );
    expectStatus(await api(app, `/admin/api/invites/${fresh.invite.id}/revoke`, { method: 'POST', headers: session.headers }), 200);
    const revoked = await api(app, '/register', {
      body: { invite_code: fresh.invite.code, id: 'cara', display_name: 'Cara' },
    });
    expectStatus(revoked, 403);
  });

  it('requires a session cookie and CSRF token, and disable stops send and receive', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const alice = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'alice', display_name: 'Alice' } }),
      201,
    );
    const bob = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'bob', display_name: 'Bob' } }),
      201,
    );
    expectStatus(await api(app, '/admin/api/bots'), 401);
    const session = await login(app);
    const noCsrf = await api(app, '/admin/api/bots/alice/disable', {
      method: 'POST',
      headers: { cookie: session.cookie },
    });
    expectStatus(noCsrf, 403);

    const bots = expectStatus(await api(app, '/admin/api/bots', { headers: session.headers }), 200);
    expect(JSON.stringify(bots)).not.toContain('webhook_url');
    expect(JSON.stringify(bots)).not.toContain(alice.token);
    expect(bots.bots.find((bot: { id: string }) => bot.id === 'alice').delivery).toBe('inbox');

    expectStatus(await api(app, '/admin/api/bots/alice/disable', { method: 'POST', headers: session.headers }), 200);
    const blocked = await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'hi' } });
    expectStatus(blocked, 403);
    expect(blocked.json.error.code).toBe('bot_disabled');
    const inbound = await api(app, '/messages', { token: bob.token, body: { to: 'alice', body: 'hi' } });
    expectStatus(inbound, 403);

    expectStatus(await api(app, '/admin/api/bots/alice/enable', { method: 'POST', headers: session.headers }), 200);
    expectStatus(await api(app, '/messages', { token: bob.token, body: { to: 'alice', body: 'hi' } }), 202);

    const health = await api(app, '/health');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    const adminPage = await api(app, '/admin', { headers: { cookie: session.cookie } });
    expect(adminPage.headers.get('cache-control')).toBe('no-store');
    expect(adminPage.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('per-IP auth limits', () => {
  it('ignores forwarded headers unless TRUST_PROXY is set', async () => {
    const { app, deps } = makeApp({ authRateLimitMax: 2, trustProxy: false });
    open.push({ close: () => deps.db.close() });
    for (const ip of ['1.1.1.1', '2.2.2.2']) {
      expectStatus(
        await api(app, '/admin/login', {
          body: { token: 'wrong-token-value' },
          headers: { 'x-forwarded-for': ip, accept: 'application/json' },
        }),
        401,
      );
    }
    const limited = await api(app, '/admin/login', {
      body: { token: 'wrong-token-value' },
      headers: { 'cf-connecting-ip': '3.3.3.3', accept: 'application/json' },
    });
    expectStatus(limited, 429);
  });

  it('separates clients by CF-Connecting-IP when TRUST_PROXY is set', async () => {
    const { app, deps } = makeApp({ authRateLimitMax: 1, trustProxy: true });
    open.push({ close: () => deps.db.close() });
    expectStatus(
      await api(app, '/admin/login', {
        body: { token: 'wrong-token-value' },
        headers: { 'cf-connecting-ip': '1.1.1.1', accept: 'application/json' },
      }),
      401,
    );
    expectStatus(
      await api(app, '/admin/login', {
        body: { token: 'wrong-token-value' },
        headers: { 'cf-connecting-ip': '1.1.1.1', accept: 'application/json' },
      }),
      429,
    );
    expectStatus(
      await api(app, '/admin/login', {
        body: { token: ADMIN },
        headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8', accept: 'application/json' },
      }),
      200,
    );
    const secure = await api(app, '/admin/login', {
      body: { token: ADMIN },
      headers: { 'cf-connecting-ip': '4.4.4.4', 'x-forwarded-proto': 'https', accept: 'application/json' },
    });
    expect(secure.headers.get('set-cookie')).toMatch(/Secure/);
    expect(secure.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(secure.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    expectStatus(
      await api(app, '/admin/api/bots', {
        headers: { 'cf-access-authenticated-user-email': 'owner@example.com' },
      }),
      200,
    );
  });
});

describe('DNS rebinding protection', () => {
  it('resolves again at connect time and refuses a private answer', async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.headers.host ?? '');
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    open.push({
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      },
    });
    const port = (server.address() as { port: number }).port;
    let lookups = 0;
    await expect(
      pinnedFetch(`http://rebinding.test:${port}/hook`, { method: 'POST', body: 'x' }, {
        allowHttp: true,
        allowPrivate: false,
        timeoutMs: 1000,
        lookupHost: async () => {
          lookups += 1;
          return ['10.1.2.3'];
        },
      }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
    expect(lookups).toBe(1);
    expect(hits).toEqual([]);

    const ok = await pinnedFetch(`http://hook.test:${port}/hook`, { method: 'POST', body: 'hello' }, {
      allowHttp: true,
      allowPrivate: true,
      timeoutMs: 1000,
      lookupHost: async () => {
        lookups += 1;
        return ['127.0.0.1'];
      },
    });
    expect(ok.status).toBe(200);
    expect(hits).toEqual([`hook.test:${port}`]);
    expect(lookups).toBe(2);
  });
});

async function login(app: Parameters<typeof api>[0]) {
  const res = await api(app, '/admin/login', {
    body: { token: ADMIN },
    headers: { accept: 'application/json' },
  });
  const body = expectStatus(res, 200);
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  const pair = cookie.split(';')[0] ?? '';
  return { csrf: body.csrf as string, cookie: pair, headers: { cookie: pair, 'x-csrf-token': body.csrf as string } };
}
