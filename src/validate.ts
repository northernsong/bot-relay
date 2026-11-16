import { HttpError } from './errors.js';

const BOT_ID = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const RESERVED_IDS = new Set(['me', 'admin', 'registry']);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  'host',
  'content-type',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'x-bot-relay-identity',
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[]): void {
  const ok = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!ok.has(key)) throw new HttpError(400, 'invalid_request', `Unknown field "${key}"`);
  }
}

export function parseBotId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !BOT_ID.test(value) || RESERVED_IDS.has(value)) {
    throw new HttpError(
      400,
      'invalid_request',
      `${field} must be 2-32 characters of lowercase letters, digits, "_" or "-", and must not be reserved`,
    );
  }
  return value;
}

export function parseDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_request', 'display_name must be a string');
  }
  const name = value.trim();
  if (name.length < 1 || name.length > 80) {
    throw new HttpError(400, 'invalid_request', 'display_name must be 1-80 characters');
  }
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    throw new HttpError(400, 'invalid_request', 'display_name contains control characters');
  }
  return name;
}

export function parseCapabilities(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_request', 'capabilities must be a string');
  }
  const text = value.trim();
  if (text.length > 500) {
    throw new HttpError(400, 'invalid_request', 'capabilities must be at most 500 characters');
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new HttpError(400, 'invalid_request', 'capabilities contains control characters');
  }
  return text;
}

/** Receiver-side intake control: who is allowed to open inquiries against this bot. */
export function parseIntake(value: unknown): { mode: 'open' | 'allowlist' | 'none'; allowlist: string[] | null } {
  if (value === undefined || value === null) return { mode: 'open', allowlist: null };
  if (!isPlainObject(value)) {
    throw new HttpError(400, 'invalid_request', 'intake must be an object with a mode');
  }
  rejectUnknown(value, ['mode', 'allowlist']);
  const mode = value.mode;
  if (mode !== 'open' && mode !== 'allowlist' && mode !== 'none') {
    throw new HttpError(400, 'invalid_request', 'intake.mode must be "open", "allowlist", or "none"');
  }
  if (value.allowlist === undefined || value.allowlist === null) {
    if (mode === 'allowlist') {
      throw new HttpError(400, 'invalid_request', 'intake.allowlist is required when intake.mode is "allowlist"');
    }
    return { mode, allowlist: null };
  }
  if (mode !== 'allowlist') {
    throw new HttpError(400, 'invalid_request', 'intake.allowlist is only valid when intake.mode is "allowlist"');
  }
  return { mode, allowlist: parseIdList(value.allowlist, 'intake.allowlist') };
}

export function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `${field} must be an array of bot ids`);
  }
  if (value.length > 100) {
    throw new HttpError(400, 'invalid_request', `${field} cannot contain more than 100 ids`);
  }
  const ids = value.map((entry, index) => parseBotId(entry, `${field}[${index}]`));
  return [...new Set(ids)];
}

export function parseHeaderName(value: unknown): string {
  if (typeof value !== 'string' || !HEADER_NAME.test(value) || RESERVED_HEADERS.has(value.toLowerCase())) {
    throw new HttpError(
      400,
      'invalid_request',
      'webhook_auth_name must be a header name and cannot replace Content-Type or registry headers',
    );
  }
  return value;
}

export function parseHeaderValue(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new HttpError(400, 'invalid_request', 'webhook_auth_value must be 1-4096 characters without newlines');
  }
  return value;
}
