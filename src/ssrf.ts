import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

import type { LookupFn } from './deps.js';
import { HttpError } from './errors.js';

const blocked = new BlockList();

function block4(subnet: string, prefix: number): void {
  blocked.addSubnet(subnet, prefix, 'ipv4');
}
function block6(subnet: string, prefix: number): void {
  blocked.addSubnet(subnet, prefix, 'ipv6');
}

block4('0.0.0.0', 8);
block4('10.0.0.0', 8);
block4('100.64.0.0', 10);
block4('127.0.0.0', 8);
block4('169.254.0.0', 16);
block4('172.16.0.0', 12);
block4('192.0.0.0', 24);
block4('192.0.2.0', 24);
block4('192.168.0.0', 16);
block4('198.18.0.0', 15);
block4('198.51.100.0', 24);
block4('203.0.113.0', 24);
block4('224.0.0.0', 4);
blocked.addAddress('255.255.255.255', 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
block6('fc00::', 7);
block6('fe80::', 10);
block6('ff00::', 8);
block6('2001:db8::', 32);

export function isBlockedIp(raw: string): boolean {
  const host = stripBrackets(raw.trim().toLowerCase());
  const family = isIP(host);
  if (family === 4) return blocked.check(host, 'ipv4');
  if (family === 6) return blocked.check(host, 'ipv6');
  return true;
}

export async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export async function assertWebhookUrl(
  raw: string,
  opts: { allowHttp: boolean; allowPrivate: boolean; lookupHost?: LookupFn },
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url is not a valid URL');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url must not include credentials');
  }
  if (url.hash) {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url must not include a fragment');
  }
  const https = url.protocol === 'https:';
  const httpOk = opts.allowHttp && url.protocol === 'http:';
  if (!https && !httpOk) {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url must use https');
  }
  const host = stripBrackets(url.hostname).toLowerCase();
  if (!host) throw new HttpError(400, 'invalid_webhook', 'webhook_url is missing a host');

  if (!opts.allowPrivate) {
    if (isBlockedHostname(host)) {
      throw new HttpError(400, 'invalid_webhook', 'webhook_url host is not allowed');
    }
    if (isIP(host)) {
      if (isBlockedIp(host)) {
        throw new HttpError(400, 'invalid_webhook', 'webhook_url host is not allowed');
      }
    } else {
      const resolve = opts.lookupHost ?? defaultLookup;
      let addresses: string[];
      try {
        addresses = await resolve(host);
      } catch {
        throw new HttpError(400, 'invalid_webhook', 'webhook_url host could not be resolved');
      }
      if (addresses.length === 0 || addresses.some((address) => isBlockedIp(address))) {
        throw new HttpError(400, 'invalid_webhook', 'webhook_url host is not allowed');
      }
    }
  }

  return url.href;
}

function isBlockedHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal' ||
    host === 'metadata.internal'
  );
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

export class BlockedAddressError extends Error {
  constructor(message = 'webhook host is not allowed') {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

export type PinPolicy = {
  allowHttp: boolean;
  allowPrivate: boolean;
  lookupHost?: LookupFn;
  timeoutMs: number;
};

/**
 * Fetch that resolves DNS at connect time and pins the socket to a validated address.
 * The URL hostname is preserved for Host and TLS SNI. Redirects are never followed.
 */
export async function pinnedFetch(input: string, init: RequestInit | undefined, policy: PinPolicy): Promise<Response> {
  const url = new URL(input);
  if (url.username || url.password || url.hash) throw new BlockedAddressError('webhook url is not allowed');
  const httpsOk = url.protocol === 'https:';
  const httpOk = policy.allowHttp && url.protocol === 'http:';
  if (!httpsOk && !httpOk) throw new BlockedAddressError('webhook url must use https');
  const hostname = stripBrackets(url.hostname).toLowerCase();
  if (!hostname) throw new BlockedAddressError();
  const pinned = await selectPinnedAddress(hostname, policy);
  const family = isIP(pinned) === 6 ? 6 : 4;
  const lookupFn: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: pinned, family }]);
    else callback(null, pinned, family);
  };
  const headers = normalizeHeaders(init?.headers);
  headers.host = url.host;
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? init.body : init?.body == null ? undefined : String(init.body);
  const lib = url.protocol === 'https:' ? https : http;
  const timeoutMs = policy.timeoutMs;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        lookup: lookupFn,
        servername: isIP(hostname) ? undefined : hostname,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          res.resume();
          const error = new TypeError('fetch failed');
          error.cause = new Error('unexpected redirect');
          reject(error);
          return;
        }
        const stream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else responseHeaders.set(key, value);
        }
        resolve(new Response(stream, { status, headers: responseHeaders }));
      },
    );
    const fail = (err: unknown) => {
      if (err && typeof err === 'object' && 'name' in err && err.name === 'TimeoutError') {
        reject(err);
        return;
      }
      const error = err instanceof Error ? err : new Error('connection failed');
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        reject(error);
        return;
      }
      const wrapped = new TypeError('fetch failed');
      wrapped.cause = error;
      reject(wrapped);
    };
    req.on('error', fail);
    req.on('timeout', () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      req.destroy(error);
    });
    init?.signal?.addEventListener('abort', () => {
      const reason = init.signal?.reason;
      const error = reason instanceof Error ? reason : new Error('aborted');
      if (!error.name || error.name === 'Error') error.name = 'AbortError';
      req.destroy(error);
    }, { once: true });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function selectPinnedAddress(hostname: string, policy: Pick<PinPolicy, 'allowPrivate' | 'lookupHost'>): Promise<string> {
  if (!policy.allowPrivate && isBlockedHostname(hostname)) throw new BlockedAddressError();
  if (isIP(hostname)) {
    if (!policy.allowPrivate && isBlockedIp(hostname)) throw new BlockedAddressError();
    return hostname;
  }
  const resolve = policy.lookupHost ?? defaultLookup;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new BlockedAddressError('webhook host could not be resolved');
  }
  if (addresses.length === 0) throw new BlockedAddressError('webhook host could not be resolved');
  if (!policy.allowPrivate && addresses.some((address) => isBlockedIp(address))) throw new BlockedAddressError();
  const chosen = addresses.find((address) => policy.allowPrivate || !isBlockedIp(address));
  if (!chosen) throw new BlockedAddressError();
  return chosen;
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const source = headers instanceof Headers ? headers : Array.isArray(headers) ? new Headers(headers) : new Headers(Object.entries(headers).map(([k, v]) => [k, String(v)]));
  source.forEach((value, key) => {
    if (key.toLowerCase() === 'host') return;
    out[key] = value;
  });
  return out;
}
