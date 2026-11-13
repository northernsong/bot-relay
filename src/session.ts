import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type AdminSession = { exp: number; csrf: string };

export function createSession(nowMs: number, ttlSec: number): AdminSession {
  return { exp: nowMs + ttlSec * 1000, csrf: randomBytes(24).toString('base64url') };
}

export function signSession(session: AdminSession, secret: string): string {
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readSession(token: string | undefined, secret: string, nowMs: number): AdminSession | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AdminSession;
    if (!parsed || typeof parsed.exp !== 'number' || typeof parsed.csrf !== 'string') return null;
    if (parsed.exp <= nowMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export const ADMIN_COOKIE = 'br_session';
