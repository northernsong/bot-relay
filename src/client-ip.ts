import type { Context } from 'hono';
import { BlockList, isIP } from 'node:net';

import type { Deps } from './deps.js';
import { HttpError } from './errors.js';

/**
 * TCP peer address of the request, when the node adapter exposes it.
 * Returns null in tests that call `app.request` directly.
 */
export function peerAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string | null } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
}

/**
 * Client address used for rate limiting. CF-Connecting-IP is honored only when
 * the TCP peer matches TRUSTED_PROXIES; every other peer is identified by its
 * socket address and spoofed proxy headers are ignored (design §9.2).
 */
export function clientIp(c: Context, trustedProxies: string[]): string {
  const peer = peerAddress(c);
  if (peer !== null && isTrustedProxy(peer, trustedProxies)) {
    const cf = firstIp(c.req.header('cf-connecting-ip'));
    if (cf) return cf;
  }
  return peer ?? 'direct';
}

export function requestIsHttps(c: Context, trustedProxies: string[]): boolean {
  const peer = peerAddress(c);
  if (peer !== null && isTrustedProxy(peer, trustedProxies)) {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    if (proto === 'https') return true;
    if (proto === 'http') return false;
  }
  return new URL(c.req.url).protocol === 'https:';
}

export function isTrustedProxy(address: string, trustedProxies: string[]): boolean {
  const normalized = normalizeAddress(address);
  if (normalized === null) return false;
  const family = isIP(normalized);
  if (family === 0) return false;
  const blockList = new BlockList();
  for (const entry of trustedProxies) {
    const slash = entry.lastIndexOf('/');
    if (slash === -1) {
      const entryFamily = isIP(entry);
      if (entryFamily !== 0) blockList.addAddress(entry, entryFamily === 6 ? 'ipv6' : 'ipv4');
      continue;
    }
    const net = entry.slice(0, slash);
    const netFamily = isIP(net);
    if (netFamily === 0) continue;
    const prefix = Number(entry.slice(slash + 1));
    if (!Number.isInteger(prefix)) continue;
    blockList.addSubnet(net, prefix, netFamily === 6 ? 'ipv6' : 'ipv4');
  }
  return blockList.check(normalized, family === 6 ? 'ipv6' : 'ipv4');
}

function normalizeAddress(address: string): string | null {
  const value = address.trim().toLowerCase();
  if (value === '') return null;
  // Node reports IPv4 clients on dual-stack sockets as ::ffff:a.b.c.d.
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return mapped;
  }
  return value;
}

export async function limitAuth(deps: Deps, c: Context, purpose: 'register' | 'login'): Promise<void> {
  const ip = clientIp(c, deps.config.trustedProxies);
  const max = purpose === 'register' ? deps.config.registerRatePerMin : deps.config.loginRatePerMin;
  const rate = deps.db.consumeRate(`${purpose}:${ip}`, deps.now(), deps.config.rateLimitWindowSec * 1000, max);
  if (!rate.allowed) {
    throw new HttpError(
      429,
      'rate_limited',
      'Too many attempts from this address',
      { 'retry-after': String(rate.retryAfterSec) },
      { retry_after: rate.retryAfterSec },
    );
  }
}

function firstIp(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return isIP(trimmed) !== 0 ? trimmed : null;
}
