import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { decryptSecret } from '../src/secret.js';
import type { Deps } from '../src/deps.js';
import { api, expectStatus, login, makeApp, registerBot, startWebhook, until } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

type World = { app: Hono; deps: Deps; alice: string; bob: string; hook: Awaited<ReturnType<typeof startWebhook>> };

async function makeWorld(config: Record<string, number> = {}): Promise<World> {
  const { app, deps } = makeApp(config);
  const hook = await startWebhook();
  const session = await login(app);
  const alice = await registerBot(app, { id: 'alice', invite: (await createdInvite(app, session)).code });
  const bob = await registerBot(app, {
    id: 'bob',
    invite: (await createdInvite(app, session)).code,
    extra: { webhook_url: hook.url, webhook_auth_name: 'Authorization', webhook_auth_value: 'Bearer bob-secret' },
  });
  return { app, deps, alice, bob, hook };
}

async function createdInvite(app: Hono, session: { headers: Record<string, string> }): Promise<{ code: string }> {
  const res = expectStatus(await api(app, '/admin/api/invites', { body: { max_uses: 1 }, headers: session.headers }), 201);
  return { code: res.invite.code as string };
}

/** Run the full approve flow and return the resulting grant for (alice -> bob). */
async function approvePair(world: World): Promise<string> {
  const created = expectStatus(await api(world.app, '/v1/inquiries', { token: world.alice, body: { to: 'bob' } }), 202);
  const inquiryId = created.inquiry.id as string;
  await until(() => world.deps.db.getInquiry(inquiryId)?.status === 'pending');
  expectStatus(
    await api(world.app, `/v1/inquiries/${inquiryId}/decision`, { token: world.bob, body: { decision: 'approve' } }),
    200,
  );
  const grants = expectStatus(await api(world.app, '/v1/grants?role=received', { token: world.alice }), 200);
  expect(grants.grants).toHaveLength(1);
  return grants.grants[0].id as string;
}

async function contact(world: World, grantId: string, token = world.alice) {
  return api(world.app, `/v1/grants/${grantId}/contact`, { token });
}

describe('revocation', () => {
  it('stops contact delivery immediately and requires a new inquiry', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const grantId = await approvePair(world);

    const revoked = expectStatus(
      await api(world.app, `/v1/grants/${grantId}/revoke`, { method: 'POST', token: world.bob }),
      200,
    );
    expect(revoked).toEqual({ revoked: true, webhook_secret_rotated: false });

    const blocked = await contact(world, grantId);
    expectStatus(blocked, 410);
    expect(blocked.json.error.code).toBe('grant_inactive');

    // A must ask again; the revoked grant never short-circuits to contact.
    const again = expectStatus(await api(world.app, '/v1/inquiries', { token: world.alice, body: { to: 'bob' } }), 202);
    expect(again.inquiry.status).toBe('delivering');

    // Revoking twice is rejected.
    expectStatus(await api(world.app, `/v1/grants/${grantId}/revoke`, { method: 'POST', token: world.bob }), 409);
  });

  it('combines revocation with a webhook secret rotation in one step (P0-8③)', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const grantId = await approvePair(world);

    const revoked = expectStatus(
      await api(world.app, `/v1/grants/${grantId}/revoke`, {
        method: 'POST',
        token: world.bob,
        body: { rotate_webhook_secret: 'Bearer brand-new-secret' },
      }),
      200,
    );
    expect(revoked).toEqual({ revoked: true, webhook_secret_rotated: true });

    // B itself immediately sees the new secret; the old one is gone everywhere.
    const me = expectStatus(await api(world.app, '/v1/me', { token: world.bob }), 200);
    expect(me.bot.webhook_auth_value).toBe('Bearer brand-new-secret');
    expect(me.bot.contact_version).toBe(2);
    const stored = world.deps.db.getBot('bob');
    expect(JSON.stringify(stored)).not.toContain('bob-secret');
    expect(decryptSecret(stored!.webhookAuthValueEnc, world.deps.config.encryptionKey)).toBe('Bearer brand-new-secret');

    // A is cut off from both the old and new secret.
    const blocked = await contact(world, grantId);
    expectStatus(blocked, 410);

    // An invalid rotation value is rejected without revoking.
    const badRotate = await api(world.app, `/v1/grants/${grantId}/revoke`, {
      method: 'POST',
      token: world.bob,
      body: { rotate_webhook_secret: '' },
    });
    expectStatus(badRotate, 400);
  });
});

