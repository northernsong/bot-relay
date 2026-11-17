import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import type { Deps } from '../src/deps.js';
import { sweepInquiries } from '../src/inquiry.js';
import type { Config } from '../src/config.js';
import {
  api,
  createInvite,
  expectStatus,
  login,
  makeApp,
  mutableClock,
  registerBot,
  startWebhook,
  until,
  type ApiResult,
} from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

type World = {
  app: Hono;
  deps: Deps;
  alice: string;
  bob: string;
  carol: string;
  hook: Awaited<ReturnType<typeof startWebhook>>;
};

async function newBot(app: Hono, id: string, extra: Record<string, unknown> = {}): Promise<string> {
  const session = await login(app);
  const invite = await createInvite(app, session);
  return registerBot(app, { id, invite: invite.code, extra });
}

async function makeWorld(opts?: {
  config?: Partial<Config>;
  webhook?: { statuses?: number[]; hang?: boolean };
  clock?: { now: () => number };
}): Promise<World> {
  const { app, deps } = makeApp(opts?.config ?? {}, opts?.clock ? { now: opts.clock.now } : {});
  const hook = await startWebhook(opts?.webhook);
  const alice = await newBot(app, 'alice');
  const bob = await newBot(app, 'bob', {
    webhook_url: hook.url,
    webhook_auth_name: 'Authorization',
    webhook_auth_value: 'Bearer bob-secret',
  });
  const carol = await newBot(app, 'carol');
  return { app, deps, alice, bob, carol, hook };
}

async function inquire(app: Hono, token: string, to = 'bob'): Promise<ApiResult> {
  return api(app, '/v1/inquiries', { token, body: { to } });
}

async function waitForStatus(deps: Deps, id: string, status: string): Promise<void> {
  await until(() => deps.db.getInquiry(id)?.status === status);
}

describe('end-to-end: register, discover, inquire, approve, fetch contact', () => {
  it('walkes the whole P0 flow without ever leaking contact details early', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });

    // Discover: the directory shows bob but no webhook anywhere.
    const directory = expectStatus(await api(world.app, '/v1/directory', { token: world.alice }), 200);
    const bobEntry = directory.bots.find((bot: { id: string }) => bot.id === 'bob');
    expect(bobEntry).toBeTruthy();
    expect(JSON.stringify(directory)).not.toContain('webhook');
    expect(JSON.stringify(directory)).not.toContain('bob-secret');

    // Inquire: accepted immediately with 202 delivering, before the outbound call.
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    const inquiryId = created.inquiry.id as string;
    expect(inquiryId).toMatch(/^inq_/);
    expect(created.inquiry.status).toBe('delivering');
    expect(created.inquiry.from).toBe('alice');
    expect(created.inquiry.to).toBe('bob');
    expect(created.inquiry.expires_at).toBeTruthy();
    expect(JSON.stringify(created)).not.toContain('bob-secret');

    // The outbound inquiry is a single JSON POST to bob's webhook.
    await waitForStatus(world.deps, inquiryId, 'pending');
    expect(world.hook.hits).toHaveLength(1);
    const hit = world.hook.hits[0]!;
    expect(hit.headers['content-type']).toBe('application/json');
    expect(String(hit.headers['user-agent'])).toMatch(/^bot-relay\//);
    // The outbound inquiry is signed with the registry Ed25519 key (P0-5⑦);
    // full verification lives in test/identity.test.ts.
    expect(String(hit.headers['x-bot-relay-signature'])).toMatch(/^v1 kid=rk_[0-9a-f]{16} ts=\d+ sig=[A-Za-z0-9_-]+$/);
    // Bob's own webhook auth header rides along, like for any other caller.
    expect(hit.headers.authorization).toBe('Bearer bob-secret');
    const payload = JSON.parse(hit.body) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: 'inquiry', to: 'bob', from: 'alice', inquiry_id: inquiryId });
    expect(typeof payload.expires_at).toBe('string');

    // B self-checks pending inquiries, then approves.
    const pending = expectStatus(
      await api(world.app, '/v1/inquiries?role=target&status=pending', { token: world.bob }),
      200,
    );
    expect(pending.inquiries.map((i: { id: string }) => i.id)).toContain(inquiryId);
    const decided = expectStatus(
      await api(world.app, `/v1/inquiries/${inquiryId}/decision`, { token: world.bob, body: { decision: 'approve' } }),
      200,
    );
    expect(decided.inquiry.status).toBe('approved');
    expectStatus(
      await api(world.app, `/v1/inquiries/${inquiryId}/decision`, { token: world.bob, body: { decision: 'approve' } }),
      409,
    );

    // A sees the approval and fetches bob's contact details.
    const seen = expectStatus(await api(world.app, `/v1/inquiries/${inquiryId}`, { token: world.alice }), 200);
    expect(seen.inquiry.status).toBe('approved');
    const grants = expectStatus(await api(world.app, '/v1/grants?role=received', { token: world.alice }), 200);
    expect(grants.grants).toHaveLength(1);
    expect(grants.grants[0].peer).toEqual({ id: 'bob', display_name: 'bob' });
    const grantId = grants.grants[0].id as string;

    const contact = expectStatus(await api(world.app, `/v1/grants/${grantId}/contact`, { token: world.alice }), 200);
    expect(Object.keys(contact).sort()).toEqual(['contact_version', 'fetched_at', 'grant_id', 'webhook_auth_name', 'webhook_auth_value', 'webhook_url']);
    expect(contact.webhook_url).toBe(world.hook.url);
    expect(contact.webhook_auth_name).toBe('Authorization');
    expect(contact.webhook_auth_value).toBe('Bearer bob-secret');
    expect(contact.contact_version).toBe(1);

    // B sees what it granted; nobody else can see the grant.
    const given = expectStatus(await api(world.app, '/v1/grants?role=given', { token: world.bob }), 200);
    expect(given.grants).toHaveLength(1);
    expect(given.grants[0].peer.id).toBe('alice');
    expectStatus(await api(world.app, `/v1/grants/${grantId}/contact`, { token: world.carol }), 404);
    expectStatus(await api(world.app, `/v1/grants/${grantId}/contact`, { token: world.bob }), 404);
  });
});

