import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

import type { Deps } from './deps.js';
import { decryptSecret, encryptSecret } from './secret.js';
import type { Bot, RegistryKey } from './types.js';

/**
 * Registry identity and signing (design §7). One Ed25519 key pair is
 * generated on first use; the private half is AES-256-GCM encrypted in
 * `registry_keys`, the public half leaves through the JWKS endpoint only.
 */

/** Retired keys stay in the JWKS for 1h — far above the 300s token TTL (§7.4). */
export const KEY_RETIREMENT_WINDOW_MS = 3_600_000;
/** Inquiry payload signatures older than this are treated as replays (§13). */
export const INQUIRY_SIGNATURE_TOLERANCE_MS = 300_000;

/** DER prefix of an Ed25519 SPKI SubjectPublicKeyInfo; the raw 32 key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type Jwk = { kid: string; kty: 'OKP'; crv: 'Ed25519'; x: string };
export type JwkSet = { keys: Jwk[] };

export type IdentityClaims = {
  iss: string;
  sub: string;
  /** The one bot this proof is meant for; receivers require aud === own id. */
  aud: string;
  name: string;
  iat: number;
  exp: number;
  jti: string;
};

export type TokenInvalidReason = 'malformed' | 'unknown_kid' | 'bad_signature' | 'expired' | 'wrong_iss' | 'bad_audience';
export type TokenVerifyResult = { valid: true; claims: IdentityClaims } | { valid: false; reason: TokenInvalidReason };

export type InquirySignatureResult =
  | { ok: true; kid: string; ts: number }
  | { ok: false; reason: 'malformed' | 'unknown_kid' | 'bad_signature' | 'stale_timestamp' };

/** The key used for all new signatures; generated on first use (§7.1). */
export function ensureSigningKey(deps: Deps): RegistryKey {
  const existing = deps.db.getActiveRegistryKey();
  if (existing) return existing;
  return deps.db.transaction(() => {
    const raced = deps.db.getActiveRegistryKey();
    if (raced) return raced;
    const key = generateKeyRow(deps.config.encryptionKey, deps.now());
    deps.db.insertRegistryKey(key);
    return key;
  });
}

/**
 * Rotation (§7.4): retire the current key, start signing with a fresh one.
 * Both public keys are published for the retirement window, so tokens signed
 * by the old key keep verifying offline until they expire.
 */
export function rotateRegistryKey(deps: Deps): { kid: string } {
  const now = deps.now();
  const created = deps.db.transaction(() => {
    deps.db.retireActiveRegistryKeys(now);
    const key = generateKeyRow(deps.config.encryptionKey, now);
    deps.db.insertRegistryKey(key);
    return key;
  });
  deps.db.insertAudit({
    at: now,
    actor: 'admin',
    action: 'key.rotated',
    object: created.kid,
    detail: null,
    source: null,
  });
  return { kid: created.kid };
}

/** The public JWKS document: active key plus keys retired within the window. */
export function buildJwks(deps: Deps): JwkSet {
  // First use generates the pair, so the document is never empty on a fresh
  // deployment (design §7.1: generated on first start, published via JWKS).
  ensureSigningKey(deps);
  const keys = deps.db.listRegistryKeysForJwks(deps.now(), KEY_RETIREMENT_WINDOW_MS);
  return { keys: keys.map((key) => ({ kid: key.kid, kty: 'OKP', crv: 'Ed25519', x: jwkX(key.publicKey) })) };
}

/**
 * POST /v1/identity-token (§5.6, §7.2): short-lived EdDSA JWT proving that the
 * caller is a registered, non-disabled bot. Disabled bots never reach this —
 * the route rejects them before signing.
 */
export function issueIdentityToken(deps: Deps, bot: Bot, aud: string): { token: string; expiresAt: number } {
  const key = ensureSigningKey(deps);
  const iat = Math.floor(deps.now() / 1000);
  const exp = iat + deps.config.identityTokenTtlSec;
  const header = { alg: 'EdDSA', typ: 'JWT', kid: key.kid };
  const claims: IdentityClaims = {
    iss: deps.config.publicBaseUrl,
    sub: bot.id,
    aud,
    name: bot.displayName,
    iat,
    exp,
    jti: `jti_${randomBytes(12).toString('base64url')}`,
  };
  const unsigned = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const token = `${unsigned}.${signEd25519(unsigned, privateKeyObject(key, deps.config.encryptionKey))}`;
  return { token, expiresAt: exp * 1000 };
}

/**
 * Offline verification exactly as the called bot performs it (§7.3): Ed25519
 * signature against the JWKS, `exp` freshness, expected `iss`, known `kid`,
 * and — when `aud` is given — that the proof was minted for that bot. A
 * receiver always passes its own id, so a proof A minted for B cannot be
 * replayed by B against C. Registry availability is never required.
 */
