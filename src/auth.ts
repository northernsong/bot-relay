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
    throw new HttpError(401, 'unauthorized', 'Bot token required', { 'www-authenticate': 'Bearer' });
  }
  const bot = deps.db.getBotByTokenHash(hashToken(token));
  if (!bot || bot.tokenRevokedAt !== null) {
    throw new HttpError(401, 'unauthorized', 'Bot token required', { 'www-authenticate': 'Bearer' });
  }
  return bot;
}

/** Business endpoints (everything except self-status) reject disabled bots. */
export function requireActiveBot(deps: Deps, header: string | undefined): Bot {
  const bot = requireBot(deps, header);
  if (bot.disabled) {
    throw new HttpError(403, 'bot_disabled', 'This bot is disabled');
  }
  return bot;
}
