export type Config = {
  port: number;
  host: string;
  databasePath: string;
  adminToken: string;
  relaySecret: string;
  maxHops: number;
  rateLimitMax: number;
  rateLimitWindowSec: number;
  deliveryTimeoutMs: number;
  deliveryMaxAttempts: number;
  deliveryBackoffMs: number;
  deliveryPollMs: number;
  bodyMaxChars: number;
  metadataMaxChars: number;
  signatureToleranceSec: number;
  idempotencyTtlSec: number;
  allowHttpWebhooks: boolean;
  allowPrivateWebhooks: boolean;
  /** Origin used in Agent Card URLs. Request host is used when this is unset. */
  publicBaseUrl: string | null;
  /** How long a blocking A2A call waits for a bot reply or a remote terminal task. */
  a2aBlockTimeoutMs: number;
  /** Optional dedicated AES key. Null means new secrets still use RELAY_SECRET. */
  encryptionKey: string | null;
  /** Trust CF-Connecting-IP / X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  trustProxy: boolean;
  /** Per-IP cap for registration and admin login attempts. */
  authRateLimitMax: number;
  adminSessionTtlSec: number;
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  return {
    port: intEnv(env, 'PORT', 8080, 1, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    databasePath: env.DATABASE_PATH?.trim() || './data/bot-relay.sqlite',
    adminToken: secretEnv(env, 'ADMIN_TOKEN', 8),
    relaySecret: secretEnv(env, 'RELAY_SECRET', 16),
    maxHops: intEnv(env, 'MAX_HOPS', 8, 1, 1000),
    rateLimitMax: intEnv(env, 'RATE_LIMIT_MAX', 60, 1, 100_000),
    rateLimitWindowSec: intEnv(env, 'RATE_LIMIT_WINDOW_SEC', 60, 1, 86_400),
    deliveryTimeoutMs: intEnv(env, 'DELIVERY_TIMEOUT_MS', 10_000, 100, 120_000),
    deliveryMaxAttempts: intEnv(env, 'DELIVERY_MAX_ATTEMPTS', 4, 1, 20),
    deliveryBackoffMs: intEnv(env, 'DELIVERY_BACKOFF_MS', 500, 0, 300_000),
    deliveryPollMs: intEnv(env, 'DELIVERY_POLL_MS', 500, 50, 60_000),
    bodyMaxChars: intEnv(env, 'BODY_MAX_CHARS', 16_000, 1, 100_000),
    metadataMaxChars: intEnv(env, 'METADATA_MAX_CHARS', 4096, 1, 64_000),
    signatureToleranceSec: intEnv(env, 'SIGNATURE_TOLERANCE_SEC', 300, 0, 86_400),
    idempotencyTtlSec: intEnv(env, 'IDEMPOTENCY_TTL_SEC', 86_400, 60, 30 * 86_400),
    allowHttpWebhooks: boolEnv(env, 'ALLOW_HTTP_WEBHOOKS', false),
    allowPrivateWebhooks: boolEnv(env, 'ALLOW_PRIVATE_WEBHOOKS', false),
    publicBaseUrl: optionalBaseUrl(env, 'PUBLIC_BASE_URL'),
    a2aBlockTimeoutMs: intEnv(env, 'A2A_BLOCK_TIMEOUT_MS', 20_000, 0, 120_000),
    encryptionKey: optionalSecret(env, 'ENCRYPTION_KEY', 16),
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    authRateLimitMax: intEnv(env, 'AUTH_RATE_LIMIT_MAX', 30, 1, 100_000),
    adminSessionTtlSec: intEnv(env, 'ADMIN_SESSION_TTL_SEC', 12 * 3600, 60, 30 * 86_400),
  };
}

function optionalBaseUrl(env: Env, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
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

function optionalSecret(env: Env, name: string, min: number): string | null {
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (value.length < min) {
    throw new Error(`${name} must be at least ${min} characters. Generate one with: openssl rand -hex 32`);
  }
  if (value.includes('\n') || value.includes('\r') || value !== value.trim()) {
    throw new Error(`${name} must not contain whitespace or newlines`);
  }
  return value;
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
