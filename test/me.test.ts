import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { api, createInvite, expectStatus, login, makeApp, registerBot } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

async function newBot(app: Hono, id: string, extra: Record<string, unknown> = {}): Promise<string> {
  const session = await login(app);
  const invite = await createInvite(app, session);
  return registerBot(app, { id, invite: invite.code, extra });
}

describe('GET /v1/me', () => {
  it('returns the full own profile including contact details and intake', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const token = await newBot(app, 'alice', {
      webhook_auth_name: 'Authorization',
      webhook_auth_value: 'Bearer alice-secret',
      capabilities: 'weather reports',
    });

    expectStatus(await api(app, '/v1/me'), 401);
    expectStatus(await api(app, '/v1/me', { token: 'br_not-a-real-token' }), 401);

    const me = expectStatus(await api(app, '/v1/me', { token }), 200);
    expect(me.bot.id).toBe('alice');
    expect(me.bot.display_name).toBe('alice');
    expect(me.bot.capabilities).toBe('weather reports');
    expect(me.bot.webhook_url).toBe('http://127.0.0.1:9/hook');
    expect(me.bot.webhook_auth_name).toBe('Authorization');
    expect(me.bot.webhook_auth_value).toBe('Bearer alice-secret');
    expect(me.bot.intake).toEqual({ mode: 'open' });
    expect(me.bot.contact_version).toBe(1);
    expect(me.bot.disabled).toBe(false);
    expect(me.bot.token_set_at).toBeTruthy();
    expect(me.bot.webhook_secret_set_at).toBeTruthy();
    // Existing bots can rediscover the direct-call rule without the guide.
    expect(me.direct_call.required).toBe(true);
    expect(me.direct_call.header).toBe('X-Bot-Relay-Identity');
    expect(me.direct_call.get_token).toContain('https://relay.example.test/v1/identity-token');
    expect(me.direct_call.receiver_check).toContain('https://relay.example.test/.well-known/bot-relay/jwks.json');
    expect(me.direct_call.get_token).toContain('"aud":"<peer bot id>"');
    expect(me.direct_call.receiver_check).toContain('aud=<your own bot id>');
    expect(JSON.stringify(me.direct_call)).not.toContain('alice-secret');
    expect(JSON.stringify(me.direct_call)).not.toContain(token);
  });

  it('lets a disabled bot see its own disabled status (P0-2④)', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const token = await newBot(app, 'alice');
    const session = await login(app);
    expectStatus(await api(app, '/admin/api/bots/alice/disable', { method: 'POST', headers: session.headers }), 200);

    const me = expectStatus(await api(app, '/v1/me', { token }), 200);
    expect(me.bot.disabled).toBe(true);

    // Business endpoints other than GET /v1/me reject the disabled bot.
    const patched = await api(app, '/v1/me', { method: 'PATCH', token, body: { display_name: 'New' } });
    expectStatus(patched, 403);
    expect(patched.json.error.code).toBe('bot_disabled');
    expectStatus(await api(app, '/v1/directory', { token }), 403);
    expectStatus(await api(app, '/v1/inquiries', { token, body: { to: 'bob' } }), 403);
    expect((await api(app, '/v1/directory', { token })).json.error.code).toBe('bot_disabled');
  });
});

describe('PATCH /v1/me', () => {
  it('updates profile fields without bumping contact_version', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const token = await newBot(app, 'alice');

    const patched = expectStatus(
      await api(app, '/v1/me', { method: 'PATCH', token, body: { display_name: 'Alice', capabilities: ' scheduling ' } }),
      200,
    );
    expect(patched.bot.display_name).toBe('Alice');
    expect(patched.bot.capabilities).toBe('scheduling');
    expect(patched.bot.contact_version).toBe(1);
  });

  it('bumps contact_version when webhook details change and rotates the secret timestamp', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const token = await newBot(app, 'alice', {
      webhook_auth_name: 'Authorization',
      webhook_auth_value: 'Bearer old-secret',
    });

    const rotated = expectStatus(
      await api(app, '/v1/me', { method: 'PATCH', token, body: { webhook_auth_value: 'Bearer new-secret' } }),
      200,
    );
    expect(rotated.bot.webhook_auth_value).toBe('Bearer new-secret');
    expect(rotated.bot.contact_version).toBe(2);

    const moved = expectStatus(
      await api(app, '/v1/me', { method: 'PATCH', token, body: { webhook_url: 'http://127.0.0.1:10/hook' } }),
      200,
    );
    expect(moved.bot.webhook_url).toBe('http://127.0.0.1:10/hook');
    expect(moved.bot.contact_version).toBe(3);

    // The old secret is gone from the stored row (only the new ciphertext remains).
    const stored = deps.db.getBot('alice');
    expect(JSON.stringify(stored)).not.toContain('old-secret');
  });

  it('uses the same webhook validation as registration', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const token = await newBot(app, 'alice');

    const bad = await api(app, '/v1/me', { method: 'PATCH', token, body: { webhook_url: 'ftp://example.com/hook' } });
    expectStatus(bad, 400);
    expect(bad.json.error.code).toBe('invalid_webhook');

    expectStatus(await api(app, '/v1/me', { method: 'PATCH', token, body: { webhook_auth_name: 'Authorization' } }), 400);
    expectStatus(
      await api(app, '/v1/me', { method: 'PATCH', token, body: { webhook_auth_name: 'Content-Type', webhook_auth_value: 'x' } }),
      400,
    );
    expectStatus(await api(app, '/v1/me', { method: 'PATCH', token, body: { surprise: 1 } }), 400);
    expectStatus(await api(app, '/v1/me', { method: 'PATCH', token, body: { webhook_url: null } }), 400);
  });

  it('clears the auth pair together and updates intake', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const token = await newBot(app, 'alice', {
      webhook_auth_name: 'Authorization',
      webhook_auth_value: 'Bearer soon-gone',
    });

    const cleared = expectStatus(
      await api(app, '/v1/me', {
        method: 'PATCH',
        token,
        body: { webhook_auth_name: null, webhook_auth_value: null, intake: { mode: 'allowlist', allowlist: ['bob'] } },
      }),
      200,
    );
    expect(cleared.bot.webhook_auth_name).toBeNull();
    expect(cleared.bot.webhook_auth_value).toBeNull();
    expect(cleared.bot.intake).toEqual({ mode: 'allowlist', allowlist: ['bob'] });
  });
});

describe('token lifecycle', () => {
  it('rotates: the new token works and the old one dies immediately', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const token = await newBot(app, 'alice');

    const rotated = expectStatus(await api(app, '/v1/me/token/rotate', { method: 'POST', token }), 200);
    expect(rotated.token).toMatch(/^br_/);
    expect(rotated.token).not.toBe(token);
    expectStatus(await api(app, '/v1/me', { token }), 401);
    const me = expectStatus(await api(app, '/v1/me', { token: rotated.token }), 200);
    expect(me.bot.id).toBe('alice');
  });

  it('revokes: every authenticated call fails afterwards', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const token = await newBot(app, 'alice');

    const revoked = expectStatus(await api(app, '/v1/me/token/revoke', { method: 'POST', token }), 200);
    expect(revoked.revoked).toBe(true);
    expectStatus(await api(app, '/v1/me', { token }), 401);
    expectStatus(await api(app, '/v1/me/token/rotate', { method: 'POST', token }), 401);
    // The account itself is still registered.
    expect(deps.db.getBot('alice')?.id).toBe('alice');
  });
});
