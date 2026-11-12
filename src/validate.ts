import { createHash } from 'node:crypto';

import { HttpError } from './errors.js';
import type { SendInput } from './types.js';

const BOT_ID = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const RESERVED_IDS = new Set(['me']);
const THREAD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{10,80}$/;
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
  'x-bot-relay-signature',
  'x-bot-relay-timestamp',
  'x-bot-relay-id',
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

export function parseMessageBody(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'invalid_request', 'body must be a non-empty string');
  }
  if (value.length > maxChars) {
    throw new HttpError(413, 'payload_too_large', `body exceeds ${maxChars} characters`);
  }
  return value;
}

export function parseThreadId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !THREAD_ID.test(value)) {
    throw new HttpError(400, 'invalid_request', 'thread_id must be 1-80 characters of letters, digits, "_" or "-"');
  }
  return value;
}

export function parseReplyTo(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !MESSAGE_ID.test(value)) {
    throw new HttpError(400, 'invalid_request', 'reply_to must be a relay message id');
  }
  return value;
}

export function parseMetadata(value: unknown, maxChars: number): unknown | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new HttpError(400, 'invalid_request', 'metadata must be a JSON object');
  }
  assertDepth(value, 0);
  if (JSON.stringify(value).length > maxChars) {
    throw new HttpError(413, 'payload_too_large', `metadata exceeds ${maxChars} characters`);
  }
  return value;
}

export function parseAllowlist(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', 'allowlist must be an array of bot ids, or null to accept anyone');
  }
  if (value.length > 100) {
    throw new HttpError(400, 'invalid_request', 'allowlist cannot contain more than 100 ids');
  }
  const ids = value.map((entry, index) => parseBotId(entry, `allowlist[${index}]`));
  return [...new Set(ids)];
}

export function parseHeaderName(value: unknown): string {
  if (typeof value !== 'string' || !HEADER_NAME.test(value) || RESERVED_HEADERS.has(value.toLowerCase())) {
    throw new HttpError(
      400,
      'invalid_request',
      'auth_header_name must be a header name and cannot replace Content-Type or the relay signature headers',
    );
  }
  return value;
}

export function parseHeaderValue(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new HttpError(400, 'invalid_request', 'auth_header_value must be 1-4096 characters without newlines');
  }
  return value;
}

export function parseIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new HttpError(
      400,
      'invalid_request',
      'Idempotency-Key must be 1-200 characters of letters, digits, ".", "_", ":", or "-"',
    );
  }
  return value;
}

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 50;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'invalid_request', 'limit must be an integer');
  const value = Number(raw);
  if (value < 1 || value > 100) throw new HttpError(400, 'invalid_request', 'limit must be between 1 and 100');
  return value;
}

export function requestHash(input: SendInput): string {
  const canonical = stableStringify({
    to: input.to,
    body: input.body,
    thread_id: input.threadId,
    reply_to: input.replyTo,
    metadata: input.metadata,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function assertDepth(value: unknown, depth: number): void {
  if (depth > 8) throw new HttpError(400, 'invalid_request', 'metadata is nested too deeply');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as object)) assertDepth(child, depth + 1);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}