describe('abandonment', () => {
  it('drops refresh access and forces a new inquiry; double abandon is 409', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const grantId = await approvePair(world);

    const abandoned = expectStatus(
      await api(world.app, `/v1/grants/${grantId}/abandon`, { method: 'POST', token: world.alice }),
      200,
    );
    expect(abandoned).toEqual({ abandoned: true });

    const blocked = await contact(world, grantId);
    expectStatus(blocked, 410);
    expectStatus(await api(world.app, `/v1/grants/${grantId}/abandon`, { method: 'POST', token: world.alice }), 409);
    // B can no longer revoke an abandoned grant either.
    expectStatus(await api(world.app, `/v1/grants/${grantId}/revoke`, { method: 'POST', token: world.bob }), 409);

    // Re-applying is a brand-new inquiry, not a silent contact return.
    const again = expectStatus(await api(world.app, '/v1/inquiries', { token: world.alice, body: { to: 'bob' } }), 202);
    expect(again.inquiry.status).toBe('delivering');
  });
});

describe('controlled refresh after rotation (P0-8②, P1-3)', () => {
  it('serves the new contact details with a bumped contact_version', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const grantId = await approvePair(world);

    expectStatus(
      await api(world.app, '/v1/me', { method: 'PATCH', token: world.bob, body: { webhook_auth_value: 'Bearer rotated-once' } }),
      200,
    );
    const first = expectStatus(await contact(world, grantId), 200);
    expect(first.webhook_auth_value).toBe('Bearer rotated-once');
    expect(first.contact_version).toBe(2);

    // Moving the webhook URL also bumps the version and serves the new URL.
    expectStatus(
      await api(world.app, '/v1/me', { method: 'PATCH', token: world.bob, body: { webhook_url: 'http://127.0.0.1:10/hook' } }),
      200,
    );
    const second = expectStatus(await contact(world, grantId), 200);
    expect(second.webhook_url).toBe('http://127.0.0.1:10/hook');
    expect(second.contact_version).toBe(3);

    // The refresh is recorded.
    const grants = expectStatus(await api(world.app, '/v1/grants?role=received', { token: world.alice }), 200);
    expect(grants.grants[0].refreshed_at).toBeTruthy();
    expect(grants.grants[0].inquiry_id).toMatch(/^inq_/);
  });

  it('returns 410 when the target bot is disabled', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const grantId = await approvePair(world);
    const session = await login(world.app);
    expectStatus(await api(world.app, '/admin/api/bots/bob/disable', { method: 'POST', headers: session.headers }), 200);

    const blocked = await contact(world, grantId);
    expectStatus(blocked, 410);
    expect(blocked.json.error.code).toBe('grant_inactive');
  });
});

describe('re-approval reactivates the same grant row', () => {
  it('keeps one row per pair and restores refresh access after a new inquiry', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const firstGrantId = await approvePair(world);
    expectStatus(await api(world.app, `/v1/grants/${firstGrantId}/revoke`, { method: 'POST', token: world.bob }), 200);

    const grantId = await approvePair(world);
    expect(grantId).toBe(firstGrantId);
    const refreshed = expectStatus(await contact(world, grantId), 200);
    expect(refreshed.webhook_url).toBe(world.hook.url);

    // Still exactly one grant row for the pair on each side.
    const mine = expectStatus(await api(world.app, '/v1/grants?role=received', { token: world.alice }), 200);
    const given = expectStatus(await api(world.app, '/v1/grants?role=given', { token: world.bob }), 200);
    expect(mine.grants).toHaveLength(1);
    expect(given.grants).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain('webhook_url');
    expect(JSON.stringify(given)).not.toContain('bob-secret');
  });
});

describe('access control and rate limits', () => {
  it('hides grants from non-parties and enforces the refresh budget', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const grantId = await approvePair(world);

    expectStatus(await contact(world, grantId, world.bob), 404);
    expectStatus(await contact(world, 'grt_missing', world.alice), 404);
    // Only the requester may abandon; only the target may revoke.
    expectStatus(await api(world.app, `/v1/grants/${grantId}/abandon`, { method: 'POST', token: world.bob }), 404);
    expectStatus(await api(world.app, `/v1/grants/${grantId}/revoke`, { method: 'POST', token: world.alice }), 404);
    expectStatus(await api(world.app, '/v1/grants?role=bogus', { token: world.alice }), 400);
  });

  it('enforces the refresh rate budget', async () => {
    const world = await makeWorld({ defaultRatePerMin: 1 });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const grantId = await approvePair(world);
    expectStatus(await contact(world, grantId), 200);
    const limited = await contact(world, grantId);
    expectStatus(limited, 429);
    expect(limited.json.error.code).toBe('rate_limited');
  });
});
