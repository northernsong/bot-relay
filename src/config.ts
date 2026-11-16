import { isIP } from 'node:net';

export type Config = {
  port: number;
  /** Listen address. Loopback only by default; the public entry is a local tunnel client. */
  host: string;
  databasePath: string;
  adminToken: string;
  /** Single source for AES-256-GCM encryption of stored contact details. */
  encryptionKey: string;
  /** Public origin of this registry, used in identity tokens and invite links. */
  publicBaseUrl: string;
  /** CIDRs (or bare IPs) whose CF-Connecting-IP header is trusted. */
  trustedProxies: string[];
  adminSessionTtlSec: number;
  allowHttpWebhooks: boolean;
  allowPrivateWebhooks: boolean;
  rateLimitWindowSec: number;
  inquiryTtlSec: number;
  inquiryDeliveryTimeoutMs: number;
  identityTokenTtlSec: number;
  registerRatePerMin: number;
  loginRatePerMin: number;
  inquiryRatePerMin: number;
  inquiryPairRatePerHour: number;
  defaultRatePerMin: number;
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  return {
    port: intEnv(env, 'PORT', 8080, 1, 65535),
    host: env.HOST?.trim() || '127.0.0.1',
    databasePath: env.DATABASE_PATH?.trim() || './data/bot-relay.sqlite',
    adminToken: secretEnv(env, 'ADMIN_TOKEN', 8),
    encryptionKey: secretEnv(env, 'ENCRYPTION_KEY', 32),
    publicBaseUrl: requiredBaseUrl(env, 'PUBLIC_BASE_URL'),
    trustedProxies: cidrListEnv(env, 'TRUSTED_PROXIES', ['127.0.0.1/32', '::1/128']),
    adminSessionTtlSec: intEnv(env, 'ADMIN_SESSION_TTL_SEC', 12 * 3600, 60, 30 * 86_400),
    allowHttpWebhooks: boolEnv(env, 'ALLOW_HTTP_WEBHOOKS', false),
    allowPrivateWebhooks: boolEnv(env, 'ALLOW_PRIVATE_WEBHOOKS', false),
    rateLimitWindowSec: intEnv(env, 'RATE_LIMIT_WINDOW_SEC', 60, 1, 86_400),
    inquiryTtlSec: intEnv(env, 'INQUIRY_TTL_SEC', 86_400, 60, 30 * 86_400),
    inquiryDeliveryTimeoutMs: intEnv(env, 'INQUIRY_DELIVERY_TIMEOUT_MS', 10_000, 100, 120_000),
    identityTokenTtlSec: intEnv(env, 'IDENTITY_TOKEN_TTL_SEC', 300, 1, 300),
    registerRatePerMin: intEnv(env, 'REGISTER_RATE_PER_MIN', 10, 1, 100_000),
    loginRatePerMin: intEnv(env, 'LOGIN_RATE_PER_MIN', 10, 1, 100_000),
    inquiryRatePerMin: intEnv(env, 'INQUIRY_RATE_PER_MIN', 10, 1, 100_000),
    inquiryPairRatePerHour: intEnv(env, 'INQUIRY_PAIR_RATE_PER_HOUR', 5, 1, 100_000),
    defaultRatePerMin: intEnv(env, 'DEFAULT_RATE_PER_MIN', 60, 1, 100_000),
  };
}

function requiredBaseUrl(env: Env, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${name} is required and must be an absolute http(s) URL, for example https://relay.example.com`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  const path = url.pathname.replace(/\/$/, '');
  return `${url.origin}${path}`;
}

function cidrListEnv(env: Env, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return [...fallback];
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) return [...fallback];
  for (const entry of entries) {
    if (!isValidIpOrCidr(entry)) {
      throw new Error(`${name} must be a comma-separated list of IPs or CIDR ranges, for example 127.0.0.1/32,::1/128`);
    }
  }
  return entries;
}

export function isValidIpOrCidr(entry: string): boolean {
  const slash = entry.lastIndexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return false;
  if (slash === -1) return true;
  const prefix = entry.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 6 ? 128 : 32);
}

function secretEnv(env: Env, name: string, min: number): string {
  const value = env[name];
  if (!value || value.length < min) {
    throw new Error(`${name} is required and must be at least ${min} characters. Generate one with: openssl rand -hex 32`);
  }
  if (value.includes('\n') || value.includes('\r') || value !== value.trim()) {
    throw new Error(`${name} must not contain whitespace or newlines`);
  }
  return value;
}

function intEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function boolEnv(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}
