import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import type { Hono } from 'hono';
import type { Deps } from '../src/deps.js';
import { decryptSecret } from '../src/secret.js';
import {
  INQUIRY_SIGNATURE_TOLERANCE_MS,
  KEY_RETIREMENT_WINDOW_MS,
  buildJwks,
  verifyIdentityToken,
  verifyInquirySignature,
  type JwkSet,
} from '../src/identity.js';
import {
  api,
  createInvite,
  expectStatus,
  login,
  makeApp,
  mutableClock,
  registerBot,
  startWebhook,
  until,
} from './helpers.js';

const ISS = 'https://relay.example.test';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

type World = { app: Hono; deps: Deps; alice: string; bob: string };

async function setup(overrides: Partial<Config> = {}, now?: () => number): Promise<World> {
  const made = makeApp(overrides, now ? { now } : {});
  open.push({ close: () => made.deps.db.close() });
  const session = await login(made.app);
  const inviteA = await createInvite(made.app, session);
  const alice = await registerBot(made.app, { id: 'alice', invite: inviteA.code, display_name: 'Alice' });
  const inviteB = await createInvite(made.app, session);
  const bob = await registerBot(made.app, { id: 'bob', invite: inviteB.code, display_name: 'Bob' });
  return { app: made.app, deps: made.deps, alice, bob };
}

async function issueToken(app: Hono, token: string): Promise<string> {
  const res = expectStatus(await api(app, '/v1/identity-token', { method: 'POST', token }), 200);
  expect(typeof res.token).toBe('string');
  return res.token as string;
}

function decode(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

function flipFirstChar(part: string): string {
  const first = part.slice(0, 1);
  return (first === 'A' ? 'B' : 'A') + part.slice(1);
}

/** Change the final character, whose low bits are base64 padding: decodes to the same bytes. */
function flipLastChar(part: string): string {
  const last = part.slice(-1);
  return part.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

async function fetchJwks(app: Hono): Promise<JwkSet & { keys: any[] }> {
  return expectStatus(await api(app, '/.well-known/bot-relay/jwks.json'), 200);
}

describe('JWKS publication', () => {
  it('publishes the Ed25519 public key set publicly; the private key stays encrypted', async () => {
    const { app, deps } = await setup();
    const res = await fetchJwks(app);
    expect(res.keys).toHaveLength(1);
    const jwk = res.keys[0] as { kid: string; kty: string; crv: string; x: string };
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.kid).toMatch(/^rk_[0-9a-f]{16}$/);
    expect(jwk.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = await api(app, '/.well-known/bot-relay/jwks.json');
    expect(raw.headers.get('cache-control')).toContain('max-age=300');

    // Nothing secret is stored in the clear: only an AES-256-GCM envelope.
    const row = deps.db.getActiveRegistryKey();
    expect(row?.kid).toBe(jwk.kid);
    expect(row?.privateKeyEnc.startsWith('v1:')).toBe(true);
    expect(row?.privateKeyEnc).not.toContain('MC4CAQAwBQYDK2Vw'); // PKCS8 Ed25519 header, never plaintext

    // The stored private key round-trips: decrypt -> sign -> verify with the
    // published public key (proves the whole storage chain works end to end).
    const pkcs8 = decryptSecret(row!.privateKeyEnc, deps.config.encryptionKey);
    const privateKey = createPrivateKey({ key: Buffer.from(pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    const message = Buffer.from('bot-relay key roundtrip', 'utf8');
    const signature = cryptoSign(null, message, privateKey);
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    expect(cryptoVerify(null, message, publicKey, signature)).toBe(true);
  });
});

describe('POST /v1/identity-token', () => {
  it('issues a short-lived EdDSA JWT verifiable with nothing but the public key', async () => {
    const clock = mutableClock();
    const { app, alice } = await setup({}, clock.now);
    const res = expectStatus(await api(app, '/v1/identity-token', { method: 'POST', token: alice }), 200);
    expect(res.expires_at).toBe(new Date((Math.floor(clock.now() / 1000) + 300) * 1000).toISOString());

    const { header, claims } = decode(res.token as string);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: expect.stringMatching(/^rk_/) });
    expect(claims.iss).toBe(ISS);
    expect(claims.sub).toBe('alice');
    expect(claims.name).toBe('Alice');
    expect(claims.jti).toMatch(/^jti_/);
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);

    // Independent verification with node:crypto and the JWKS public key only.
    const jwks = await fetchJwks(app);
    const jwk = (jwks.keys as Array<{ kid: string; kty: string; crv: string; x: string }>).find(
      (key) => key.kid === header.kid,
    );
    expect(jwk).toBeTruthy();
    const publicKey = createPublicKey({ key: jwk!, format: 'jwk' });
    const [h, p, s] = (res.token as string).split('.');
    expect(cryptoVerify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s ?? '', 'base64url'))).toBe(true);

    // The exported offline verifier agrees (this is what a called bot runs).
    const offline = verifyIdentityToken(res.token as string, { jwks, iss: ISS, now: clock.now() });
    expect(offline).toMatchObject({ valid: true, claims: { sub: 'alice' } });
  });

  it('requires an active bot token', async () => {
    const { app } = await setup();
    expectStatus(await api(app, '/v1/identity-token', { method: 'POST' }), 401);
    expectStatus(await api(app, '/v1/identity-token', { method: 'POST', token: 'br_not-a-real-token' }), 401);
  });
});

