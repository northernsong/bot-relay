import { afterEach, describe, expect, it } from 'vitest';

import { api, ADMIN, expectStatus, makeApp, startWebhook } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

describe('registration and auth', () => {
  it('requires the admin token and returns a relay token without the webhook secret', async () => {
    const hook = await startWebhook();
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() }, hook);
    const secret = 'super-secret-webhook-key';

    const missing = await api(app, '/bots', { body: { id: 'alice', display_name: 'Alice' } });
    expectStatus(missing, 401);

    const asBotWould = await api(app, '/bots', {
      token: 'rl_not-a-real-token',
      body: { id: 'alice', display_name: 'Alice' },
    });
    expectStatus(asBotWould, 401);

    const created = expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: {
          id: 'alice',
          display_name: 'Alice',
          webhook_url: `${hook.url}/super-secret-path`,
          auth_header_name: 'Authorization',
          auth_header_value: `Bearer ${secret}`,
          allowlist: ['bob'],
        },
      }),
      201,
    );
    expect(created.token).toMatch(/^rl_/);
    expect(created.has_auth_header).toBe(true);
    expect(created.auth_header_name).toBe('Authorization');
    expect(created.webhook_url).toContain('/hook/super-secret-path');
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(created).not.toHaveProperty('auth_header_value');

    const stored = deps.db.getBot('alice');
    expect(stored?.authHeaderValueEnc).toBeTruthy();
    expect(stored?.authHeaderValueEnc).not.toContain(secret);

    const me = expectStatus(await api(app, '/bots/me', { token: created.token }), 200);
    expect(me.id).toBe('alice');
    expect(me).not.toHaveProperty('token');
    expect(JSON.stringify(me)).not.toContain(secret);

    const again = await api(app, '/bots', {
      token: ADMIN,
      body: { id: 'alice', display_name: 'Alice again' },
    });
    expectStatus(again, 409);

    const unauth = await api(app, '/health');
    expectStatus(unauth, 200);
    expect(unauth.json.ok).toBe(true);
  });

  it('rejects bad ids and updates or deletes only the caller', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const alice = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'alice', display_name: 'Alice' } }),
      201,
    );
    expectStatus(await api(app, '/bots', { token: ADMIN, body: { id: 'Alice', display_name: 'No' } }), 400);
    expectStatus(await api(app, '/bots', { token: ADMIN, body: { id: 'me', display_name: 'No' } }), 400);

    const patched = expectStatus(
      await api(app, '/bots/me', {
        method: 'PATCH',
        token: alice.token,
        body: { display_name: 'Alice Updated', allowlist: [] },
      }),
      200,
    );
    expect(patched.display_name).toBe('Alice Updated');
    expect(patched.allowlist).toEqual([]);
    expect(patched).not.toHaveProperty('token');

    const rotated = expectStatus(
      await api(app, '/bots/me', { method: 'PATCH', token: alice.token, body: { rotate_token: true } }),
      200,
    );
    expect(rotated.token).toMatch(/^rl_/);
    expect(rotated.token).not.toBe(alice.token);
    expectStatus(await api(app, '/bots/me', { token: alice.token }), 401);
    expectStatus(await api(app, '/bots/me', { token: rotated.token }), 200);

    expectStatus(await api(app, '/messages', { token: ADMIN, body: { to: 'alice', body: 'nope' } }), 401);

    expectStatus(await api(app, '/bots/me', { method: 'DELETE', token: rotated.token }), 200);
    expectStatus(await api(app, '/bots/me', { token: rotated.token }), 401);

    const bob = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'bob', display_name: 'Bob' } }),
      201,
    );
    const carol = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'carol', display_name: 'Carol' } }),
      201,
    );
    expectStatus(await api(app, `/bots/${bob.id}`, { method: 'DELETE', token: ADMIN }), 200);
    expectStatus(await api(app, '/bots/bob', { token: carol.token }), 404);
  });

  it('does not publish another bot webhook URL or allowlist', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const alice = expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: {
          id: 'alice',
          display_name: 'Alice',
          webhook_url: 'http://127.0.0.1:9/hooks/super-secret-path',
          auth_header_name: 'X-Webhook-Secret',
          auth_header_value: 'super-secret-webhook-key',
          allowlist: ['bob'],
        },
      }),
      201,
    );
    const bob = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'bob', display_name: 'Bob' } }),
      201,
    );
    const profile = expectStatus(await api(app, '/bots/alice', { token: bob.token }), 200);
    expect(profile).toEqual({ id: 'alice', display_name: 'Alice', delivery: 'webhook' });
    expect(JSON.stringify(profile)).not.toContain('super-secret');
    expect(profile).not.toHaveProperty('allowlist');
    expect(profile).not.toHaveProperty('webhook_url');
    expect(alice.has_auth_header).toBe(true);
  });

  it('clears a webhook auth header without echoing the new value', async () => {
    const hook = await startWebhook();
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() }, hook);
    const alice = expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: {
          id: 'alice',
          display_name: 'Alice',
          webhook_url: hook.url,
          auth_header_name: 'X-Webhook-Secret',
          auth_header_value: 'first-secret',
        },
      }),
      201,
    );
    const updated = expectStatus(
      await api(app, '/bots/me', {
        method: 'PATCH',
        token: alice.token,
        body: { auth_header_value: 'second-secret' },
      }),
      200,
    );
    expect(updated.has_auth_header).toBe(true);
    expect(JSON.stringify(updated)).not.toContain('second-secret');
    expect(deps.db.getBot('alice')?.authHeaderValueEnc).not.toContain('second-secret');

    const cleared = expectStatus(
      await api(app, '/bots/me', {
        method: 'PATCH',
        token: alice.token,
        body: { auth_header_name: null },
      }),
      200,
    );
    expect(cleared.has_auth_header).toBe(false);
    expect(cleared.auth_header_name).toBeNull();
  });
});
