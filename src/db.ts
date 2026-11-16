import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Bot, BotPatch, Grant, Inquiry, InquiryStatus, Invite, NewBot } from './types.js';

/**
 * Fresh schema for the pure registry (design §4). There is no message, task,
 * delivery, or inbox table anywhere: this service never stores message bodies.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '',
  webhook_url_enc TEXT NOT NULL,
  webhook_auth_name TEXT NOT NULL DEFAULT '',
  webhook_auth_value_enc TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  token_set_at INTEGER NOT NULL,
  token_revoked_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  intake_mode TEXT NOT NULL DEFAULT 'open',
  intake_allowlist TEXT,
  contact_version INTEGER NOT NULL DEFAULT 1,
  webhook_secret_set_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bots_disabled ON bots(disabled);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  label TEXT,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  decided_at INTEGER,
  delivery_error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inquiry_active
  ON inquiries(requester_id, target_id)
  WHERE status IN ('delivering', 'pending');
CREATE INDEX IF NOT EXISTS idx_inquiry_target ON inquiries(target_id, status);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  inquiry_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  abandoned_at INTEGER,
  refreshed_at INTEGER,
  refreshed_contact_version INTEGER,
  UNIQUE(requester_id, target_id)
);

CREATE TABLE IF NOT EXISTS registry_keys (
  kid TEXT PRIMARY KEY,
  private_key_enc TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object TEXT,
  detail TEXT,
  source TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);

CREATE TABLE IF NOT EXISTS rate_hits (
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits(key, created_at);
`;

type RawBot = {
  id: string;
  display_name: string;
  capabilities: string;
  webhook_url_enc: string;
  webhook_auth_name: string;
  webhook_auth_value_enc: string;
  token_hash: string;
  token_set_at: number;
  token_revoked_at: number | null;
  disabled: number;
  intake_mode: string;
  intake_allowlist: string | null;
  contact_version: number;
  webhook_secret_set_at: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
};

type RawInquiry = {
  id: string;
  requester_id: string;
  target_id: string;
  status: string;
  created_at: number;
  expires_at: number;
  delivered_at: number | null;
  decided_at: number | null;
  delivery_error: string | null;
};

type RawGrant = {
  id: string;
  requester_id: string;
  target_id: string;
  inquiry_id: string;
  granted_at: number;
  revoked_at: number | null;
  abandoned_at: number | null;
  refreshed_at: number | null;
  refreshed_contact_version: number | null;
};

const SERVER_SECRET = 'server_secret';

export class RelayDb {
  private readonly sqlite: DatabaseSync;
  private sqliteClosed = false;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  close(): void {
    this.sqliteClosed = true;
    this.sqlite.close();
  }

  /** True once close() ran; background tasks check this before touching the DB. */
  get closed(): boolean {
    return this.sqliteClosed;
  }

  ping(): boolean {
    const row = this.sqlite.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  transaction<T>(fn: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.sqlite.exec('ROLLBACK');
      } catch {
        // The transaction may already be closed.
      }
      throw err;
    }
  }

  /**
   * Secret used to sign admin session cookies. Generated on first use and
   * stored in `kv`, so rotating ENCRYPTION_KEY does not invalidate sessions.
   */
  getServerSecret(): string {
    const existing = this.sqlite
      .prepare('SELECT value FROM kv WHERE name = ?')
      .get(SERVER_SECRET) as { value: string } | undefined;
    if (existing) return existing.value;
    const candidate = randomBytes(32).toString('hex');
    this.sqlite.prepare('INSERT OR IGNORE INTO kv (name, value) VALUES (?, ?)').run(SERVER_SECRET, candidate);
    const row = this.sqlite
      .prepare('SELECT value FROM kv WHERE name = ?')
      .get(SERVER_SECRET) as { value: string };
    return row.value;
  }

  insertBot(bot: NewBot): void {
    this.sqlite
      .prepare(
        `INSERT INTO bots (
          id, display_name, capabilities, webhook_url_enc, webhook_auth_name, webhook_auth_value_enc,
          token_hash, token_set_at, token_revoked_at, disabled, intake_mode, intake_allowlist,
          contact_version, webhook_secret_set_at, created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bot.id,
        bot.displayName,
        bot.capabilities,
        bot.webhookUrlEnc,
        bot.webhookAuthName,
        bot.webhookAuthValueEnc,
        bot.tokenHash,
        bot.tokenSetAt,
        bot.tokenRevokedAt,
        bot.disabled ? 1 : 0,
        bot.intakeMode,
        encodeIdList(bot.intakeAllowlist),
        bot.contactVersion ?? 1,
        bot.webhookSecretSetAt ?? 0,
        bot.createdAt,
        bot.updatedAt,
        bot.lastSeenAt,
      );
  }

  getBot(id: string): Bot | undefined {
    const row = this.sqlite.prepare('SELECT * FROM bots WHERE id = ?').get(id) as RawBot | undefined;
    return row ? mapBot(row) : undefined;
  }

  getBotByTokenHash(hash: string): Bot | undefined {
    const row = this.sqlite.prepare('SELECT * FROM bots WHERE token_hash = ?').get(hash) as RawBot | undefined;
    return row ? mapBot(row) : undefined;
  }

  listBots(): Bot[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM bots ORDER BY created_at ASC, id ASC')
      .all() as unknown as RawBot[];
    return rows.map(mapBot);
  }

  updateBot(id: string, patch: BotPatch, now: number): void {
    const columns: Array<[keyof BotPatch, string]> = [
      ['displayName', 'display_name'],
      ['capabilities', 'capabilities'],
      ['webhookUrlEnc', 'webhook_url_enc'],
      ['webhookAuthName', 'webhook_auth_name'],
      ['webhookAuthValueEnc', 'webhook_auth_value_enc'],
      ['tokenHash', 'token_hash'],
      ['tokenSetAt', 'token_set_at'],
      ['tokenRevokedAt', 'token_revoked_at'],
      ['disabled', 'disabled'],
      ['contactVersion', 'contact_version'],
      ['webhookSecretSetAt', 'webhook_secret_set_at'],
      ['lastSeenAt', 'last_seen_at'],
    ];
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, column] of columns) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const value = patch[key];
        sets.push(`${column} = ?`);
        if (key === 'disabled') values.push(value === true ? 1 : 0);
        else values.push(value === undefined ? null : (value as string | number | null));
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'intakeMode')) {
      sets.push('intake_mode = ?');
      values.push(patch.intakeMode ?? 'open');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'intakeAllowlist')) {
      sets.push('intake_allowlist = ?');
      values.push(encodeIdList(patch.intakeAllowlist ?? null));
    }
    sets.push('updated_at = ?');
    values.push(now);
    values.push(id);
    this.sqlite.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Removes the bot along with its inquiries and grants. */
  deleteBot(id: string): boolean {
    return this.transaction(() => {
      const result = this.sqlite.prepare('DELETE FROM bots WHERE id = ?').run(id);
      this.sqlite.prepare('DELETE FROM inquiries WHERE requester_id = ? OR target_id = ?').run(id, id);
      this.sqlite.prepare('DELETE FROM grants WHERE requester_id = ? OR target_id = ?').run(id, id);
      return Number(result.changes) > 0;
    });
  }

  /** Update last_seen_at only; never bumps updated_at (directory churn). */
  touchBot(id: string, now: number): void {
    this.sqlite.prepare('UPDATE bots SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  insertInquiry(inquiry: Inquiry): void {
    this.sqlite
      .prepare(
        `INSERT INTO inquiries (id, requester_id, target_id, status, created_at, expires_at, delivered_at, decided_at, delivery_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        inquiry.id,
        inquiry.requesterId,
        inquiry.targetId,
        inquiry.status,
        inquiry.createdAt,
        inquiry.expiresAt,
        inquiry.deliveredAt,
        inquiry.decidedAt,
        inquiry.deliveryError,
      );
  }

  getInquiry(id: string): Inquiry | undefined {
    const row = this.sqlite.prepare('SELECT * FROM inquiries WHERE id = ?').get(id) as RawInquiry | undefined;
    return row ? mapInquiry(row) : undefined;
  }

  /** The one delivering/pending inquiry for a pair, kept unique by partial index. */
  getActiveInquiry(requesterId: string, targetId: string): Inquiry | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM inquiries
         WHERE requester_id = ? AND target_id = ? AND status IN ('delivering', 'pending')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(requesterId, targetId) as RawInquiry | undefined;
    return row ? mapInquiry(row) : undefined;
  }

  listInquiries(filter: { requesterId?: string; targetId?: string; status?: InquiryStatus }): Inquiry[] {
    const clauses: string[] = [];
    const values: Array<string> = [];
    if (filter.requesterId !== undefined) {
      clauses.push('requester_id = ?');
      values.push(filter.requesterId);
    }
    if (filter.targetId !== undefined) {
      clauses.push('target_id = ?');
      values.push(filter.targetId);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      values.push(filter.status);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.sqlite
      .prepare(`SELECT * FROM inquiries${where} ORDER BY created_at DESC, id DESC`)
      .all(...values) as unknown as RawInquiry[];
    return rows.map(mapInquiry);
  }

  /** Conditional state transition; returns false when the row already moved on. */
  transitionInquiry(
    id: string,
    expected: InquiryStatus,
    patch: { status: InquiryStatus; deliveredAt?: number; decidedAt?: number; deliveryError?: string | null },
  ): boolean {
    const sets = ['status = ?'];
    const values: Array<string | number | null> = [patch.status];
    if (patch.deliveredAt !== undefined) {
      sets.push('delivered_at = ?');
      values.push(patch.deliveredAt);
    }
    if (patch.decidedAt !== undefined) {
      sets.push('decided_at = ?');
      values.push(patch.decidedAt);
    }
    if (patch.deliveryError !== undefined) {
      sets.push('delivery_error = ?');
      values.push(patch.deliveryError);
    }
    values.push(id, expected);
    const result = this.sqlite
      .prepare(`UPDATE inquiries SET ${sets.join(', ')} WHERE id = ? AND status = ?`)
      .run(...values);
    return Number(result.changes) === 1;
  }

  /** Sweep: pending past expires_at becomes expired (lazy + timer both call this). */
  expirePendingInquiries(now: number): number {
    const result = this.sqlite
      .prepare(`UPDATE inquiries SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`)
      .run(now);
    return Number(result.changes);
  }

  /** Sweep: delivering rows stuck longer than stuckMs (crash residue) become undelivered. */
  failStuckDeliveries(now: number, stuckMs: number, error: string): number {
    const result = this.sqlite
      .prepare(
        `UPDATE inquiries SET status = 'undelivered', delivery_error = ?
         WHERE status = 'delivering' AND created_at <= ?`,
      )
      .run(error, now - stuckMs);
    return Number(result.changes);
  }

  insertGrant(grant: Grant): void {
    this.sqlite
      .prepare(
        `INSERT INTO grants (
          id, requester_id, target_id, inquiry_id, granted_at, revoked_at, abandoned_at,
          refreshed_at, refreshed_contact_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.id,
        grant.requesterId,
        grant.targetId,
        grant.inquiryId,
        grant.grantedAt,
        grant.revokedAt,
        grant.abandonedAt,
        grant.refreshedAt,
        grant.refreshedContactVersion,
      );
  }

  getGrant(id: string): Grant | undefined {
    const row = this.sqlite.prepare('SELECT * FROM grants WHERE id = ?').get(id) as RawGrant | undefined;
    return row ? mapGrant(row) : undefined;
  }

  findGrantByPair(requesterId: string, targetId: string): Grant | undefined {
    const row = this.sqlite
      .prepare('SELECT * FROM grants WHERE requester_id = ? AND target_id = ?')
      .get(requesterId, targetId) as RawGrant | undefined;
    return row ? mapGrant(row) : undefined;
  }

  listGrants(filter: { requesterId?: string; targetId?: string }): Grant[] {
    const clauses: string[] = [];
    const values: Array<string> = [];
    if (filter.requesterId !== undefined) {
      clauses.push('requester_id = ?');
      values.push(filter.requesterId);
    }
    if (filter.targetId !== undefined) {
      clauses.push('target_id = ?');
      values.push(filter.targetId);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.sqlite
      .prepare(`SELECT * FROM grants${where} ORDER BY granted_at DESC, id DESC`)
      .all(...values) as unknown as RawGrant[];
    return rows.map(mapGrant);
  }

  updateGrant(id: string, patch: Partial<Omit<Grant, 'id'>>): void {
    const columns: Array<[keyof Omit<Grant, 'id'>, string]> = [
      ['inquiryId', 'inquiry_id'],
      ['grantedAt', 'granted_at'],
      ['revokedAt', 'revoked_at'],
      ['abandonedAt', 'abandoned_at'],
      ['refreshedAt', 'refreshed_at'],
      ['refreshedContactVersion', 'refreshed_contact_version'],
    ];
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, column] of columns) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const value = patch[key];
        sets.push(`${column} = ?`);
        values.push(value === undefined ? null : value);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.sqlite.prepare(`UPDATE grants SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  consumeRate(key: string, now: number, windowMs: number, max: number): { allowed: boolean; retryAfterSec: number } {
    return this.transaction(() => {
      const cutoff = now - windowMs;
      this.sqlite.prepare('DELETE FROM rate_hits WHERE key = ? AND created_at < ?').run(key, cutoff);
      const countRow = this.sqlite
        .prepare('SELECT COUNT(*) AS n FROM rate_hits WHERE key = ? AND created_at >= ?')
        .get(key, cutoff) as { n: number };
      const count = Number(countRow.n);
      if (count >= max) {
        const oldest = this.sqlite
          .prepare('SELECT MIN(created_at) AS created_at FROM rate_hits WHERE key = ? AND created_at >= ?')
          .get(key, cutoff) as { created_at: number | null };
        const retryAfterSec =
          oldest.created_at === null
            ? Math.max(1, Math.ceil(windowMs / 1000))
            : Math.max(1, Math.ceil((Number(oldest.created_at) + windowMs - now) / 1000));
        return { allowed: false, retryAfterSec };
      }
      this.sqlite.prepare('INSERT INTO rate_hits (key, created_at) VALUES (?, ?)').run(key, now);
      return { allowed: true, retryAfterSec: 0 };
    });
  }

  insertInvite(invite: { codeHash: string; codePrefix: string; label: string | null; maxUses: number; expiresAt: number | null; createdAt: number }): number {
    const result = this.sqlite
      .prepare(
        `INSERT INTO invites (code_hash, code_prefix, label, max_uses, uses, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, 0, ?, NULL, ?)`,
      )
      .run(invite.codeHash, invite.codePrefix, invite.label, invite.maxUses, invite.expiresAt, invite.createdAt);
    return Number(result.lastInsertRowid);
  }

  listInvites(): Invite[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, code_prefix, label, max_uses, uses, expires_at, revoked_at, created_at
         FROM invites ORDER BY id DESC`,
      )
      .all() as unknown as Array<{
      id: number;
      code_prefix: string;
      label: string | null;
      max_uses: number;
      uses: number;
      expires_at: number | null;
      revoked_at: number | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      codePrefix: row.code_prefix,
      label: row.label,
      maxUses: Number(row.max_uses),
      uses: Number(row.uses),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
      createdAt: Number(row.created_at),
    }));
  }

  consumeInvite(codeHash: string, now: number): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE invites
         SET uses = uses + 1
         WHERE code_hash = ?
           AND revoked_at IS NULL
           AND uses < max_uses
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(codeHash, now);
    return Number(result.changes) === 1;
  }

  revokeInvite(id: number, now: number): boolean {
    const result = this.sqlite
      .prepare(`UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(now, id);
    return Number(result.changes) === 1;
  }
}

export function openDatabase(path: string): RelayDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 3000');
  if (path !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec(SCHEMA);
  return new RelayDb(sqlite);
}

function mapBot(row: RawBot): Bot {
  const mode = row.intake_mode;
  return {
    id: row.id,
    displayName: row.display_name,
    capabilities: row.capabilities,
    webhookUrlEnc: row.webhook_url_enc,
    webhookAuthName: row.webhook_auth_name,
    webhookAuthValueEnc: row.webhook_auth_value_enc,
    tokenHash: row.token_hash,
    tokenSetAt: Number(row.token_set_at),
    tokenRevokedAt: row.token_revoked_at === null ? null : Number(row.token_revoked_at),
    disabled: row.disabled === 1,
    intakeMode: mode === 'allowlist' ? 'allowlist' : mode === 'none' ? 'none' : 'open',
    intakeAllowlist: decodeIdList(row.intake_allowlist),
    contactVersion: Number(row.contact_version),
    webhookSecretSetAt: Number(row.webhook_secret_set_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
  };
}

function mapInquiry(row: RawInquiry): Inquiry {
  return {
    id: row.id,
    requesterId: row.requester_id,
    targetId: row.target_id,
    status: mapInquiryStatus(row.status),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
    deliveryError: row.delivery_error,
  };
}

function mapInquiryStatus(raw: string): InquiryStatus {
  return raw === 'delivering' || raw === 'pending' || raw === 'approved' || raw === 'rejected' || raw === 'expired' || raw === 'undelivered'
    ? raw
    : 'undelivered';
}

function mapGrant(row: RawGrant): Grant {
  return {
    id: row.id,
    requesterId: row.requester_id,
    targetId: row.target_id,
    inquiryId: row.inquiry_id,
    grantedAt: Number(row.granted_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    abandonedAt: row.abandoned_at === null ? null : Number(row.abandoned_at),
    refreshedAt: row.refreshed_at === null ? null : Number(row.refreshed_at),
    refreshedContactVersion: row.refreshed_contact_version === null ? null : Number(row.refreshed_contact_version),
  };
}

function encodeIdList(ids: string[] | null | undefined): string | null {
  if (ids === null || ids === undefined) return null;
  return JSON.stringify(ids);
}

function decodeIdList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) return [];
    return parsed;
  } catch {
    return [];
  }
}