describe('POST /v1/identity/verify', () => {
  it('confirms a valid proof online and reports the subject', async () => {
    const { app, alice, bob } = await setup();
    const token = await issueToken(app, alice);
    const verified = expectStatus(
      await api(app, '/v1/identity/verify', { token: bob, body: { token } }),
      200,
    );
    expect(verified).toEqual({ valid: true, id: 'alice', display_name: 'Alice', disabled: false });
    expectStatus(await api(app, '/v1/identity/verify', { body: { token } }), 401);
  });

  it('rejects malformed, tampered, and expired tokens with 401 invalid_token', async () => {
    const clock = mutableClock();
    const { app, alice, bob } = await setup({}, clock.now);
    const token = await issueToken(app, alice);

    const malformed = expectStatus(
      await api(app, '/v1/identity/verify', { token: bob, body: { token: 'garbage' } }),
      401,
    );
    expect(malformed.error.code).toBe('invalid_token');
    expect(malformed.error.reason).toBe('malformed');

    const [h, p, s] = token.split('.');
    const tampered = expectStatus(
      await api(app, '/v1/identity/verify', { token: bob, body: { token: `${h}.${p}.${flipFirstChar(s ?? '')}` } }),
      401,
    );
    expect(tampered.error.reason).toBe('bad_signature');

    // A non-canonical spelling of the same signature bytes (padding-bit trick)
    // is rejected as well, so textual tampering stays detectable.
    const nonCanonical = expectStatus(
      await api(app, '/v1/identity/verify', { token: bob, body: { token: `${h}.${p}.${flipLastChar(s ?? '')}` } }),
      401,
    );
    expect(nonCanonical.error.reason).toBe('bad_signature');

    const missing = expectStatus(await api(app, '/v1/identity/verify', { token: bob, body: {} }), 401);
    expect(missing.error.code).toBe('invalid_token');

    clock.advance(300_001);
    const expired = expectStatus(
      await api(app, '/v1/identity/verify', { token: bob, body: { token } }),
      401,
    );
    expect(expired.error.reason).toBe('expired');
  });

  it('offline check distinguishes wrong iss and unknown kid', async () => {
    const clock = mutableClock();
    const { app, alice } = await setup({}, clock.now);
    const token = await issueToken(app, alice);
    const jwks = await fetchJwks(app);
    expect(
      verifyIdentityToken(token, { jwks, iss: 'https://someone-else.example', now: clock.now() }),
    ).toEqual({ valid: false, reason: 'wrong_iss' });
    expect(verifyIdentityToken(token, { jwks: { keys: [] }, iss: ISS, now: clock.now() })).toEqual({
      valid: false,
      reason: 'unknown_kid',
    });
  });

  it('reports disabled immediately online while the proof still verifies offline (P0-7②)', async () => {
    const clock = mutableClock();
    const { app, deps, alice, bob } = await setup({}, clock.now);
    const token = await issueToken(app, alice);

    const session = await login(app);
    expectStatus(await api(app, '/admin/api/bots/alice/disable', { method: 'POST', headers: session.headers }), 200);

    // Disabled bots are never issued new proofs.
    expectStatus(await api(app, '/v1/identity-token', { method: 'POST', token: alice }), 403);

    // The already-issued proof keeps verifying offline for its TTL window.
    const offline = verifyIdentityToken(token, { jwks: buildJwks(deps), iss: ISS, now: clock.now() });
    expect(offline.valid).toBe(true);

    // The online channel rejects it right away.
    clock.advance(60_000);
    const online = expectStatus(
      await api(app, '/v1/identity/verify', { token: bob, body: { token } }),
      200,
    );
    expect(online).toEqual({ valid: false, id: 'alice', display_name: 'Alice', disabled: true });
  });

  it('treats a signed proof of a deleted bot as gone', async () => {
    const { app, alice, bob } = await setup();
    const token = await issueToken(app, alice);
    const session = await login(app);
    expectStatus(await api(app, '/admin/api/bots/alice', { method: 'DELETE', headers: session.headers }), 200);
    const verified = expectStatus(await api(app, '/v1/identity/verify', { token: bob, body: { token } }), 200);
    expect(verified).toEqual({ valid: false, id: 'alice', display_name: null, disabled: true });
  });
});