export function verifyIdentityToken(
  token: string,
  opts: { jwks: JwkSet; iss: string; now: number; aud?: string },
): TokenVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(fromB64url(parts[0] ?? '').toString('utf8')) as unknown;
    claims = JSON.parse(fromB64url(parts[1] ?? '').toString('utf8')) as unknown;
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!isRecord(header) || !isRecord(claims)) return { valid: false, reason: 'malformed' };
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string' || header.kid === '') {
    return { valid: false, reason: 'malformed' };
  }
  if (
    typeof claims.iss !== 'string' ||
    typeof claims.sub !== 'string' ||
    typeof claims.aud !== 'string' ||
    typeof claims.name !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    typeof claims.jti !== 'string'
  ) {
    return { valid: false, reason: 'malformed' };
  }
  const jwk = findJwk(opts.jwks, header.kid);
  if (!jwk) return { valid: false, reason: 'unknown_kid' };
  const signatureOk = verifyEd25519(`${parts[0]}.${parts[1]}`, parts[2] ?? '', jwk);
  if (!signatureOk) return { valid: false, reason: 'bad_signature' };
  if (claims.exp * 1000 <= opts.now) return { valid: false, reason: 'expired' };
  if (claims.iss !== opts.iss) return { valid: false, reason: 'wrong_iss' };
  if (opts.aud !== undefined && claims.aud !== opts.aud) return { valid: false, reason: 'bad_audience' };
  return { valid: true, claims: claims as unknown as IdentityClaims };
}

/** Header value for an outbound inquiry: `v1 kid=<kid> ts=<ms> sig=<base64url>`. */
export function signInquiryPayload(deps: Deps, body: string): string {
  const key = ensureSigningKey(deps);
  const ts = deps.now();
  const signature = signEd25519(`${ts}.${body}`, privateKeyObject(key, deps.config.encryptionKey));
  return `v1 kid=${key.kid} ts=${ts} sig=${signature}`;
}

/**
 * Receiver-side check of `X-Bot-Relay-Signature` (§6.3): the Ed25519 signature
 * covers `"<ts>.<body>"`, so any body tampering breaks it, and a timestamp
 * outside the tolerance window is rejected as a replay. Asymmetric on purpose:
 * only the registry can produce signatures, everyone can verify (P0-5⑦).
 */
export function verifyInquirySignature(opts: {
  jwks: JwkSet;
  header: string;
  body: string;
  now: number;
  toleranceMs?: number;
}): InquirySignatureResult {
  const parts = opts.header.trim().split(/\s+/);
  if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const kid = parts[1]?.startsWith('kid=') === true ? parts[1].slice('kid='.length) : '';
  const tsRaw = parts[2]?.startsWith('ts=') === true ? parts[2].slice('ts='.length) : '';
  const sigRaw = parts[3]?.startsWith('sig=') === true ? parts[3].slice('sig='.length) : '';
  if (kid === '' || !/^\d+$/.test(tsRaw) || sigRaw === '') return { ok: false, reason: 'malformed' };
  const ts = Number(tsRaw);
  const jwk = findJwk(opts.jwks, kid);
  if (!jwk) return { ok: false, reason: 'unknown_kid' };
  if (!verifyEd25519(`${ts}.${opts.body}`, sigRaw, jwk)) return { ok: false, reason: 'bad_signature' };
  const tolerance = opts.toleranceMs ?? INQUIRY_SIGNATURE_TOLERANCE_MS;
  if (Math.abs(opts.now - ts) > tolerance) return { ok: false, reason: 'stale_timestamp' };
  return { ok: true, kid, ts };
}

function generateKeyRow(encryptionKey: string, now: number): RegistryKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  return {
    kid: `rk_${randomBytes(8).toString('hex')}`,
    privateKeyEnc: encryptSecret(pkcs8, encryptionKey),
    publicKey: spki,
    createdAt: now,
    retiredAt: null,
  };
}

function privateKeyObject(key: RegistryKey, encryptionKey: string): KeyObject {
  const pkcs8 = decryptSecret(key.privateKeyEnc, encryptionKey);
  return createPrivateKey({ key: Buffer.from(pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

function signEd25519(data: string, privateKey: KeyObject): string {
  return cryptoSign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64url');
}

function verifyEd25519(data: string, signatureB64url: string, jwk: Jwk): boolean {
  try {
    const signature = Buffer.from(signatureB64url, 'base64url');
    if (signature.length !== 64) return false;
    // Canonical-encoding check: a decoder ignores the unused low bits of the
    // final base64url character, so `…sigA` and `…sigB` can denote the exact
    // same bytes. Rejecting non-canonical spellings keeps textual tampering
    // detectable instead of silently accepted (RFC 8725 §3.1).
    if (signature.toString('base64url') !== signatureB64url) return false;
    return cryptoVerify(null, Buffer.from(data, 'utf8'), publicKeyObject(jwk), signature);
  } catch {
    return false;
  }
}

function publicKeyObject(jwk: Jwk): KeyObject {
  const raw = Buffer.from(jwk.x, 'base64url');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function findJwk(set: JwkSet, kid: string): Jwk | undefined {
  return set.keys.find((key) => key.kid === kid && key.kty === 'OKP' && key.crv === 'Ed25519' && typeof key.x === 'string');
}

/** Raw public key bytes of an SPKI blob, base64url — the JWK `x` value. */
function jwkX(spkiBase64: string): string {
  const der = Buffer.from(spkiBase64, 'base64');
  return der.subarray(ED25519_SPKI_PREFIX.length).toString('base64url');
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
