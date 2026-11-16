/**
 * Log scrubbing (design §11): bot tokens, invite codes, JWTs, and webhook
 * secrets never reach stdout; URLs are reduced to their origin. Applied at
 * every console output site so a stray exception message cannot leak them.
 */

const URL_RE = /\bhttps?:\/\/[^\s"'<>\\)\]]+/gi;
const BOT_TOKEN_RE = /\bbr_[A-Za-z0-9_-]{8,}/g;
const INVITE_CODE_RE = /\binv_[A-Za-z0-9_-]{8,}/g;
/** JWT compact form: the base64url of `{"…` always starts with "eyJ". */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

export function redactLogLine(text: string): string {
  return text
    .replace(JWT_RE, '[redacted-jwt]')
    .replace(URL_RE, (url) => redactUrl(url))
    .replace(BOT_TOKEN_RE, '[redacted-token]')
    .replace(INVITE_CODE_RE, '[redacted-invite]');
}

/** A URL may appear in logs only as scheme + host (design §8 visibility). */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/[redacted]`;
  } catch {
    return '[redacted-url]';
  }
}