describe('GET /v1/bots/:id/status', () => {
  it('exposes the live disabled flag and 404s for unknown bots', async () => {
    const { app, bob } = await setup();
    const status = expectStatus(await api(app, '/v1/bots/alice/status', { token: bob }), 200);
    expect(status).toEqual({ id: 'alice', display_name: 'Alice', disabled: false });
    expectStatus(await api(app, '/v1/bots/nope/status', { token: bob }), 404);
    expectStatus(await api(app, '/v1/bots/alice/status'), 401);
  });
});

describe('registry key rotation (§7.4)', () => {
  it('publishes old and new public keys during the 1h retirement window, then drops the old one', async () => {
    const clock = mutableClock();
    const { app, deps, alice } = await setup({}, clock.now);
    const before = await issueToken(app, alice);
    const oldKid = decode(before).header.kid as string;

    // Rotation is an explicit admin action (session + CSRF or bearer).
    const session = await login(app);
    const rotated = expectStatus(
      await api(app, '/admin/api/registry-keys/rotate', { method: 'POST', headers: session.headers }),
      200,
    );
    expect(rotated.kid).toMatch(/^rk_/);
    expect(rotated.kid).not.toBe(oldKid);

    const duringWindow = await fetchJwks(app);
    const kids = (duringWindow.keys as Array<{ kid: string }>).map((key) => key.kid);
    expect(kids).toContain(oldKid);
    expect(kids).toContain(rotated.kid);

    // New signatures use the new key; old-key tokens still verify offline.
    const after = await issueToken(app, alice);
    expect(decode(after).header.kid).toBe(rotated.kid);
    expect(verifyIdentityToken(before, { jwks: duringWindow, iss: ISS, now: clock.now() }).valid).toBe(true);

    // Past the retirement window the old key disappears and its tokens die.
    clock.advance(KEY_RETIREMENT_WINDOW_MS + 1);
    const pastWindow = await fetchJwks(app);
    expect((pastWindow.keys as Array<{ kid: string }>).map((key) => key.kid)).toEqual([rotated.kid]);
    expect(verifyIdentityToken(before, { jwks: pastWindow, iss: ISS, now: clock.now() })).toEqual({
      valid: false,
      reason: 'unknown_kid',
    });

    // The rotation is audited (§10.3).
    expect(deps.db.listAuditEvents().some((event) => event.action === 'key.rotated' && event.object === rotated.kid)).toBe(true);
  });
});

