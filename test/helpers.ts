import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

import type { Hono } from 'hono';

import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Deps } from '../src/deps.js';
import { openDatabase } from '../src/db.js';

export const ADMIN = 'test-admin-token';
export const SECRET = 'test-relay-secret-0123456789';

export type ApiResult = {
  status: number;
  json: any;
  headers: Headers;
  text: string;
};

export function makeApp(overrides: Partial<Config> = {}): { app: Hono; deps: Deps } {
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    adminToken: ADMIN,
    relaySecret: SECRET,
    maxHops: 8,
    rateLimitMax: 60,
    rateLimitWindowSec: 60,
    deliveryTimeoutMs: 1000,
    deliveryMaxAttempts: 4,
    deliveryBackoffMs: 1000,
    deliveryPollMs: 50,
    bodyMaxChars: 16_000,
    metadataMaxChars: 4096,
    signatureToleranceSec: 300,
    idempotencyTtlSec: 86_400,
    allowHttpWebhooks: true,
    allowPrivateWebhooks: true,
    publicBaseUrl: null,
    a2aBlockTimeoutMs: 20_000,
    encryptionKey: null,
    trustProxy: false,
    authRateLimitMax: 30,
    adminSessionTtlSec: 3600,
    ...overrides,
    databasePath: ':memory:',
  };
  const db = openDatabase(':memory:');
  const deps: Deps = { config, db, now: () => 1_700_000_000_000 };
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
