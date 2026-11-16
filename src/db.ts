import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Bot, BotPatch, Invite, NewBot } from './types.js';

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

const SERVER_SECRET = 'server_secret';

export class RelayDb {
  private readonly sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  close(): void {
    this.sqlite.close();
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
