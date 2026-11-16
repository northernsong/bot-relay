import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HttpError } from '../src/errors.js';
import { isBlockedIp, BlockedAddressError, assertWebhookUrl, pinnedFetch } from '../src/ssrf.js';
import { api, createInvite, expectStatus, login, makeApp, startWebhook } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

describe('webhook URL static validation', () => {
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
      'https://example.com/hook#fragment',
    ]) {
      await expect(assertWebhookUrl(url, { ...blocked, lookupHost: async () => ['8.8.8.8'] })).rejects.toMatchObject({
        code: 'invalid_webhook',
      });
    }
    await expect(
      assertWebhookUrl('http://127.0.0.1:9/hook', { allowHttp: true, allowPrivate: true }),
    ).resolves.toBe('http://127.0.0.1:9/hook');
  });

  it('blocks the reserved 240.0.0.0/4 range and 6to4 2002::/16', async () => {
    expect(isBlockedIp('240.0.0.1')).toBe(true);
    expect(isBlockedIp('255.0.0.1')).toBe(true);
    expect(isBlockedIp('198.51.100.7')).toBe(true);
    expect(isBlockedIp('2002:c000:0200::1')).toBe(true);
    expect(isBlockedIp('2606:4700::1')).toBe(false);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    await expect(
      assertWebhookUrl('https://example.com/hook', { ...blocked, lookupHost: async () => ['240.1.2.3'] }),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
    await expect(
      assertWebhookUrl('https://example.com/hook', { ...blocked, lookupHost: async () => ['2002:c000:0200::1'] }),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
  });

  it('treats resolution failure as a disallowed address', async () => {
    await expect(
      assertWebhookUrl('https://no-such-host.test/hook', { ...blocked, lookupHost: async () => Promise.reject(new Error('NXDOMAIN')) }),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
    await expect(
      assertWebhookUrl('https://empty.test/hook', { ...blocked, lookupHost: async () => [] }),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
  });

  it('enforces the same checks at registration time', async () => {
    const hook = await startWebhook();
    let answer = ['8.8.8.8'];
    const { app, deps } = makeApp(
      { allowHttpWebhooks: false, allowPrivateWebhooks: false },
      { lookup: async () => answer },
    );
    open.push({ close: () => deps.db.close() }, hook);
    const session = await login(app);
    const invite = await createInvite(app, session);

    const rejected = await api(app, '/v1/register', {
      body: {
        invite_code: invite.code,
        id: 'alice',
        display_name: 'Alice',
        webhook_url: 'http://127.0.0.1:9/hook',
      },
    });
    expectStatus(rejected, 400);
    expect(rejected.json.error.code).toBe('invalid_webhook');

    // The failed attempt did not consume the invite.
    const retry = await api(app, '/v1/register', {
      body: {
        invite_code: invite.code,
        id: 'alice',
        display_name: 'Alice',
        webhook_url: 'https://example.test/hook',
      },
    });
    expectStatus(retry, 201);

    answer = ['10.1.2.3'];
    const second = await createInvite(app, session);
    const privateAnswer = await api(app, '/v1/register', {
      body: {
        invite_code: second.code,
        id: 'bob',
        display_name: 'Bob',
        webhook_url: 'https://internal.test/hook',
      },
    });
    expectStatus(privateAnswer, 400);
    expect(privateAnswer.json.error.code).toBe('invalid_webhook');
  });
});

describe('pinnedFetch', () => {
  it('resolves again at connect time and refuses a private answer', async () => {
    const hits: string[] = [];
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      hits.push(req.headers.host ?? '');
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    open.push({
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      },
    });
    const port = (server.address() as { port: number }).port;
    let lookups = 0;
    await expect(
      pinnedFetch(`http://rebinding.test:${port}/hook`, { method: 'POST', body: 'x' }, {
        allowHttp: true,
        allowPrivate: false,
        timeoutMs: 1000,
        lookupHost: async () => {
          lookups += 1;
          return ['10.1.2.3'];
        },
      }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
    expect(lookups).toBe(1);
    expect(hits).toEqual([]);

    const ok = await pinnedFetch(`http://hook.test:${port}/hook`, { method: 'POST', body: 'hello' }, {
      allowHttp: true,
      allowPrivate: true,
      timeoutMs: 1000,
      lookupHost: async () => {
        lookups += 1;
        return ['127.0.0.1'];
      },
    });
    expect(ok.status).toBe(200);
    expect(hits).toEqual([`hook.test:${port}`]);
    expect(lookups).toBe(2);
  });

  it('never follows redirects', async () => {
    const hook = await startWebhook({ statuses: [302] });
    open.push(hook);
    await expect(
      pinnedFetch(hook.url, { method: 'POST', body: 'x' }, {
        allowHttp: true,
        allowPrivate: true,
        timeoutMs: 1000,
        lookupHost: async () => ['127.0.0.1'],
      }),
    ).rejects.toThrow(/fetch failed|redirect/);
    expect(hook.hits).toHaveLength(1);
  });

  it('has no call sites outside ssrf.ts; outbound delivery arrives in phase B', () => {
    const srcDir = join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && full !== join(srcDir, 'ssrf.ts')) {
          if (readFileSync(full, 'utf8').includes('pinnedFetch')) offenders.push(full);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe('rate limits', () => {
  it('limits registration per source and lets the window expire', async () => {
    const { app, deps } = makeApp({ registerRatePerMin: 2 });
    open.push({ close: () => deps.db.close() });
    let now = 1_000_000;
    deps.now = () => now;
    const session = await login(app);
    const invite = await createInvite(app, session, { max_uses: 100 });

    const register = () =>
      api(app, '/v1/register', {
        body: { invite_code: invite.code, id: `bot${Math.floor(Math.random() * 1e9)}`, display_name: 'B', webhook_url: 'http://127.0.0.1:9/hook' },
      });
    expectStatus(await register(), 201);
    expectStatus(await register(), 201);
    const limited = await register();
    expectStatus(limited, 429);
    expect(limited.json.error.code).toBe('rate_limited');
    expect(limited.json.error.retry_after).toBe(60);
    expect(limited.headers.get('retry-after')).toBe('60');

    now += 60_001;
    expectStatus(await register(), 201);
  });

  it('rate limit buckets are keyed per purpose', async () => {
    const { app, deps } = makeApp({ registerRatePerMin: 1, loginRatePerMin: 5 });
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const invite = await createInvite(app, session);
    expectStatus(
      await api(app, '/v1/register', {
        body: { invite_code: invite.code, id: 'alice', display_name: 'Alice', webhook_url: 'http://127.0.0.1:9/hook' },
      }),
      201,
    );
    const limited = await api(app, '/v1/register', {
      body: { invite_code: 'inv_not-a-real-invite-x', id: 'bob', display_name: 'Bob', webhook_url: 'http://127.0.0.1:9/hook' },
    });
    expectStatus(limited, 429);
    // Login attempts use their own bucket.
    expectStatus(
      await api(app, '/admin/login', { body: { token: 'wrong' }, headers: { accept: 'application/json' } }),
      401,
    );
  });
});
