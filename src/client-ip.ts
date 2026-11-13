import type { Context } from 'hono';
import { isIP } from 'node:net';

import type { Deps } from './deps.js';
import { HttpError } from './errors.js';

/** Client address used for auth rate limits. Proxy headers are ignored unless TRUST_PROXY is set. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = firstIp(c.req.header('cf-connecting-ip'));
    if (cf) return cf;
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const first = firstIp(forwarded.split(',')[0]);
      if (first) return first;
    }
  }
  return 'direct';
}

export function requestIsHttps(c: Context, trustProxy: boolean): boolean {
  if (trustProxy) {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    if (proto === 'https') return true;
    if (proto === 'http') return false;
  }
  return new URL(c.req.url).protocol === 'https:';
}

export async function limitAuth(deps: Deps, c: Context, purpose: 'register' | 'login'): Promise<void> {
  const ip = clientIp(c, deps.config.trustProxy);
  const rate = deps.db.consumeRate(
    `auth:${purpose}:${ip}`,
    deps.now(),
    deps.config.rateLimitWindowSec * 1000,
    deps.config.authRateLimitMax,
  );
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
  return isIP(trimmed) ? trimmed : null;
}
