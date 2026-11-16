import type { Context } from 'hono';

import { HttpError } from './errors.js';
import { isPlainObject } from './validate.js';

const MAX_REQUEST_CHARS = 65_536;

/**
 * Read a required JSON object body. Shared by every JSON endpoint so the
 * register form page and the API enforce the exact same parsing rules.
 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type');
  if (!contentType || contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const advertised = c.req.header('content-length');
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > MAX_REQUEST_CHARS) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  const raw = await c.req.text();
  if (raw.length > MAX_REQUEST_CHARS) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  return parseJsonObject(raw);
}

/** Like readJsonObject but an absent or empty body becomes `{}` (for optional payloads). */
export async function readOptionalJsonObject(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type');
  if (!contentType || contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return {};
  }
  const advertised = c.req.header('content-length');
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > MAX_REQUEST_CHARS) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  const raw = await c.req.text();
  if (raw.length > MAX_REQUEST_CHARS) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  if (!raw.trim()) return {};
  return parseJsonObject(raw);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) throw new HttpError(400, 'invalid_json', 'Request body is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  return parsed;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
