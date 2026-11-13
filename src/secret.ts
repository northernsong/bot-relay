import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function newToken(): string {
  return `rl_${randomBytes(32).toString('base64url')}`;
}

export function newA2aToken(): string {
  return `a2a_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compare two secrets without leaking length or contents through timing. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export type CryptoKeys = {
  relaySecret: string;
  /** When null, new ciphertext uses the RELAY_SECRET-derived key (v1). */
  encryptionKey: string | null;
};

function deriveKey(label: string, secret: string): Buffer {
  return createHash('sha256').update(`${label}\0${secret}`).digest();
}

function seal(version: 'v1' | 'v2', plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

function open(enc: string, key: Buffer): string {
  const buf = Buffer.from(enc.slice(3), 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('secret truncated');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function asKeys(secretOrKeys: string | CryptoKeys): CryptoKeys {
  if (typeof secretOrKeys === 'string') return { relaySecret: secretOrKeys, encryptionKey: null };
  return secretOrKeys;
}

/**
 * AES-256-GCM. `v1:` is the historical key derived from RELAY_SECRET.
 * `v2:` uses ENCRYPTION_KEY when it is configured. Decrypt still opens `v1:`
 * with RELAY_SECRET so existing rows keep working after the new variable is set.
 */
export function encryptSecret(plain: string, secretOrKeys: string | CryptoKeys): string {
  const keys = asKeys(secretOrKeys);
  if (keys.encryptionKey) return seal('v2', plain, deriveKey('bot-relay/encryption-key/v2', keys.encryptionKey));
  return seal('v1', plain, deriveKey('bot-relay/webhook-secret/v1', keys.relaySecret));
}

export function decryptSecret(enc: string, secretOrKeys: string | CryptoKeys): string {
  const keys = asKeys(secretOrKeys);
  if (enc.startsWith('v2:')) {
    if (!keys.encryptionKey) throw new Error('missing encryption key');
    return open(enc, deriveKey('bot-relay/encryption-key/v2', keys.encryptionKey));
  }
  if (enc.startsWith('v1:')) return open(enc, deriveKey('bot-relay/webhook-secret/v1', keys.relaySecret));
  throw new Error('unknown secret version');
}
