import { afterEach, describe, expect, it } from 'vitest';

import { attemptDelivery } from '../src/delivery.js';
import { HttpError } from '../src/errors.js';
import { assertWebhookUrl } from '../src/ssrf.js';
import { ADMIN, api, expectStatus, makeApp, startWebhook } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

async function pair(maxHops = 8) {
  const hook = await startWebhook();
  const ctx = makeApp({ maxHops, rateLimitMax: 10, rateLimitWindowSec: 60 });
  open.push({ close: () => ctx.deps.db.close() }, hook);
  const alice = expectStatus(
    await api(ctx.app, '/bots', {
      token: ADMIN,
      body: { id: 'alice', display_name: 'Alice', webhook_url: hook.url },
    }),
    201,
  );
  const bob = expectStatus(
    await api(ctx.app, '/bots', {
      token: ADMIN,
      body: { id: 'bob', display_name: 'Bob', webhook_url: hook.url },
    }),
    201,
  );
  return { ...ctx, hook, alice, bob };
}

describe('hop limit', () => {
  it('stops a thread once the hop count is exhausted, including replies to an earlier message', async () => {
    const { app, alice, bob } = await pair(3);
    const first = expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'one', thread_id: 'thread-loop' } }),
      202,
    );
    expect(first.hop).toBe(1);
    const second = expectStatus(
      await api(app, '/messages', { token: bob.token, body: { to: 'alice', body: 'two', thread_id: 'thread-loop' } }),
      202,
    );
    expect(second.hop).toBe(2);
    const third = expectStatus(
      await api(app, '/messages', {
        token: alice.token,
        body: { to: 'bob', body: 'three', thread_id: 'thread-loop', reply_to: second.id },
      }),
      202,
    );
    expect(third.hop).toBe(3);
    const blocked = await api(app, '/messages', {
      token: bob.token,
      body: { to: 'alice', body: 'four', reply_to: first.id },
    });
    expectStatus(blocked, 409);
    expect(blocked.json.error.code).toBe('hop_limit');

    const fresh = expectStatus(
      await api(app, '/messages', { token: bob.token, body: { to: 'alice', body: 'new topic' } }),
      202,
    );
    expect(fresh.hop).toBe(1);
    expect(fresh.thread_id).not.toBe('thread-loop');
  });

  it('does not let a third bot join an existing thread', async () => {
    const { app, alice } = await pair();
    const first = expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'private', thread_id: 'private-thread' } }),
      202,
    );
    const carol = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'carol', display_name: 'Carol' } }),
      201,
    );
    const joined = await api(app, '/messages', {
      token: carol.token,
      body: { to: 'alice', body: 'intrude', thread_id: 'private-thread' },
    });
    expectStatus(joined, 403);
    const replied = await api(app, '/messages', {
      token: carol.token,
      body: { to: 'bob', body: 'intrude', reply_to: first.id },
    });
    expectStatus(replied, 403);
  });
});

describe('idempotency and dedupe', () => {
  it('delivers an idempotency key once and does not deliver a message id twice', async () => {
    const { app, deps, hook, alice } = await pair();
    const headers = { 'idempotency-key': 'greeting-1' };
    const first = expectStatus(
      await api(app, '/messages', {
        token: alice.token,
        headers,
        body: { to: 'bob', body: 'hello once' },
      }),
      202,
    );
    const replayResult = await api(app, '/messages', {
      token: alice.token,
      headers,
      body: { to: 'bob', body: 'hello once' },
    });
    const replay = expectStatus(replayResult, 200);
    expect(replay.id).toBe(first.id);
    expect(replayResult.headers.get('idempotent-replayed')).toBe('true');
    expect(hook.hits).toHaveLength(1);

    const conflict = await api(app, '/messages', {
      token: alice.token,
      headers,
      body: { to: 'bob', body: 'different body' },
    });
    expectStatus(conflict, 409);
    expect(conflict.json.error.code).toBe('idempotency_conflict');
    expect(hook.hits).toHaveLength(1);

    await attemptDelivery(deps, first.id);
    expect(hook.hits).toHaveLength(1);
  });
});

