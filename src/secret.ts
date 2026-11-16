import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bot access token. Shown to the owner exactly once; only the sha256 hash is stored. */
export function newToken(): string {
  return `br_${randomBytes(32).toString('base64url')}`;
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

const VERSION = 'v1';
const KEY_LABEL = 'bot-relay/encryption-key';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(`${KEY_LABEL}\0${secret}`).digest();
}

function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
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

/** AES-256-GCM with the single key derived from ENCRYPTION_KEY. */
export function encryptSecret(plain: string, encryptionKey: string): string {
  return seal(plain, deriveKey(encryptionKey));
}

export function decryptSecret(enc: string, encryptionKey: string): string {
  if (!enc.startsWith(`${VERSION}:`)) throw new Error('unknown secret version');
  return open(enc, deriveKey(encryptionKey));
}
