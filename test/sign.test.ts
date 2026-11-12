import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../src/secret.js';
import { signPayload, verifySignature } from '../src/sign.js';
import { SECRET } from './helpers.js';

describe('signatures', () => {
  const raw = '{"v":1,"body":"hello"}';
  const t = 1_700_000_000;

  it('signs the raw body with the unix timestamp', () => {
    const header = signPayload(raw, SECRET, t);
    const mac = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
    expect(header).toBe(`t=${t},v1=${mac}`);
    expect(verifySignature(raw, header, SECRET, t, 300)).toBe(true);
  });

  it('rejects tampering, the wrong secret, a stale timestamp, and a malformed header', () => {
    const header = signPayload(raw, SECRET, t);
    expect(verifySignature(`${raw} `, header, SECRET, t, 300)).toBe(false);
    expect(verifySignature(raw, header, `${SECRET}-other`, t, 300)).toBe(false);
    expect(verifySignature(raw, header, SECRET, t + 301, 300)).toBe(false);
    expect(verifySignature(raw, header, SECRET, t - 301, 300)).toBe(false);
    expect(verifySignature(raw, 't=1700000000,v1=abcd', SECRET, t, 300)).toBe(false);
    expect(verifySignature(raw, 'nope', SECRET, t, 300)).toBe(false);
    const flipped = header.slice(0, -1) + (header.endsWith('a') ? 'b' : 'a');
    expect(verifySignature(raw, flipped, SECRET, t, 300)).toBe(false);
  });
});

describe('webhook header encryption', () => {
  it('round-trips and does not store the plaintext', () => {
    const enc = encryptSecret('super-secret-webhook-key', SECRET);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('super-secret-webhook-key');
    expect(decryptSecret(enc, SECRET)).toBe('super-secret-webhook-key');
    expect(encryptSecret('super-secret-webhook-key', SECRET)).not.toBe(enc);
    expect(() => decryptSecret(enc, `${SECRET}-no`)).toThrow();
  });
});
