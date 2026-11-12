import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  Bot,
  BotPatch,
  DeliveryAttempt,
  IdempotencyRecord,
  Message,
  MessageStatus,
  NewBot,
  NewMessage,
} from './types.js';

const MIGRATION = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  webhook_url TEXT,
  auth_header_name TEXT,
  auth_header_value_enc TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  allowlist TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  reply_to TEXT,
  body TEXT NOT NULL,
  metadata TEXT,
  hop INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  inbox_acked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_id, inbox_acked_at, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, key)
);

CREATE TABLE IF NOT EXISTS rate_hits (
  bot_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits(bot_id, created_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status_code INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_message ON delivery_attempts(message_id, attempt);
`;

type RawBot = {
  id: string;
  display_name: string;
  webhook_url: string | null;
  auth_header_name: string | null;
  auth_header_value_enc: string | null;
  token_hash: string;
  allowlist: string | null;
  created_at: number;
  updated_at: number;
};

type RawMessage = {
  id: string;
  from_id: string;
  to_id: string;
  thread_id: string;
  reply_to: string | null;
  body: string;
  metadata: string | null;
  hop: number;
  status: MessageStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
  created_at: number;
  delivered_at: number | null;
  inbox_acked_at: number | null;
};

export class RelayDb {
  private readonly sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
    this.requeueInFlight(Date.now());
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

  insertBot(bot: NewBot): void {
    this.sqlite
      .prepare(
        `INSERT INTO bots (
          id, display_name, webhook_url, auth_header_name, auth_header_value_enc,
          token_hash, allowlist, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bot.id,
        bot.displayName,
        bot.webhookUrl,
        bot.authHeaderName,
        bot.authHeaderValueEnc,
        bot.tokenHash,
        encodeAllowlist(bot.allowlist),
        bot.createdAt,
        bot.updatedAt,
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

  updateBot(id: string, patch: BotPatch, now: number): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const columns: Array<
      ['displayName' | 'webhookUrl' | 'authHeaderName' | 'authHeaderValueEnc' | 'tokenHash', string]
    > = [
      ['displayName', 'display_name'],
      ['webhookUrl', 'webhook_url'],
      ['authHeaderName', 'auth_header_name'],
      ['authHeaderValueEnc', 'auth_header_value_enc'],
      ['tokenHash', 'token_hash'],
    ];
    for (const [key, column] of columns) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        sets.push(`${column} = ?`);
        const value = patch[key];
        values.push(value ?? null);
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'allowlist')) {
      sets.push('allowlist = ?');
      values.push(encodeAllowlist(patch.allowlist ?? null));
    }
    sets.push('updated_at = ?');
    values.push(now);
    values.push(id);
    this.sqlite.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteBot(id: string): boolean {
    return this.transaction(() => {
      const result = this.sqlite.prepare('DELETE FROM bots WHERE id = ?').run(id);
      this.sqlite.prepare('DELETE FROM idempotency_keys WHERE bot_id = ?').run(id);
      this.sqlite.prepare('DELETE FROM rate_hits WHERE bot_id = ?').run(id);
      return Number(result.changes) > 0;
    });
  }

  insertMessage(message: NewMessage): void {
    this.sqlite
      .prepare(
        `INSERT INTO messages (
          id, from_id, to_id, thread_id, reply_to, body, metadata, hop, status,
          attempts, last_error, next_attempt_at, created_at, delivered_at, inbox_acked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        message.id,
        message.fromId,
        message.toId,
        message.threadId,
        message.replyTo,
        message.body,
        message.metadata === null ? null : JSON.stringify(message.metadata),
        message.hop,
        message.status,
        message.nextAttemptAt,
        message.createdAt,
      );
  }

  getMessage(id: string): Message | undefined {
    const row = this.sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(id) as RawMessage | undefined;
    return row ? mapMessage(row) : undefined;
  }

  maxHop(threadId: string): number {
    const row = this.sqlite
      .prepare('SELECT COALESCE(MAX(hop), 0) AS hop FROM messages WHERE thread_id = ?')
      .get(threadId) as { hop: number };
    return Number(row.hop);
  }

  isParticipant(threadId: string, botId: string): boolean {
    const row = this.sqlite
      .prepare('SELECT 1 AS ok FROM messages WHERE thread_id = ? AND (from_id = ? OR to_id = ?) LIMIT 1')
      .get(threadId, botId, botId) as { ok: number } | undefined;
    return row !== undefined;
  }

  listInbox(botId: string, limit: number): Message[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM messages
         WHERE to_id = ? AND inbox_acked_at IS NULL
         ORDER BY created_at ASC, rowid ASC
         LIMIT ?`,
      )
      .all(botId, limit) as unknown as RawMessage[];
    return rows.map(mapMessage);
  }

  ackInbox(botId: string, ids: string[], now: number): number {
    const stmt = this.sqlite.prepare(
      'UPDATE messages SET inbox_acked_at = ? WHERE id = ? AND to_id = ? AND inbox_acked_at IS NULL',
    );
    return this.transaction(() => {
      let acked = 0;
      for (const id of ids) acked += Number(stmt.run(now, id, botId).changes);
      return acked;
    });
  }

  insertIdempotency(record: { botId: string; key: string; messageId: string; requestHash: string; createdAt: number }): void {
    this.sqlite
      .prepare(
        'INSERT INTO idempotency_keys (bot_id, key, message_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.botId, record.key, record.messageId, record.requestHash, record.createdAt);
  }

  getIdempotency(botId: string, key: string): IdempotencyRecord | undefined {
    const row = this.sqlite
      .prepare('SELECT message_id, request_hash FROM idempotency_keys WHERE bot_id = ? AND key = ?')
      .get(botId, key) as { message_id: string; request_hash: string } | undefined;
    if (!row) return undefined;
    return { messageId: row.message_id, requestHash: row.request_hash };
  }

  pruneIdempotency(olderThan: number): void {
    this.sqlite.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(olderThan);
  }

  consumeRate(botId: string, now: number, windowMs: number, max: number): { allowed: boolean; retryAfterSec: number } {
    return this.transaction(() => {
      const cutoff = now - windowMs;
      this.sqlite.prepare('DELETE FROM rate_hits WHERE bot_id = ? AND created_at < ?').run(botId, cutoff);
      const countRow = this.sqlite
        .prepare('SELECT COUNT(*) AS n FROM rate_hits WHERE bot_id = ? AND created_at >= ?')
        .get(botId, cutoff) as { n: number };
      const count = Number(countRow.n);
      if (count >= max) {
        const oldest = this.sqlite
          .prepare('SELECT MIN(created_at) AS created_at FROM rate_hits WHERE bot_id = ? AND created_at >= ?')
          .get(botId, cutoff) as { created_at: number | null };
        const retryAfterSec =
          oldest.created_at === null
            ? Math.max(1, Math.ceil(windowMs / 1000))
            : Math.max(1, Math.ceil((Number(oldest.created_at) + windowMs - now) / 1000));
        return { allowed: false, retryAfterSec };
      }
      this.sqlite.prepare('INSERT INTO rate_hits (bot_id, created_at) VALUES (?, ?)').run(botId, now);
      return { allowed: true, retryAfterSec: 0 };
    });
  }

  claimDelivery(id: string): number | undefined {
    const row = this.sqlite
      .prepare(
        `UPDATE messages
         SET status = 'delivering', attempts = attempts + 1
         WHERE id = ? AND status = 'pending'
         RETURNING attempts`,
      )
      .get(id) as { attempts: number } | undefined;
    return row ? Number(row.attempts) : undefined;
  }

  finishDelivery(
    id: string,
    patch: { status: 'pending' | 'delivered' | 'failed' | 'inbox'; lastError: string | null; nextAttemptAt: number | null; deliveredAt: number | null },
  ): void {
    this.sqlite
      .prepare(
        `UPDATE messages
         SET status = ?, last_error = ?, next_attempt_at = ?, delivered_at = ?
         WHERE id = ? AND status = 'delivering'`,
      )
      .run(patch.status, patch.lastError, patch.nextAttemptAt, patch.deliveredAt, id);
  }

  recordAttempt(attempt: { messageId: string; attempt: number; statusCode: number | null; error: string | null; createdAt: number }): void {
    this.sqlite
      .prepare(
        'INSERT INTO delivery_attempts (message_id, attempt, status_code, error, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(attempt.messageId, attempt.attempt, attempt.statusCode, attempt.error, attempt.createdAt);
  }

  listAttempts(messageId: string): DeliveryAttempt[] {
    const rows = this.sqlite
      .prepare(
        'SELECT attempt, status_code, error, created_at FROM delivery_attempts WHERE message_id = ? ORDER BY attempt ASC, id ASC',
      )
      .all(messageId) as unknown as Array<{ attempt: number; status_code: number | null; error: string | null; created_at: number }>;
    return rows.map((row) => ({
      attempt: Number(row.attempt),
      statusCode: row.status_code === null ? null : Number(row.status_code),
      error: row.error,
      createdAt: Number(row.created_at),
    }));
  }

  dueMessageIds(now: number, limit: number): string[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id FROM messages
         WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, rowid ASC
         LIMIT ?`,
      )
      .all(now, limit) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private requeueInFlight(now: number): void {
    // A crash mid-delivery leaves the row in `delivering`. Put it back so it is tried again.
    // Recipients must dedupe on message id because this can deliver a message twice.
    this.sqlite
      .prepare(`UPDATE messages SET status = 'pending', next_attempt_at = ? WHERE status = 'delivering'`)
      .run(now);
  }
}

export function openDatabase(path: string): RelayDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 3000');
  if (path !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec(MIGRATION);
  return new RelayDb(sqlite);
}

function mapBot(row: RawBot): Bot {
  return {
    id: row.id,
    displayName: row.display_name,
    webhookUrl: row.webhook_url,
    authHeaderName: row.auth_header_name,
    authHeaderValueEnc: row.auth_header_value_enc,
    tokenHash: row.token_hash,
    allowlist: decodeAllowlist(row.allowlist),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapMessage(row: RawMessage): Message {
  let metadata: unknown | null = null;
  if (row.metadata !== null) {
    try {
      metadata = JSON.parse(row.metadata) as unknown;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    threadId: row.thread_id,
    replyTo: row.reply_to,
    body: row.body,
    metadata,
    hop: Number(row.hop),
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    createdAt: Number(row.created_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    inboxAckedAt: row.inbox_acked_at === null ? null : Number(row.inbox_acked_at),
  };
}

function encodeAllowlist(allowlist: string[] | null | undefined): string | null {
  if (allowlist === null || allowlist === undefined) return null;
  return JSON.stringify(allowlist);
}

function decodeAllowlist(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) return [];
    return parsed;
  } catch {
    return [];
  }
}