describe('delivery outcomes (delivering -> pending | undelivered)', () => {
  it('marks undelivered on non-2xx with a classified error and no retry', async () => {
    const world = await makeWorld({ webhook: { statuses: [500] } });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    await waitForStatus(world.deps, created.inquiry.id as string, 'undelivered');
    expect(world.hook.hits).toHaveLength(1);
    const inquiry = expectStatus(await api(world.app, `/v1/inquiries/${created.inquiry.id}`, { token: world.alice }), 200);
    expect(inquiry.inquiry.delivery_error).toBe('http_5xx');
  });

  it('classifies a 4xx rejection as http_4xx, not http_5xx', async () => {
    const world = await makeWorld({ webhook: { statuses: [401] } });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    await waitForStatus(world.deps, created.inquiry.id as string, 'undelivered');
    expect(world.hook.hits).toHaveLength(1);
    const inquiry = expectStatus(await api(world.app, `/v1/inquiries/${created.inquiry.id}`, { token: world.alice }), 200);
    expect(inquiry.inquiry.delivery_error).toBe('http_4xx');
  });

  it('sends no auth header when the target registered none', async () => {
    const { app, deps } = makeApp();
    const hook = await startWebhook();
    open.push({ close: async () => { await hook.close(); deps.db.close(); } });
    const alice = await newBot(app, 'alice');
    await newBot(app, 'dave', { webhook_url: hook.url });
    const created = expectStatus(await inquire(app, alice, 'dave'), 202);
    await waitForStatus(deps, created.inquiry.id as string, 'pending');
    expect(hook.hits).toHaveLength(1);
    expect(hook.hits[0]!.headers.authorization).toBeUndefined();
  });

  it('marks undelivered on timeout without retrying', async () => {
    const world = await makeWorld({ config: { inquiryDeliveryTimeoutMs: 150 }, webhook: { hang: true } });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    await waitForStatus(world.deps, created.inquiry.id as string, 'undelivered');
    expect(world.hook.hits).toHaveLength(1);
    const inquiry = expectStatus(await api(world.app, `/v1/inquiries/${created.inquiry.id}`, { token: world.alice }), 200);
    expect(inquiry.inquiry.delivery_error).toBe('timeout');
  });

  it('refuses to follow redirects: 3xx counts as undelivered', async () => {
    const world = await makeWorld({ webhook: { statuses: [302] } });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    await waitForStatus(world.deps, created.inquiry.id as string, 'undelivered');
    expect(world.hook.hits).toHaveLength(1);
    const inquiry = expectStatus(await api(world.app, `/v1/inquiries/${created.inquiry.id}`, { token: world.alice }), 200);
    expect(inquiry.inquiry.delivery_error).toBe('blocked_address');
  });

  it('buries delivering rows stuck for over 60s (crash residue), and a late delivery cannot revive them', async () => {
    const clock = mutableClock();
    const world = await makeWorld({ config: { inquiryDeliveryTimeoutMs: 100 }, webhook: { hang: true }, clock });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    expect(world.deps.db.getInquiry(created.inquiry.id as string)?.status).toBe('delivering');

    clock.advance(60_001);
    const lazy = expectStatus(await api(world.app, `/v1/inquiries/${created.inquiry.id}`, { token: world.alice }), 200);
    expect(lazy.inquiry.status).toBe('undelivered');
    expect(lazy.inquiry.delivery_error).toBe('timeout');
  });

  it('runs the sweeper function directly for overdue pending and stuck delivering rows', async () => {
    const clock = mutableClock();
    const world = await makeWorld({ clock });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    const id = created.inquiry.id as string;
    await waitForStatus(world.deps, id, 'pending');

    clock.advance(86_400 * 1000 + 1);
    sweepInquiries(world.deps);
    expect(world.deps.db.getInquiry(id)?.status).toBe('expired');
  });
});

