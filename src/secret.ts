import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function newToken(): string {
  return `rl_${randomBytes(32).toString('base64url')}`;
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

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(`bot-relay/webhook-secret/v1\0${secret}`).digest();
}

/** AES-256-GCM. Output is versioned so a future scheme can be detected. */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

export function decryptSecret(enc: string, secret: string): string {
  if (!enc.startsWith('v1:')) throw new Error('unknown secret version');
  const buf = Buffer.from(enc.slice(3), 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('secret truncated');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
