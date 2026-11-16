import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { expect } from 'vitest';

import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Deps } from '../src/deps.js';
import { openDatabase } from '../src/db.js';

export const ADMIN = 'test-admin-token';
export const ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef';

export type ApiResult = {
  status: number;
  json: any;
  headers: Headers;
  text: string;
};

export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    adminToken: ADMIN,
    encryptionKey: ENCRYPTION_KEY,
    publicBaseUrl: 'https://relay.example.test',
    trustedProxies: ['127.0.0.1/32', '::1/128'],
    adminSessionTtlSec: 3600,
    allowHttpWebhooks: true,
    allowPrivateWebhooks: true,
    rateLimitWindowSec: 60,
    inquiryTtlSec: 86_400,
    inquiryDeliveryTimeoutMs: 1000,
    identityTokenTtlSec: 300,
    registerRatePerMin: 100,
    loginRatePerMin: 100,
    inquiryRatePerMin: 100,
    inquiryPairRatePerHour: 100,
    mutationRatePerMin: 100,
    defaultRatePerMin: 100,
    ...overrides,
    databasePath: ':memory:',
  };
}

export function makeApp(
  overrides: Partial<Config> = {},
  depsOverrides: Partial<Deps> = {},
): { app: Hono; deps: Deps } {
  const config = baseConfig(overrides);
  const db = openDatabase(':memory:');
  const deps: Deps = { config, db, now: () => 1_700_000_000_000, ...depsOverrides };
  return { app: createApp(deps), deps };
}

export async function api(
  app: Hono,
  path: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] ??= 'application/json';
  const res = await app.request(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = text;
    }
  }
  return { status: res.status, json, headers: res.headers, text };
}

export function expectStatus(result: ApiResult, status: number): any {
  if (result.status !== status) {
    throw new Error(`expected HTTP ${status} but got ${result.status}: ${result.text}`);
  }
  return result.json;
}

export async function login(app: Hono) {
  const res = await api(app, '/admin/login', {
    body: { token: ADMIN },
    headers: { accept: 'application/json' },
  });
  const body = expectStatus(res, 200);
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  const pair = cookie.split(';')[0] ?? '';
  return { csrf: body.csrf as string, cookie: pair, headers: { cookie: pair, 'x-csrf-token': body.csrf as string } };
}

/** Create a bot directly through the invite + register flow and return its token. */
export async function registerBot(
  app: Hono,
  input: { id: string; display_name?: string; invite: string; extra?: Record<string, unknown> },
): Promise<string> {
  const created = expectStatus(
    await api(app, '/v1/register', {
      body: {
        invite_code: input.invite,
        id: input.id,
        display_name: input.display_name ?? input.id,
        webhook_url: 'http://127.0.0.1:9/hook',
        ...(input.extra ?? {}),
      },
    }),
    201,
  );
  return created.token as string;
}

export async function createInvite(
  app: Hono,
  session: { headers: Record<string, string> },
  body: Record<string, unknown> = {},
): Promise<{ id: number; code: string }> {
  const created = expectStatus(
    await api(app, '/admin/api/invites', { body: { max_uses: 1, ...body }, headers: session.headers }),
    201,
  );
  return { id: created.invite.id as number, code: created.invite.code as string };
}

/**
 * Serve the app on a real loopback socket so peer-address-based trust
 * decisions (TRUSTED_PROXIES) behave as in production.
 */
export async function startServer(app: Hono): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Fixed-by-default clock that a test can advance for expiry scenarios. */
export function mutableClock(base = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = base;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** Poll until cond() is true (background delivery settles asynchronously). */
export async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function startWebhook(opts?: { statuses?: number[]; hang?: boolean }): Promise<{
  url: string;
  hits: Array<{ body: string; headers: IncomingHttpHeaders }>;
  close: () => Promise<void>;
}> {
  const hits: Array<{ body: string; headers: IncomingHttpHeaders }> = [];
  let n = 0;
  const statuses = opts?.statuses ?? [200];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      if (opts?.hang) return;
      const status = statuses[Math.min(n, statuses.length - 1)] ?? 200;
      n += 1;
      const headers: Record<string, string> = {};
      if (status >= 300 && status < 400) headers.location = 'http://127.0.0.1/blocked';
      res.writeHead(status, headers);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('webhook test server has no port');
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
