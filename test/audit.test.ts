import { afterEach, describe, expect, it } from 'vitest';

import { ADMIN, api, createInvite, expectStatus, login, makeApp, mutableClock, registerBot, startWebhook, until } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

/** Every action from design §10.3 that a test deployment can produce. */
const ALL_ACTIONS = [
  'admin.login.ok',
  'admin.login.fail',
  'invite.created',
  'invite.revoked',
  'bot.disabled',
  'bot.enabled',
  'bot.deleted',
  'credentials.viewed',
  'key.rotated',
  'inquiry.created',
  'inquiry.delivered',
  'inquiry.undelivered',
  'inquiry.decided',
  'inquiry.expired',
  'grant.revoked',
  'grant.abandoned',
  'token.rotated',
  'token.revoked',
  'webhook.rotated',
];

describe('audit trail (P1-1)', () => {
  it('records every §10.3 action across admin and bot flows', async () => {
    const clock = mutableClock();
    const { app, deps } = makeApp({}, { now: clock.now });
    open.push({ close: () => deps.db.close() });
    const failing = await startWebhook({ statuses: [500] });
    open.push({ close: () => failing.close() });
    const ok = await startWebhook();
    open.push({ close: () => ok.close() });

    // admin.login.ok (the login helper) and the failure variant.
    const session = await login(app);
    expectStatus(await api(app, '/admin/login', { body: { token: 'wrong-on-purpose' } }), 401);

    // invite.created / invite.revoked.
    const invite = await createInvite(app, session);
    const doomed = await createInvite(app, session);
    expectStatus(await api(app, `/admin/api/invites/${doomed.id}/revoke`, { method: 'POST', headers: session.headers }), 200);

    // Bots: alice asks, bob answers, carol is unreachable, dave expires.
    const alice = await registerBot(app, { id: 'alice', invite: invite.code });
    const bob = await registerBot(app, {
      id: 'bob',
      invite: (await createInvite(app, session)).code,
      extra: { webhook_url: ok.url, webhook_auth_name: 'Authorization', webhook_auth_value: 'Bearer bob-secret' },
    });
    const carol = await registerBot(app, {
      id: 'carol',
      invite: (await createInvite(app, session)).code,
      extra: { webhook_url: failing.url },
    });
    const daveInvite = await createInvite(app, session);
    await registerBot(app, { id: 'dave', invite: daveInvite.code, extra: { webhook_url: ok.url } });

    // key.rotated, credentials.viewed, bot.disabled + bot.enabled.
    expectStatus(await api(app, '/admin/api/registry-keys/rotate', { method: 'POST', headers: session.headers }), 200);
    expectStatus(await api(app, '/admin/api/bots/bob/credentials', { headers: session.headers }), 200);
    expectStatus(await api(app, '/admin/api/bots/dave/disable', { method: 'POST', headers: session.headers }), 200);
    expectStatus(await api(app, '/admin/api/bots/dave/enable', { method: 'POST', headers: session.headers }), 200);

    // inquiry.undelivered: carol's webhook answers 500.
    const toCarol = expectStatus(await api(app, '/v1/inquiries', { token: alice, body: { to: 'carol' } }), 202);
    await until(() => deps.db.getInquiry(toCarol.inquiry.id as string)?.status === 'undelivered');

    // inquiry.delivered + inquiry.decided + grant.abandoned, then again with
    // grant.revoked + webhook.rotated (revoke with rotation).
    const first = expectStatus(await api(app, '/v1/inquiries', { token: alice, body: { to: 'bob' } }), 202);
    await until(() => deps.db.getInquiry(first.inquiry.id as string)?.status === 'pending');
    expectStatus(
      await api(app, `/v1/inquiries/${first.inquiry.id}/decision`, { token: bob, body: { decision: 'approve' } }),
      200,
    );
    const grants = expectStatus(await api(app, '/v1/grants?role=received', { token: alice }), 200);
    const grantId = grants.grants[0].id as string;
    expectStatus(await api(app, `/v1/grants/${grantId}/abandon`, { method: 'POST', token: alice }), 200);

    const second = expectStatus(await api(app, '/v1/inquiries', { token: alice, body: { to: 'bob' } }), 202);
    await until(() => deps.db.getInquiry(second.inquiry.id as string)?.status === 'pending');
    expectStatus(
      await api(app, `/v1/inquiries/${second.inquiry.id}/decision`, { token: bob, body: { decision: 'approve' } }),
      200,
    );
    expectStatus(
      await api(app, `/v1/grants/${grantId}/revoke`, {
        method: 'POST',
        token: bob,
        body: { rotate_webhook_secret: 'Bearer bob-rotated-secret' },
      }),
      200,
    );

    // webhook.rotated via PATCH /v1/me as well; token.rotated / token.revoked.
    expectStatus(
      await api(app, '/v1/me', { method: 'PATCH', token: bob, body: { webhook_auth_value: 'Bearer another-secret' } }),
      200,
    );
    const aliceRotated = expectStatus(await api(app, '/v1/me/token/rotate', { method: 'POST', token: alice }), 200);
    const alice2 = aliceRotated.token as string;
    const carolToken = expectStatus(await api(app, '/v1/me/token/revoke', { method: 'POST', token: carol }), 200);
    expect(carolToken.revoked).toBe(true);

    // inquiry.expired via the 24h sweep (alice calls with her rotated token).
    const toDave = expectStatus(await api(app, '/v1/inquiries', { token: alice2, body: { to: 'dave' } }), 202);
    await until(() => deps.db.getInquiry(toDave.inquiry.id as string)?.status === 'pending');
    clock.advance(25 * 3600 * 1000);
    expectStatus(await api(app, '/v1/inquiries?role=requester', { token: alice2 }), 200);

    // bot.deleted last so it is the newest row (bearer: the session cookie
    // expired when the clock jumped 25h ahead).
    expectStatus(await api(app, '/admin/api/bots/carol', { method: 'DELETE', token: ADMIN }), 200);

    const audit = expectStatus(await api(app, '/admin/api/audit?limit=500', { token: ADMIN }), 200);
    const actions = new Set<string>(audit.events.map((event: { action: string }) => event.action));
    for (const action of ALL_ACTIONS) {
      expect(actions.has(action), `missing audit action: ${action}`).toBe(true);
    }
    // Newest first: the delete of carol is the most recent event.
    expect(audit.events[0]).toMatchObject({ action: 'bot.deleted', object: 'carol', actor: 'admin' });
    // ISO timestamps and parsed detail objects.
    expect(typeof audit.events[0].at).toBe('string');
    const decided = audit.events.find(
      (event: { action: string }) => event.action === 'inquiry.decided',
    );
    expect(decided.detail).toEqual({ decision: 'approve' });

    // Secrets never land in the trail.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('bob-secret');
    expect(serialized).not.toContain('bob-rotated-secret');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).not.toContain(invite.code);
    expect(serialized).not.toContain(ok.url);
  });

  it('paginates with limit and the before cursor', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    // Five distinct invite.created events after the login event.
    for (let i = 0; i < 5; i += 1) {
      await createInvite(app, session, { label: `page-${i}` });
    }

    const page1 = expectStatus(await api(app, '/admin/api/audit?limit=2', { token: ADMIN }), 200);
    expect(page1.events).toHaveLength(2);
    expect(page1.next_before).toBe(page1.events[1].id);
    const page2 = expectStatus(
      await api(app, `/admin/api/audit?limit=2&before=${page1.next_before}`, { token: ADMIN }),
      200,
    );
    expect(page2.events).toHaveLength(2);
    const ids = [...page1.events, ...page2.events].map((event: { id: number }) => event.id);
    expect(ids[0]).toBeGreaterThan(ids[1]);
    expect(ids[1]).toBeGreaterThan(ids[2]);
    expect(ids[2]).toBeGreaterThan(ids[3]);

    // Walking to the end returns a short page and a null cursor.
    let cursor = page2.next_before as number | null;
    let guard = 0;
    let seen = 4;
    while (cursor !== null && guard < 20) {
      const page = expectStatus(await api(app, `/admin/api/audit?limit=2&before=${cursor}`, { token: ADMIN }), 200);
      seen += page.events.length;
      cursor = page.next_before;
      guard += 1;
    }
    expect(guard).toBeLessThan(20);
    expect(seen).toBe(6); // login + 5 invites

    expectStatus(await api(app, '/admin/api/audit?limit=0', { token: ADMIN }), 400);
    expectStatus(await api(app, '/admin/api/audit?limit=501', { token: ADMIN }), 400);
    expectStatus(await api(app, '/admin/api/audit?limit=abc', { token: ADMIN }), 400);
    expectStatus(await api(app, '/admin/api/audit?before=zzz', { token: ADMIN }), 400);
  });

  it('requires deployer auth', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    expectStatus(await api(app, '/admin/api/audit'), 401);
    const session = await login(app);
    const alice = await registerBot(app, { id: 'alice', invite: (await createInvite(app, session)).code });
    expectStatus(await api(app, '/admin/api/audit', { token: alice }), 401);
    const viaSession = expectStatus(await api(app, '/admin/api/audit', { headers: session.headers }), 200);
    expect(Array.isArray(viaSession.events)).toBe(true);
  });

  it('shows the audit section and rotation times in the admin dashboard', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const page = await api(app, '/admin', { headers: { cookie: session.cookie } });
    expectStatus(page, 200);
    expect(page.text).toContain('Audit trail');
    expect(page.text).toContain('id="audit"');
    // P1-4: rotation timestamps visible on the page, not just in the API.
    expect(page.text).toContain('Webhook secret set');
    expect(page.text).toContain('Token set');
  });
});