describe('dedup rules (P0-5⑤)', () => {
  it('keeps one active inquiry: repeat requests return it unchanged, never resetting expires_at', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const first = expectStatus(await inquire(world.app, world.alice), 202);
    const second = expectStatus(await inquire(world.app, world.alice), 200);
    expect(second.inquiry.id).toBe(first.inquiry.id);
    expect(second.inquiry.status).toBe('delivering');
    expect(second.inquiry.expires_at).toBe(first.inquiry.expires_at);

    await waitForStatus(world.deps, first.inquiry.id as string, 'pending');
    const third = expectStatus(await inquire(world.app, world.alice), 200);
    expect(third.inquiry.id).toBe(first.inquiry.id);
    expect(third.inquiry.status).toBe('pending');
    expect(third.inquiry.expires_at).toBe(first.inquiry.expires_at);

    // Exactly one outbound delivery for all three requests.
    expect(world.hook.hits).toHaveLength(1);
    const listed = expectStatus(await api(world.app, '/v1/inquiries?role=requester', { token: world.alice }), 200);
    expect(listed.inquiries).toHaveLength(1);
  });

  it('returns contact without asking B again once the grant is active', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    await waitForStatus(world.deps, created.inquiry.id as string, 'pending');
    expectStatus(
      await api(world.app, `/v1/inquiries/${created.inquiry.id}/decision`, { token: world.bob, body: { decision: 'approve' } }),
      200,
    );

    const again = expectStatus(await inquire(world.app, world.alice), 200);
    expect(again.status).toBe('approved');
    expect(again.contact.webhook_url).toBe(world.hook.url);
    expect(again.contact.webhook_auth_value).toBe('Bearer bob-secret');
    expect(again.grant_id).toMatch(/^grt_/);
    // B was not disturbed a second time and no new inquiry exists.
    expect(world.hook.hits).toHaveLength(1);
    const listed = expectStatus(await api(world.app, '/v1/inquiries?role=requester', { token: world.alice }), 200);
    expect(listed.inquiries).toHaveLength(1);
  });

  it('charges controlled refresh to the refresh budget, not the initiation budget (F1)', async () => {
    // Initiation allows 1/min; refresh allows 4/min. If a refresh wrongly paid
    // the initiation budget, the second POST /v1/inquiries would be 429.
    const world = await makeWorld({ config: { inquiryRatePerMin: 1, mutationRatePerMin: 4 } });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    await waitForStatus(world.deps, created.inquiry.id as string, 'pending');
    expectStatus(
      await api(world.app, `/v1/inquiries/${created.inquiry.id}/decision`, { token: world.bob, body: { decision: 'approve' } }),
      200,
    );

    // The first refresh is charged to the refresh bucket; several more still
    // succeed well past the initiation budget's 1/min.
    expectStatus(await inquire(world.app, world.alice), 200);
    expectStatus(await inquire(world.app, world.alice), 200);
    expectStatus(await inquire(world.app, world.alice), 200);
    expect(world.hook.hits).toHaveLength(1);

    // The refresh bucket itself is still enforced (shared with the contact
    // endpoint, design §9.2): 4 used, the 5th within the window is 429.
    expectStatus(await inquire(world.app, world.alice), 200);
    const limited = await inquire(world.app, world.alice);
    expectStatus(limited, 429);
    expect(limited.json.error.code).toBe('rate_limited');
  });

  it('opens a fresh inquiry after a terminal outcome', async () => {
    const world = await makeWorld({ webhook: { statuses: [500] } });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const first = expectStatus(await inquire(world.app, world.alice), 202);
    await waitForStatus(world.deps, first.inquiry.id as string, 'undelivered');

    const second = expectStatus(await inquire(world.app, world.alice), 202);
    expect(second.inquiry.id).not.toBe(first.inquiry.id);
    await waitForStatus(world.deps, second.inquiry.id as string, 'undelivered');
    expect(world.hook.hits).toHaveLength(2);
  });
});