describe('inquiry payload signature (§6.3, P0-5⑦)', () => {
  it('signs the outbound inquiry with Ed25519; tampering and late replay fail', async () => {
    const clock = mutableClock();
    const made = makeApp({}, { now: clock.now });
    open.push({ close: () => made.deps.db.close() });
    const hook = await startWebhook();
    open.push(hook);
    const session = await login(made.app);
    const inviteA = await createInvite(made.app, session);
    const alice = await registerBot(made.app, { id: 'alice', invite: inviteA.code, display_name: 'Alice' });
    const inviteB = await createInvite(made.app, session);
    await registerBot(made.app, {
      id: 'bob',
      invite: inviteB.code,
      display_name: 'Bob',
      extra: { webhook_url: hook.url },
    });

    expectStatus(await api(made.app, '/v1/inquiries', { token: alice, body: { to: 'bob' } }), 202);
    await until(() => hook.hits.length === 1);
    const hit = hook.hits[0]!;
    const header = String(hit.headers['x-bot-relay-signature']);
    expect(header).toMatch(/^v1 kid=rk_[0-9a-f]{16} ts=\d+ sig=[A-Za-z0-9_-]+$/);

    // Verify like a receiving bot would: fetch JWKS, check the signature.
    const jwks = await fetchJwks(made.app);
    const verified = verifyInquirySignature({ jwks, header, body: hit.body, now: clock.now() });
    expect(verified).toMatchObject({ ok: true, kid: expect.stringMatching(/^rk_/) });

    // Raw public-key verification without any registry code involved.
    const [, kidPart, tsPart, sigPart] = header.split(' ');
    const jwk = (jwks.keys as Array<{ kid: string; kty: string; crv: string; x: string }>).find(
      (key) => key.kid === kidPart!.slice('kid='.length),
    );
    expect(jwk).toBeTruthy();
    const publicKey = createPublicKey({ key: jwk!, format: 'jwk' });
    const ts = tsPart!.slice('ts='.length);
    const sig = sigPart!.slice('sig='.length);
    expect(cryptoVerify(null, Buffer.from(`${ts}.${hit.body}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(true);

    // Tampering with the body breaks the signature.
    expect(verifyInquirySignature({ jwks, header, body: `${hit.body} `, now: clock.now() })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });

    // Replay outside the tolerance window is rejected.
    clock.advance(INQUIRY_SIGNATURE_TOLERANCE_MS + 1);
    expect(verifyInquirySignature({ jwks, header, body: hit.body, now: clock.now() })).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });

    // Garbage headers and unknown kids never verify.
    expect(verifyInquirySignature({ jwks, header: 'v1 nonsense', body: hit.body, now: clock.now() })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const fakeKid = header.replace(/kid=rk_[0-9a-f]+/, 'kid=rk_0000000000000000');
    expect(verifyInquirySignature({ jwks, header: fakeKid, body: hit.body, now: clock.now() })).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
  });
});

describe('rate limits for the identity surface (§9.2)', () => {
  it('caps identity token issuance at the mutation budget', async () => {
    const { app, alice } = await setup({ mutationRatePerMin: 2 });
    expectStatus(await api(app, '/v1/identity-token', { method: 'POST', token: alice }), 200);
    expectStatus(await api(app, '/v1/identity-token', { method: 'POST', token: alice }), 200);
    const limited = expectStatus(await api(app, '/v1/identity-token', { method: 'POST', token: alice }), 429);
    expect(limited.error.code).toBe('rate_limited');
    expect(limited.error.retry_after).toBe(60);
  });

  it('caps inquiry decisions at the mutation budget', async () => {
    const { app, bob } = await setup({ mutationRatePerMin: 2 });
    const decide = () => api(app, '/v1/inquiries/inq_doesnotexist/decision', { token: bob, body: { decision: 'approve' } });
    expectStatus(await decide(), 404);
    expectStatus(await decide(), 404);
    expectStatus(await decide(), 429);
  });
});
