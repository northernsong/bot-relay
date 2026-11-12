import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature header: `X-Bot-Relay-Signature: t=<unix seconds>,v1=<hex hmac>`
 *
 * The MAC is HMAC-SHA256 over the ASCII string `${t}.${rawBody}` using RELAY_SECRET.
 * `t` is the time of this delivery attempt (retries get a fresh timestamp).
 * The envelope `timestamp` field is when the relay accepted the message.
 * Verifiers must MAC the raw request bytes, not a re-serialized JSON object.
 */
export function signPayload(rawBody: string, secret: string, timestampSec: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

export function verifySignature(
  rawBody: string,
  header: string,
  secret: string,
  nowSec: number,
  toleranceSec: number,
): boolean {
  const parsed = parseSignature(header);
  if (!parsed) return false;
  if (Math.abs(nowSec - parsed.t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${parsed.t}.${rawBody}`).digest('hex');
  return timingSafeEqualHex(expected, parsed.v1);
}

function parseSignature(header: string): { t: number; v1: string } | null {
  if (!header || header.length > 512) return null;
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) return null;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') {
      if (!/^\d{1,12}$/.test(value)) return null;
      t = Number(value);
    } else if (key === 'v1') {
      v1 = value.toLowerCase();
    }
  }
  if (t === null || v1 === null) return null;
  if (!/^[0-9a-f]{64}$/.test(v1)) return null;
  return { t, v1 };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
