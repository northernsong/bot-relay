import { afterEach, describe, expect, it } from 'vitest';

import { ADMIN, api, createInvite, expectStatus, login, makeApp } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

const WEBHOOK = 'http://127.0.0.1:9/hook/secret-path';

async function register(app: Parameters<typeof api>[0], body: Record<string, unknown>) {
  return api(app, '/v1/register', { body });
}

describe('registration', () => {
  it('returns a br_ token exactly once and the owner profile with contact details', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const invite = await createInvite(app, session);

    const missing = await register(app, { id: 'alice', display_name: 'Alice', webhook_url: WEBHOOK });
    expectStatus(missing, 403);
    expect(missing.json.error.code).toBe('invite_invalid');

    const created = expectStatus(
      await register(app, {
        invite_code: invite.code,
        id: 'alice',
        display_name: 'Alice',
        capabilities: 'weather reports',
        webhook_url: WEBHOOK,
        webhook_auth_name: 'Authorization',
        webhook_auth_value: 'Bearer super-secret',
      }),
      201,
    );
    expect(created.token).toMatch(/^br_/);
    expect(created.bot.id).toBe('alice');
    expect(created.bot.display_name).toBe('Alice');
    expect(created.bot.capabilities).toBe('weather reports');
    expect(created.bot.webhook_url).toBe(WEBHOOK);
    expect(created.bot.webhook_auth_name).toBe('Authorization');
    expect(created.bot.webhook_auth_value).toBe('Bearer super-secret');
    expect(created.bot.intake).toEqual({ mode: 'open' });
    expect(created.bot.contact_version).toBe(1);
    expect(created.bot.disabled).toBe(false);
    expect(created.bot.token_set_at).toBeTruthy();
    expect(created.bot.created_at).toBeTruthy();
    expect(created.bot).not.toHaveProperty('token_hash');

    const taken = await register(app, {
      invite_code: (await createInvite(app, session)).code,
      id: 'alice',
      display_name: 'Alice 2',
      webhook_url: WEBHOOK,
    });
    expectStatus(taken, 409);
    expect(taken.json.error.code).toBe('id_taken');

    const unknown = await register(app, {
      invite_code: (await createInvite(app, session)).code,
      id: 'bob',
      display_name: 'Bob',
      webhook_url: WEBHOOK,
      hop_limit: 5,
    });
    expectStatus(unknown, 400);
    expect(unknown.json.error.code).toBe('invalid_request');

    const health = await api(app, '/health');
    expectStatus(health, 200);
    expect(health.json.ok).toBe(true);
  });

  it('rejects bad ids, reserved ids, and invalid profile fields', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const base = async (overrides: Record<string, unknown>) => {
      const invite = await createInvite(app, session);
      const result = await register(app, {
        invite_code: invite.code,
        id: 'alice',
        display_name: 'Alice',
        webhook_url: WEBHOOK,
        ...overrides,
      });
      return result;
    };
    expectStatus(await base({ id: 'Alice' }), 400);
    expectStatus(await base({ id: 'me' }), 400);
    expectStatus(await base({ id: 'admin' }), 400);
    expectStatus(await base({ id: 'registry' }), 400);
    expectStatus(await base({ id: 'x' }), 400);
    expectStatus(await base({ id: 'a'.repeat(33) }), 400);
    expectStatus(await base({ display_name: '' }), 400);
    expectStatus(await base({ display_name: 'x'.repeat(81) }), 400);
    expectStatus(await base({ capabilities: 'y'.repeat(501) }), 400);
    expectStatus(await base({ webhook_url: 'not-a-url' }), 400);
    expectStatus(await base({ webhook_url: 'ftp://example.com/hook' }), 400);
    expectStatus(await base({ webhook_auth_name: 'Authorization' }), 400);
    expectStatus(await base({ webhook_auth_value: 'Bearer x' }), 400);
    expectStatus(await base({ webhook_auth_name: 'Content-Type', webhook_auth_value: 'x' }), 400);
    expectStatus(await base({ intake: 'open' }), 400);
    expectStatus(await base({ intake: { mode: 'weird' } }), 400);

    // A valid registration still works after all the rejects above.
    expectStatus(await base({ id: 'valid-bot' }), 201);
  });

  it('validates the intake three-state control', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const invite = await createInvite(app, session);
    expectStatus(
      await register(app, {
        invite_code: invite.code,
        id: 'bob',
        display_name: 'Bob',
        webhook_url: WEBHOOK,
        intake: { mode: 'allowlist' },
      }),
      400,
    );
    expectStatus(
      await register(app, {
        invite_code: (await createInvite(app, session)).code,
        id: 'bob',
        display_name: 'Bob',
        webhook_url: WEBHOOK,
        intake: { mode: 'open', allowlist: ['carol'] },
      }),
      400,
    );

    const created = expectStatus(
      await register(app, {
        invite_code: (await createInvite(app, session)).code,
        id: 'bob',
        display_name: 'Bob',
        webhook_url: WEBHOOK,
        intake: { mode: 'allowlist', allowlist: ['carol', 'carol', 'dave'] },
      }),
      201,
    );
    expect(created.bot.intake).toEqual({ mode: 'allowlist', allowlist: ['carol', 'dave'] });
    const stored = deps.db.getBot('bob');
    expect(stored?.intakeMode).toBe('allowlist');
    expect(stored?.intakeAllowlist).toEqual(['carol', 'dave']);

    const none = expectStatus(
      await register(app, {
        invite_code: (await createInvite(app, session)).code,
        id: 'carol',
        display_name: 'Carol',
        webhook_url: WEBHOOK,
        intake: { mode: 'none' },
      }),
      201,
    );
    expect(none.bot.intake).toEqual({ mode: 'none' });
  });

  it('requires a JSON body', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const res = await app.request('/v1/register', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'invite_code=abc',
    });
    expect(res.status).toBe(415);
  });

  it('admin bearer cannot bypass the invite requirement', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const result = await api(app, '/v1/register', {
      token: ADMIN,
      body: { id: 'alice', display_name: 'Alice', webhook_url: WEBHOOK },
    });
    expectStatus(result, 403);
    expect(result.json.error.code).toBe('invite_invalid');
  });
});
