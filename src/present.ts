import type { Bot, DeliveryAttempt, Message } from './types.js';

export function presentOwnBot(bot: Bot, token?: string): Record<string, unknown> {
  return {
    id: bot.id,
    display_name: bot.displayName,
    webhook_url: bot.webhookUrl,
    auth_header_name: bot.authHeaderName,
    has_auth_header: bot.authHeaderValueEnc !== null,
    allowlist: bot.allowlist,
    created_at: iso(bot.createdAt),
    updated_at: iso(bot.updatedAt),
    ...(token ? { token } : {}),
  };
}

export function presentPublicBot(bot: Bot): Record<string, unknown> {
  return {
    id: bot.id,
    display_name: bot.displayName,
    delivery: bot.webhookUrl ? 'webhook' : 'inbox',
  };
}

export function presentMessage(message: Message, maxHops: number, attempts?: DeliveryAttempt[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: message.id,
    from: message.fromId,
    to: message.toId,
    thread_id: message.threadId,
    reply_to: message.replyTo,
    hop: message.hop,
    max_hops: maxHops,
    body: message.body,
    metadata: message.metadata,
    status: message.status === 'delivering' ? 'pending' : message.status,
    attempts: message.attempts,
    last_error: message.lastError,
    created_at: iso(message.createdAt),
    delivered_at: message.deliveredAt === null ? null : iso(message.deliveredAt),
  };
  if (attempts) {
    body.delivery = attempts.map((attempt) => ({
      attempt: attempt.attempt,
      status_code: attempt.statusCode,
      error: attempt.error,
      at: iso(attempt.createdAt),
    }));
  }
  return body;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
