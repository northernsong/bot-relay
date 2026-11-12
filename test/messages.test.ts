import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { pumpDeliveries } from '../src/delivery.js';
import { verifySignature } from '../src/sign.js';
import { ADMIN, api, expectStatus, makeApp, SECRET, startWebhook } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

describe('sending and delivery', () => {
  it('sets from itself and forwards a verifiable envelope to the recipient webhook', async () => {
    const hook = await startWebhook();
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() }, hook);
    const alice = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'alice', display_name: 'Alice' } }),
      201,
    );
    const bob = expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: {
          id: 'bob',
          display_name: 'Bob',
          webhook_url: hook.url,
          auth_header_name: 'X-Webhook-Secret',
          auth_header_value: 'super-secret-webhook-key',
        },
      }),
      201,
    );

    expectStatus(await api(app, '/messages', { body: { to: 'bob', body: 'hello' } }), 401);
    expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'hello', from: 'mallory' } }),
      400,
    );

    const sent = expectStatus(
      await api(app, '/messages', {
        token: alice.token,
        body: { to: 'bob', body: 'hello bob', metadata: { mood: 'friendly' } },
      }),
      202,
    );
    expect(sent.from).toBe('alice');
    expect(sent.to).toBe('bob');
    expect(sent.hop).toBe(1);
    expect(sent.status).toBe('delivered');
    expect(sent.attempts).toBe(1);
    expect(hook.hits).toHaveLength(1);

    const hit = hook.hits[0];
    expect(hit).toBeDefined();
    const signature = String(hit?.headers['x-bot-relay-signature']);
    const timestamp = String(hit?.headers['x-bot-relay-timestamp']);
    expect(hit?.headers['x-webhook-secret']).toBe('super-secret-webhook-key');
    expect(hit?.headers['x-bot-relay-id']).toBe(sent.id);
    expect(String(hit?.headers['content-type'])).toContain('application/json');
    expect(signature.startsWith(`t=${timestamp},v1=`)).toBe(true);
    const mac = createHmac('sha256', SECRET).update(`${timestamp}.${hit?.body}`).digest('hex');
    expect(signature).toBe(`t=${timestamp},v1=${mac}`);
    expect(verifySignature(hit?.body ?? '', signature, SECRET, Math.floor(deps.now() / 1000), 300)).toBe(true);

    const envelope = JSON.parse(hit?.body ?? '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({
      v: 1,
      id: sent.id,
      from: 'alice',
      to: 'bob',
      hop: 1,
      max_hops: 8,
      body: 'hello bob',
      metadata: { mood: 'friendly' },
      reply_to: null,
    });
    expect(envelope.thread_id).toEqual(sent.thread_id);
    expect(typeof envelope.timestamp).toBe('string');

    const viewed = expectStatus(await api(app, `/messages/${sent.id}`, { token: bob.token }), 200);
    expect(viewed.status).toBe('delivered');
    expect(viewed.delivery).toHaveLength(1);
    const stranger = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'carol', display_name: 'Carol' } }),
      201,
    );
    expectStatus(await api(app, `/messages/${sent.id}`, { token: stranger.token }), 404);
    expect(bob.token).toMatch(/^rl_/);
  });

  it('keeps a copy in the inbox for a bot with no webhook', async () => {
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
    const sent = expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'ping' } }),
      202,
    );
    expect(sent.status).toBe('inbox');
    const inbox = expectStatus(await api(app, '/inbox', { token: bob.token }), 200);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].body).toBe('ping');
    expect(inbox.messages[0].from).toBe('alice');

    const reply = expectStatus(
      await api(app, '/messages', {
        token: bob.token,
        body: { to: 'alice', body: 'pong', thread_id: sent.thread_id, reply_to: sent.id },
      }),
      202,
    );
    expect(reply.hop).toBe(2);
    expect(reply.thread_id).toBe(sent.thread_id);

    expectStatus(await api(app, '/inbox/ack', { token: bob.token, body: { ids: [sent.id] } }), 200);
    const after = expectStatus(await api(app, '/inbox', { token: bob.token }), 200);
    expect(after.messages).toEqual([]);
    const aliceInbox = expectStatus(await api(app, '/inbox', { token: alice.token }), 200);
    expect(aliceInbox.messages.map((message: { id: string }) => message.id)).toEqual([reply.id]);
  });

  it('retries 5xx and timeouts, and does not retry a 4xx or a redirect', async () => {
    const flaky = await startWebhook({ statuses: [500, 500, 200] });
    const denied = await startWebhook({ statuses: [400] });
    const redirected = await startWebhook({ statuses: [302] });
    const hanging = await startWebhook({ hang: true });
    const { app, deps } = makeApp({ deliveryMaxAttempts: 3, deliveryBackoffMs: 1000, deliveryTimeoutMs: 200 });
    open.push(
      { close: () => deps.db.close() },
      flaky,
      denied,
      redirected,
      hanging,
    );
    let now = 1_700_000_000_000;
    deps.now = () => now;

    const alice = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'alice', display_name: 'Alice' } }),
      201,
    );
    expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: { id: 'bob', display_name: 'Bob', webhook_url: flaky.url },
      }),
      201,
    );

    const first = expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'retry me' } }),
      202,
    );
    expect(first.status).toBe('pending');
    expect(first.attempts).toBe(1);
    expect(flaky.hits).toHaveLength(1);

    now += 1000;
    await pumpDeliveries(deps);
    expect(flaky.hits).toHaveLength(2);
    now += 2000;
    await pumpDeliveries(deps);
    expect(flaky.hits).toHaveLength(3);
    const done = expectStatus(await api(app, `/messages/${first.id}`, { token: alice.token }), 200);
    expect(done.status).toBe('delivered');
    expect(done.delivery.map((entry: { status_code: number | null }) => entry.status_code)).toEqual([500, 500, 200]);

    expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: { id: 'carol', display_name: 'Carol', webhook_url: denied.url },
      }),
      201,
    );
    const rejected = expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'carol', body: 'nope' } }),
      202,
    );
    expect(rejected.status).toBe('failed');
    expect(rejected.last_error).toBe('HTTP 400');
    now += 60_000;
    await pumpDeliveries(deps);
    expect(denied.hits).toHaveLength(1);

    expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: { id: 'dave', display_name: 'Dave', webhook_url: redirected.url },
      }),
      201,
    );
    const bounced = expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'dave', body: 'go' } }),
      202,
    );
    expect(bounced.status).toBe('failed');
    expect(bounced.last_error).toBe('redirect not allowed');
    expect(redirected.hits).toHaveLength(1);

    expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: { id: 'erin', display_name: 'Erin', webhook_url: hanging.url },
      }),
      201,
    );
    const timed = expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'erin', body: 'wait' } }),
      202,
    );
    expect(timed.status).toBe('pending');
    expect(timed.last_error).toBe('timeout');
    expect(timed.attempts).toBe(1);
  });
});