describe('intake control (P0-3①, P0-4⑤)', () => {
  it('blocks inquiries from bots outside the allowlist without any outbound call', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });

    expectStatus(
      await api(world.app, '/v1/me', { method: 'PATCH', token: world.bob, body: { intake: { mode: 'none' } } }),
      200,
    );
    const none = await inquire(world.app, world.alice);
    expectStatus(none, 403);
    expect(none.json.error.code).toBe('inquiry_blocked');

    expectStatus(
      await api(world.app, '/v1/me', {
        method: 'PATCH',
        token: world.bob,
        body: { intake: { mode: 'allowlist', allowlist: ['carol'] } },
      }),
      200,
    );
    const outside = await inquire(world.app, world.alice);
    expectStatus(outside, 403);
    expect(outside.json.error.code).toBe('inquiry_blocked');
    // carol is on the list and may inquire.
    const allowed = expectStatus(await inquire(world.app, world.carol), 202);
    await until(() => world.deps.db.getInquiry(allowed.inquiry.id as string)?.status === 'pending');

    // Blocked requests created no rows and never reached bob's webhook beyond carol's one delivery.
    expect(world.hook.hits).toHaveLength(1);
    expect(world.deps.db.listInquiries({ requesterId: 'alice' })).toHaveLength(0);
  });

  it('blocks inquiries against disabled targets without disturbing them', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const session = await login(world.app);
    expectStatus(await api(world.app, '/admin/api/bots/bob/disable', { method: 'POST', headers: session.headers }), 200);
    const blocked = await inquire(world.app, world.alice);
    expectStatus(blocked, 403);
    expect(blocked.json.error.code).toBe('inquiry_blocked');
    expect(world.hook.hits).toHaveLength(0);
    expect(world.deps.db.listInquiries({ requesterId: 'alice' })).toHaveLength(0);
  });
});

describe('no auto-approval (decision 12)', () => {
  it('has no path to approved other than the target calling decision', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    const inquiryId = created.inquiry.id as string;
    await waitForStatus(world.deps, inquiryId, 'pending');

    // Exhaust the read side: nothing moves pending -> approved.
    const still = expectStatus(await api(world.app, `/v1/inquiries/${inquiryId}`, { token: world.alice }), 200);
    expect(still.inquiry.status).toBe('pending');
    expectStatus(await inquire(world.app, world.alice), 200);
    expectStatus(await api(world.app, '/v1/inquiries?role=target', { token: world.bob }), 200);
    expectStatus(await api(world.app, '/v1/directory', { token: world.alice }), 200);
    expectStatus(
      await api(world.app, '/v1/me', { method: 'PATCH', token: world.bob, body: { capabilities: 'still pending' } }),
      200,
    );
    const noGrants = expectStatus(await api(world.app, '/v1/grants?role=received', { token: world.alice }), 200);
    expect(noGrants.grants).toHaveLength(0);
    expectStatus(await api(world.app, `/v1/grants/grt_does-not-exist/contact`, { token: world.alice }), 404);
    expect(world.deps.db.listGrants({ requesterId: 'alice' })).toHaveLength(0);

    // Wrong actors cannot decide.
    const byRequester = await api(world.app, `/v1/inquiries/${inquiryId}/decision`, {
      token: world.alice,
      body: { decision: 'approve' },
    });
    expectStatus(byRequester, 403);
    expect(byRequester.json.error.code).toBe('not_allowed');
    const byOutsider = await api(world.app, `/v1/inquiries/${inquiryId}/decision`, {
      token: world.carol,
      body: { decision: 'approve' },
    });
    expectStatus(byOutsider, 403);
    expect(byOutsider.json.error.code).toBe('not_allowed');
    expectStatus(
      await api(world.app, `/v1/inquiries/${inquiryId}/decision`, { token: world.bob, body: { decision: 'maybe' } }),
      400,
    );

    expect(world.deps.db.getInquiry(inquiryId)?.status).toBe('pending');

    // The one and only path: the target decides.
    const approved = expectStatus(
      await api(world.app, `/v1/inquiries/${inquiryId}/decision`, { token: world.bob, body: { decision: 'approve' } }),
      200,
    );
    expect(approved.inquiry.status).toBe('approved');
    expect(world.deps.db.listGrants({ requesterId: 'alice' })).toHaveLength(1);
  });

  it('lets B reject, and late decisions hit 409 inquiry_closed', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    const inquiryId = created.inquiry.id as string;
    await waitForStatus(world.deps, inquiryId, 'pending');

    const rejected = expectStatus(
      await api(world.app, `/v1/inquiries/${inquiryId}/decision`, { token: world.bob, body: { decision: 'reject' } }),
      200,
    );
    expect(rejected.inquiry.status).toBe('rejected');
    expect(world.deps.db.listGrants({ requesterId: 'alice' })).toHaveLength(0);

    const late = await api(world.app, `/v1/inquiries/${inquiryId}/decision`, {
      token: world.bob,
      body: { decision: 'approve' },
    });
    expectStatus(late, 409);
    expect(late.json.error.code).toBe('inquiry_closed');
    expect(world.deps.db.getInquiry(inquiryId)?.status).toBe('rejected');
  });

  it('rejects decisions on expired inquiries and expires lazily (24h)', async () => {
    const clock = mutableClock();
    const world = await makeWorld({ clock });
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });
    const created = expectStatus(await inquire(world.app, world.alice), 202);
    const inquiryId = created.inquiry.id as string;
    await waitForStatus(world.deps, inquiryId, 'pending');

    clock.advance(86_400 * 1000 + 1);
    const seen = expectStatus(await api(world.app, `/v1/inquiries/${inquiryId}`, { token: world.alice }), 200);
    expect(seen.inquiry.status).toBe('expired');

    const late = await api(world.app, `/v1/inquiries/${inquiryId}/decision`, {
      token: world.bob,
      body: { decision: 'approve' },
    });
    expectStatus(late, 409);
    expect(late.json.error.code).toBe('inquiry_closed');
    expect(world.deps.db.listGrants({ requesterId: 'alice' })).toHaveLength(0);
  });
});

