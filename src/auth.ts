import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { hashToken, secretsMatch } from './secret.js';
import type { Bot } from './types.js';

export function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  return match[1] ?? null;
}

export function isAdminBearer(deps: Deps, header: string | undefined): boolean {
  const token = readBearer(header);
  return Boolean(token && secretsMatch(token, deps.config.adminToken));
}

export function requireAdmin(deps: Deps, header: string | undefined): void {
  if (!isAdminBearer(deps, header)) {
    throw new HttpError(401, 'unauthorized', 'Admin token required', { 'www-authenticate': 'Bearer' });
  }
}

export function requireBot(deps: Deps, header: string | undefined): Bot {
  const token = readBearer(header);
  if (!token) {
    throw new HttpError(401, 'unauthorized', 'Relay token required', { 'www-authenticate': 'Bearer' });
  }
  const bot = deps.db.getBotByTokenHash(hashToken(token));
  if (!bot) {
    throw new HttpError(401, 'unauthorized', 'Relay token required', { 'www-authenticate': 'Bearer' });
  }
  return bot;
}
