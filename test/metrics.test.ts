import { afterEach, describe, expect, it } from 'vitest';

import {
  ADMIN,
  api,
  createInvite,
  expectStatus,
  login,
  makeApp,
  mutableClock,
  registerBot,
  startWebhook,
  until,
} from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

async function metricsText(app: Parameters<typeof api>[0]): Promise<string> {
  const res = await api(app, '/metrics', { token: ADMIN });
  expect(res.status, `metrics failed: ${res.text}`).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text;
}

describe('GET /metrics (P0-11)', () => {
  it('requires deployer auth and serves Prometheus text', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });

    const anon = await api(app, '/metrics');
    expectStatus(anon, 401);
    expect(anon.json.error.code).toBe('unauthorized');
    expectStatus(await api(app, '/metrics', { token: 'totally-wrong-token' }), 401);

    // A bot token is not a deployer credential either.
    const session = await login(app);
    const invite = await createInvite(app, session);
    const alice = await registerBot(app, { id: 'alice', invite: invite.code });
    expectStatus(await api(app, '/metrics', { token: alice }), 401);

    const text = await metricsText(app);
    expect(text).toContain('# TYPE bots_registered gauge');
    expect(text).toContain('bots_registered 1');
    expect(text).toContain('bots_disabled 0');
  });

  it('exposes scale, inquiry, identity, discovery, security, and latency series', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const hook = await startWebhook();
    open.push({ close: () => hook.close() });
    const session = await login(app);
    const alice = await registerBot(app, { id: 'alice', invite: (await createInvite(app, session)).code });
    const bob = await registerBot(app, {
      id: 'bob',
      invite: (await createInvite(app, session)).code,
      extra: { webhook_url: hook.url },
    });

    expectStatus(await api(app, '/v1/directory', { token: alice }), 200);
    expectStatus(await api(app, '/v1/directory/bob', { token: alice }), 200);

    const proof = expectStatus(await api(app, '/v1/identity-token', { method: 'POST', token: alice }), 200);
    expectStatus(
      await api(app, '/v1/identity/verify', { token: alice, body: { token: (proof as { token: string }).token } }),
      200,
    );
    expectStatus(await api(app, '/v1/identity/verify', { token: alice, body: { token: 'garbage' } }), 401);

    const created = expectStatus(await api(app, '/v1/inquiries', { token: alice, body: { to: 'bob' } }), 202);
    const inquiryId = created.inquiry.id as string;
    await until(() => deps.db.getInquiry(inquiryId)?.status === 'pending');
    expectStatus(
      await api(app, `/v1/inquiries/${inquiryId}/decision`, { token: bob, body: { decision: 'approve' } }),
      200,
    );
    const grants = expectStatus(await api(app, '/v1/grants?role=received', { token: alice }), 200);
    expectStatus(await api(app, `/v1/grants/${grants.grants[0].id}/contact`, { token: alice }), 200);

    expectStatus(await api(app, '/admin/login', { body: { token: 'nope-wrong' } }), 401);
    expectStatus(await api(app, '/admin/api/bots/bob/disable', { method: 'POST', headers: session.headers }), 200);

    const text = await metricsText(app);
    for (const line of [
      'bots_registered 2',
      'bots_disabled 1',
      'grants_active 1',
      'directory_lookups_total 2',
      'identity_tokens_issued_total 1',
      'identity_verify_total{result="invalid"} 1',
      'identity_verify_total{result="valid"} 1',
      'inquiries_created_total 1',
      'inquiry_outcome_total{outcome="pending"} 1',
      'inquiry_outcome_total{outcome="approved"} 1',
      'grants_refresh_total 1',
      'admin_login_failures_total 1',
    ]) {
      expect(text).toContain(line);
    }
    // Latency histogram: bucket + summary series for a business route.
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toMatch(/http_request_duration_seconds_count\{route="GET \/v1\/directory",status="200"\} 1/);
    expect(text).toMatch(/http_request_duration_seconds_bucket\{le="0\.1",route="GET \/v1\/directory",status="200"\} 1/);
    // Only control-plane series: nothing about messages or relays (P0-11③).
    expect(text).not.toMatch(/^(messages|delivery_attempts|a2a)_total/m);
  });

  it('counts rate limited requests by scope', async () => {
    const { app, deps } = makeApp({ defaultRatePerMin: 1 });
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const alice = await registerBot(app, { id: 'alice', invite: (await createInvite(app, session)).code });

    expectStatus(await api(app, '/v1/directory', { token: alice }), 200);
    expectStatus(await api(app, '/v1/directory', { token: alice }), 429);
    const text = await metricsText(app);
    expect(text).toContain('rate_limited_total{scope="directory"} 1');
  });

  it('classifies failed deliveries by reason and sweeps expired inquiries', async () => {
    const clock = mutableClock();
    const { app, deps } = makeApp({}, { now: clock.now });
    open.push({ close: () => deps.db.close() });
    const failing = await startWebhook({ statuses: [500] });
    open.push({ close: () => failing.close() });
    const ok = await startWebhook();
    open.push({ close: () => ok.close() });
    const session = await login(app);
    const alice = await registerBot(app, { id: 'alice', invite: (await createInvite(app, session)).code });
    await registerBot(app, {
      id: 'carol',
      invite: (await createInvite(app, session)).code,
      extra: { webhook_url: failing.url },
    });
    await registerBot(app, {
      id: 'dave',
      invite: (await createInvite(app, session)).code,
      extra: { webhook_url: ok.url },
    });

    const failed = expectStatus(await api(app, '/v1/inquiries', { token: alice, body: { to: 'carol' } }), 202);
    await until(() => deps.db.getInquiry(failed.inquiry.id as string)?.status === 'undelivered');
    let text = await metricsText(app);
    expect(text).toContain('inquiry_outcome_total{outcome="undelivered"} 1');
    expect(text).toContain('inquiry_delivery_failures_total{reason="http_error"} 1');

    const pending = expectStatus(await api(app, '/v1/inquiries', { token: alice, body: { to: 'dave' } }), 202);
    await until(() => deps.db.getInquiry(pending.inquiry.id as string)?.status === 'pending');
    clock.advance(25 * 3600 * 1000);
    expectStatus(await api(app, '/v1/inquiries?role=requester', { token: alice }), 200);
    expect(deps.db.getInquiry(pending.inquiry.id as string)?.status).toBe('expired');
    text = await metricsText(app);
    expect(text).toContain('inquiry_outcome_total{outcome="expired"} 1');
  });
});