describe('rate limit', () => {
  it('limits each sender and lets the window expire', async () => {
    const { app, deps } = makeApp({ rateLimitMax: 2, rateLimitWindowSec: 60 });
    open.push({ close: () => deps.db.close() });
    let now = 1_000_000;
    deps.now = () => now;
    const alice = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'alice', display_name: 'Alice' } }),
      201,
    );
    expectStatus(await api(app, '/bots', { token: ADMIN, body: { id: 'bob', display_name: 'Bob' } }), 201);
    const first = expectStatus(
      await api(app, '/messages', {
        token: alice.token,
        headers: { 'idempotency-key': 'keep' },
        body: { to: 'bob', body: 'one' },
      }),
      202,
    );
    expectStatus(await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'two' } }), 202);
    const limited = await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'three' } });
    expectStatus(limited, 429);
    expect(limited.json.error.code).toBe('rate_limited');
    expect(limited.json.error.retry_after).toBe(60);
    expect(limited.headers.get('retry-after')).toBe('60');

    const replayed = await api(app, '/messages', {
      token: alice.token,
      headers: { 'idempotency-key': 'keep' },
      body: { to: 'bob', body: 'one' },
    });
    const replay = expectStatus(replayed, 200);
    expect(replay.id).toBe(first.id);

    now += 60_001;
    expectStatus(await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'later' } }), 202);
  });
});

describe('allowlists', () => {
  it('lets a recipient choose who may message them', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const alice = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'alice', display_name: 'Alice' } }),
      201,
    );
    const bob = expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: { id: 'bob', display_name: 'Bob', allowlist: ['carol'] },
      }),
      201,
    );
    const carol = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'carol', display_name: 'Carol', allowlist: [] } }),
      201,
    );
    const denied = await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'hi' } });
    expectStatus(denied, 403);
    expect(denied.json.error.code).toBe('not_allowed');
    const allowed = expectStatus(
      await api(app, '/messages', { token: carol.token, body: { to: 'bob', body: 'hi' } }),
      202,
    );
    expect(allowed.from).toBe('carol');
    const closed = await api(app, '/messages', { token: alice.token, body: { to: 'carol', body: 'hi' } });
    expectStatus(closed, 403);

    expectStatus(
      await api(app, '/bots/me', { method: 'PATCH', token: bob.token, body: { allowlist: null } }),
      200,
    );
    expectStatus(await api(app, '/messages', { token: alice.token, body: { to: 'bob', body: 'now ok' } }), 202);
  });
});

describe('webhook URL protections', () => {
  const blocked = { allowHttp: false, allowPrivate: false };

  it('rejects private, loopback, credentialed, and plaintext URLs unless explicitly allowed', async () => {
    await expect(assertWebhookUrl('https://example.com/hook', { ...blocked, lookupHost: async () => ['8.8.8.8'] })).resolves.toBe(
      'https://example.com/hook',
    );
    await expect(
      assertWebhookUrl('https://example.com/hook', { ...blocked, lookupHost: async () => ['8.8.8.8', '10.0.0.1'] }),
    ).rejects.toBeInstanceOf(HttpError);
    for (const url of [
      'http://example.com/hook',
      'https://127.0.0.1/hook',
      'https://10.1.2.3/hook',
      'https://169.254.169.254/latest',
      'https://2130706433/',
      'https://[::1]/hook',
      'https://localhost/hook',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://user:pass@example.com/hook',
    ]) {
      await expect(assertWebhookUrl(url, { ...blocked, lookupHost: async () => ['8.8.8.8'] })).rejects.toMatchObject({
        code: 'invalid_webhook',
      });
    }
    await expect(
      assertWebhookUrl('http://127.0.0.1:9/hook', { allowHttp: true, allowPrivate: true }),
    ).resolves.toBe('http://127.0.0.1:9/hook');
  });
});