describe('request validation and visibility', () => {
  it('rejects self-inquiries, unknown targets, bad fields, and hidden inquiries', async () => {
    const world = await makeWorld();
    open.push({ close: async () => { await world.hook.close(); world.deps.db.close(); } });

    const self = await inquire(world.app, world.alice, 'alice');
    expectStatus(self, 400);
    expectStatus(await inquire(world.app, world.alice, 'ghost'), 404);
    const missing = await api(world.app, '/v1/inquiries', { token: world.alice, body: {} });
    expectStatus(missing, 400);
    const extra = await api(world.app, '/v1/inquiries', { token: world.alice, body: { to: 'bob', why: 'nope' } });
    expectStatus(extra, 400);

    const created = expectStatus(await inquire(world.app, world.alice), 202);
    await waitForStatus(world.deps, created.inquiry.id as string, 'pending');
    // Non-parties cannot even see that the inquiry exists.
    expectStatus(await api(world.app, `/v1/inquiries/${created.inquiry.id}`, { token: world.carol }), 404);
    expectStatus(await api(world.app, '/v1/inquiries?role=bogus', { token: world.alice }), 400);
    expectStatus(await api(world.app, '/v1/inquiries?status=weird', { token: world.alice }), 400);
  });

  it('rate limits new inquiries per bot and per pair', async () => {
    const tight = await makeWorld({ config: { inquiryRatePerMin: 1 }, webhook: { statuses: [500] } });
    open.push({ close: async () => { await tight.hook.close(); tight.deps.db.close(); } });
    expectStatus(await inquire(tight.app, tight.alice), 202);
    const limited = await inquire(tight.app, tight.alice);
    expectStatus(limited, 429);
    expect(limited.json.error.code).toBe('rate_limited');
    expect(limited.json.error.retry_after).toBeGreaterThan(0);

    const pairs = await makeWorld({ config: { inquiryPairRatePerHour: 2 }, webhook: { statuses: [500] } });
    open.push({ close: async () => { await pairs.hook.close(); pairs.deps.db.close(); } });
    const first = expectStatus(await inquire(pairs.app, pairs.alice), 202);
    await waitForStatus(pairs.deps, first.inquiry.id as string, 'undelivered');
    const second = expectStatus(await inquire(pairs.app, pairs.alice), 202);
    await waitForStatus(pairs.deps, second.inquiry.id as string, 'undelivered');
    const blocked = await inquire(pairs.app, pairs.alice);
    expectStatus(blocked, 429);
    expect(blocked.json.error.code).toBe('inquiry_rate_limited');
    // The pair cap does not affect a different requester.
    expectStatus(await inquire(pairs.app, pairs.carol), 202);
  });
});
