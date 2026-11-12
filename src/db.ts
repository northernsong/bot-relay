import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { A2A_GATEWAY_ID, TERMINAL_STATES } from './a2a/constants.js';
import { hashToken } from './secret.js';
import type {
  A2aTask,
  Bot,
  BotPatch,
  DeliveryAttempt,
  IdempotencyRecord,
  Message,
  MessageStatus,
  NewA2aTask,
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

CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  context_id TEXT,
  thread_id TEXT NOT NULL,
  relay_message_id TEXT,
  state TEXT NOT NULL,
  remote_message_id TEXT,
  request_text TEXT NOT NULL,
  response_text TEXT,
  history_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_a2a_thread ON a2a_tasks(direction, bot_id, thread_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_remote ON a2a_tasks(direction, bot_id, remote_message_id);
`;

type RawBot = {
  id: string;
  display_name: string;
  webhook_url: string | null;
  auth_header_name: string | null;
  auth_header_value_enc: string | null;
  token_hash: string;
  allowlist: string | null;
  kind: string | null;
  a2a_card_url: string | null;
  a2a_endpoint: string | null;
  a2a_inbound_token_hash: string | null;
  accept_a2a: number | null;
  a2a_auth_in: string | null;
  a2a_tenant: string | null;
  created_at: number;
  updated_at: number;
};

type RawA2aTask = {
  id: string;
  direction: string;
  bot_id: string;
  context_id: string | null;
  thread_id: string;
  relay_message_id: string | null;
  state: string;
  remote_message_id: string | null;
  request_text: string;
  response_text: string | null;
  history_json: string;
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
          token_hash, allowlist, created_at, updated_at, kind, a2a_card_url, a2a_endpoint,
          a2a_inbound_token_hash, accept_a2a, a2a_auth_in, a2a_tenant
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        bot.kind,
        bot.a2aCardUrl,
        bot.a2aEndpoint,
        bot.a2aInboundTokenHash,
        bot.acceptA2a ? 1 : 0,
        bot.a2aAuthIn,
        bot.a2aTenant,
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
    if (Object.prototype.hasOwnProperty.call(patch, 'acceptA2a')) {
      sets.push('accept_a2a = ?');
      values.push(patch.acceptA2a ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'a2aInboundTokenHash')) {
      sets.push('a2a_inbound_token_hash = ?');
      values.push(patch.a2aInboundTokenHash ?? null);
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

  insertA2aTask(task: NewA2aTask): void {
    this.sqlite
      .prepare(
        `INSERT INTO a2a_tasks (
          id, direction, bot_id, context_id, thread_id, relay_message_id, state,
          remote_message_id, request_text, response_text, history_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.direction,
        task.botId,
        task.contextId,
        task.threadId,
        task.relayMessageId,
        task.state,
        task.remoteMessageId,
        task.requestText,
        task.responseText,
        JSON.stringify(task.history),
        task.createdAt,
        task.createdAt,
      );
  }

  getA2aTask(id: string): A2aTask | undefined {
    const row = this.sqlite.prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(id) as RawA2aTask | undefined;
    return row ? mapA2aTask(row) : undefined;
  }

  getA2aTaskByRemote(botId: string, direction: string, remoteMessageId: string): A2aTask | undefined {
    const row = this.sqlite
      .prepare(
        'SELECT * FROM a2a_tasks WHERE direction = ? AND bot_id = ? AND remote_message_id = ?',
      )
      .get(direction, botId, remoteMessageId) as RawA2aTask | undefined;
    return row ? mapA2aTask(row) : undefined;
  }

  hasInboundTask(botId: string, threadId: string): boolean {
    const row = this.sqlite
      .prepare(
        `SELECT 1 AS ok FROM a2a_tasks
         WHERE direction = 'inbound' AND bot_id = ? AND thread_id = ?
         LIMIT 1`,
      )
      .get(botId, threadId) as { ok: number } | undefined;
    return row !== undefined;
  }

  activeInboundTask(botId: string, threadId: string): A2aTask | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM a2a_tasks
         WHERE direction = 'inbound' AND bot_id = ? AND thread_id = ?
           AND state NOT IN ('TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED')
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(botId, threadId) as RawA2aTask | undefined;
    return row ? mapA2aTask(row) : undefined;
  }

  latestOutboundTask(botId: string, threadId: string): A2aTask | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM a2a_tasks
         WHERE direction = 'outbound' AND bot_id = ? AND thread_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(botId, threadId) as RawA2aTask | undefined;
    return row ? mapA2aTask(row) : undefined;
  }

  linkA2aRelayMessage(id: string, relayMessageId: string, now: number): void {
    this.sqlite
      .prepare(
        `UPDATE a2a_tasks
         SET relay_message_id = ?,
             state = CASE WHEN state = 'TASK_STATE_SUBMITTED' THEN 'TASK_STATE_WORKING' ELSE state END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(relayMessageId, now, id);
  }

  completeA2aTask(id: string, responseText: string, history: unknown[], now: number): void {
    const terminal = [...TERMINAL_STATES];
    this.sqlite
      .prepare(
        `UPDATE a2a_tasks
         SET state = 'TASK_STATE_COMPLETED', response_text = ?, history_json = ?, updated_at = ?
         WHERE id = ? AND state NOT IN (${terminal.map(() => '?').join(', ')})`,
      )
      .run(responseText, JSON.stringify(history), now, id, ...terminal);
  }

  setA2aState(id: string, state: string, now: number): void {
    this.sqlite.prepare('UPDATE a2a_tasks SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id);
  }

  mergeMessageMetadata(id: string, extra: Record<string, unknown>): void {
    const message = this.getMessage(id);
    const base =
      message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : {};
    this.sqlite
      .prepare('UPDATE messages SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ ...base, ...extra }), id);
  }

  finishMessage(id: string, status: 'delivered' | 'failed' | 'inbox', lastError: string | null, deliveredAt: number | null): void {
    this.sqlite
      .prepare(
        `UPDATE messages
         SET status = ?, last_error = ?, delivered_at = ?, next_attempt_at = NULL
         WHERE id = ?`,
      )
      .run(status, lastError, deliveredAt, id);
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
  ensureBotColumns(sqlite);
  ensureSystemBot(sqlite);
  return new RelayDb(sqlite);
}

function ensureBotColumns(sqlite: DatabaseSync): void {
  const present = new Set(
    (sqlite.prepare('PRAGMA table_info(bots)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  const add: Array<[string, string]> = [
    ['kind', `TEXT NOT NULL DEFAULT 'relay'`],
    ['a2a_card_url', 'TEXT'],
    ['a2a_endpoint', 'TEXT'],
    ['a2a_inbound_token_hash', 'TEXT'],
    ['accept_a2a', 'INTEGER NOT NULL DEFAULT 1'],
    ['a2a_auth_in', 'TEXT'],
    ['a2a_tenant', 'TEXT'],
  ];
  for (const [name, ddl] of add) {
    if (!present.has(name)) sqlite.exec(`ALTER TABLE bots ADD COLUMN ${name} ${ddl}`);
  }
}

function ensureSystemBot(sqlite: DatabaseSync): void {
  const existing = sqlite.prepare('SELECT id FROM bots WHERE id = ?').get(A2A_GATEWAY_ID) as { id: string } | undefined;
  if (existing) return;
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO bots (
        id, display_name, webhook_url, auth_header_name, auth_header_value_enc,
        token_hash, allowlist, created_at, updated_at, kind, a2a_card_url, a2a_endpoint,
        a2a_inbound_token_hash, accept_a2a, a2a_auth_in, a2a_tenant
      ) VALUES (?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, 'relay', NULL, NULL, NULL, 0, NULL, NULL)`,
    )
    .run(A2A_GATEWAY_ID, 'A2A', hashToken(randomBytes(32).toString('hex')), now, now);
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
    kind: row.kind === 'a2a' ? 'a2a' : 'relay',
    a2aCardUrl: row.a2a_card_url,
    a2aEndpoint: row.a2a_endpoint,
    a2aInboundTokenHash: row.a2a_inbound_token_hash,
    acceptA2a: row.accept_a2a !== 0,
    a2aAuthIn: row.a2a_auth_in === 'query' ? 'query' : row.a2a_auth_in === 'header' ? 'header' : null,
    a2aTenant: row.a2a_tenant,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapA2aTask(row: RawA2aTask): A2aTask {
  let history: unknown[] = [];
  try {
    const parsed = JSON.parse(row.history_json) as unknown;
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    history = [];
  }
  return {
    id: row.id,
    direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
    botId: row.bot_id,
    contextId: row.context_id,
    threadId: row.thread_id,
    relayMessageId: row.relay_message_id,
    state: row.state,
    remoteMessageId: row.remote_message_id,
    requestText: row.request_text,
    responseText: row.response_text,
    history,
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
