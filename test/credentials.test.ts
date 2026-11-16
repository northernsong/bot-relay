import { afterEach, describe, expect, it } from 'vitest';

import { ADMIN, api, createInvite, expectStatus, login, makeApp, registerBot } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

describe('GET /admin/api/bots/:id/credentials (P0-6④)', () => {
  it('decrypts contact details only for a logged-in session with CSRF, and audits every view', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const invite = await createInvite(app, session);
    await registerBot(app, {
      id: 'alice',
      invite: invite.code,
      display_name: 'Alice',
      extra: {
        webhook_url: 'http://127.0.0.1:9/hook/secret-path',
        webhook_auth_name: 'Authorization',
        webhook_auth_value: 'Bearer super-secret',
      },
    });

    // No session: denied.
    expectStatus(await api(app, '/admin/api/bots/alice/credentials'), 401);
    // The admin bearer token alone is not enough: this is a deliberate,
    // session-bound action (P0-6④).
    expectStatus(await api(app, '/admin/api/bots/alice/credentials', { token: ADMIN }), 401);
    // Session without the CSRF token: denied.
    const noCsrf = await api(app, '/admin/api/bots/alice/credentials', { headers: { cookie: session.cookie } });
    expectStatus(noCsrf, 403);
    expect(noCsrf.json.error.code).toBe('csrf');
    // Wrong CSRF value: denied as well.
    expectStatus(
      await api(app, '/admin/api/bots/alice/credentials', {
        headers: { cookie: session.cookie, 'x-csrf-token': 'wrong' },
      }),
      403,
    );

    // Session + CSRF: the one place decrypted contact details are shown.
    const viewed = expectStatus(
      await api(app, '/admin/api/bots/alice/credentials', { headers: session.headers }),
      200,
    );
    expect(viewed.bot).toEqual({
      id: 'alice',
      display_name: 'Alice',
      webhook_url: 'http://127.0.0.1:9/hook/secret-path',
      webhook_auth_name: 'Authorization',
      webhook_auth_value: 'Bearer super-secret',
      contact_version: 1,
    });

    // Every view leaves an audit trail (§10.3): field names only, never values.
    const events = deps.db.listAuditEvents();
    const viewed0 = events.find((event) => event.action === 'credentials.viewed');
    expect(viewed0).toMatchObject({ actor: 'admin', object: 'alice' });
    expect(viewed0?.source).toBeTruthy();
    expect(JSON.parse(viewed0?.detail ?? '{}')).toEqual({
      fields: ['webhook_url', 'webhook_auth_name', 'webhook_auth_value'],
    });
    expect(viewed0?.detail).not.toContain('super-secret');

    // Unknown bot: 404.
    expectStatus(await api(app, '/admin/api/bots/nobody/credentials', { headers: session.headers }), 404);
  });

  it('never leaks contact details through the regular admin list', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const invite = await createInvite(app, session);
    await registerBot(app, {
      id: 'alice',
      invite: invite.code,
      extra: {
        webhook_url: 'http://127.0.0.1:9/hook/secret-path',
        webhook_auth_name: 'Authorization',
        webhook_auth_value: 'Bearer super-secret',
      },
    });
    const listed = expectStatus(await api(app, '/admin/api/bots', { headers: session.headers }), 200);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('webhook_url');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('/hook/secret-path');
  });
});
