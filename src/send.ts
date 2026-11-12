import { completeInboundFromReply } from './a2a/bridge.js';
import { A2A_GATEWAY_ID } from './a2a/constants.js';
import { deliverToA2aAgent } from './a2a/outbound.js';
import type { Deps } from './deps.js';
import { attemptDelivery } from './delivery.js';
import { HttpError, isUniqueConstraint } from './errors.js';
import { newMessageId, newThreadId } from './ids.js';
import type { Bot, Message, SendInput } from './types.js';
import { requestHash } from './validate.js';

export type SendOptions = { skipRateLimit?: boolean };

export async function sendMessage(
  deps: Deps,
  sender: Bot,
  input: SendInput,
  idemKey: string | null,
  options: SendOptions = {},
): Promise<{ message: Message; replayed: boolean }> {
  const hash = requestHash(input);
  deps.db.pruneIdempotency(deps.now() - deps.config.idempotencyTtlSec * 1000);

  if (idemKey) {
    const existing = deps.db.getIdempotency(sender.id, idemKey);
    if (existing) return replayOrConflict(deps, existing.messageId, existing.requestHash, hash);
  }

  if (!options.skipRateLimit) {
    const rate = deps.db.consumeRate(
      sender.id,
      deps.now(),
      deps.config.rateLimitWindowSec * 1000,
      deps.config.rateLimitMax,
    );
    if (!rate.allowed) {
      throw new HttpError(
        429,
        'rate_limited',
        `Too many messages. Limit is ${deps.config.rateLimitMax} per ${deps.config.rateLimitWindowSec}s.`,
        { 'retry-after': String(rate.retryAfterSec) },
        { retry_after: rate.retryAfterSec },
      );
    }
  }

  let messageId = '';
  let replayed = false;
  try {
    deps.db.transaction(() => {
      if (idemKey) {
        const existing = deps.db.getIdempotency(sender.id, idemKey);
        if (existing) {
          if (existing.requestHash !== hash) {
            throw new HttpError(409, 'idempotency_conflict', 'This Idempotency-Key was already used with a different request');
          }
          messageId = existing.messageId;
          replayed = true;
          return;
        }
      }

      const recipient = deps.db.getBot(input.to);
      if (!recipient) {
        throw new HttpError(404, 'recipient_not_found', `No bot is registered as "${input.to}"`);
      }
      if (recipient.allowlist && !recipient.allowlist.includes(sender.id)) {
        throw new HttpError(403, 'not_allowed', 'Recipient does not accept messages from this sender');
      }

      const thread = resolveThread(deps, sender.id, input);
      if (recipient.id === A2A_GATEWAY_ID && !deps.db.hasInboundTask(sender.id, thread.threadId)) {
        throw new HttpError(403, 'not_allowed', 'Replies to a2a must stay on the A2A task thread');
      }
      if (thread.hop > deps.config.maxHops) {
        throw new HttpError(409, 'hop_limit', `This thread has reached the hop limit of ${deps.config.maxHops}`);
      }

      messageId = newMessageId();
      const mode = recipient.kind === 'a2a' ? 'a2a' : recipient.webhookUrl ? 'webhook' : 'inbox';
      deps.db.insertMessage({
        id: messageId,
        fromId: sender.id,
        toId: recipient.id,
        threadId: thread.threadId,
        replyTo: input.replyTo,
        body: input.body,
        metadata: input.metadata,
        hop: thread.hop,
        status: mode === 'inbox' ? 'inbox' : 'pending',
        nextAttemptAt: mode === 'webhook' ? deps.now() : null,
        createdAt: deps.now(),
      });
      if (idemKey) {
        deps.db.insertIdempotency({
          botId: sender.id,
          key: idemKey,
          messageId,
          requestHash: hash,
          createdAt: deps.now(),
        });
      }
    });
  } catch (err) {
    if (idemKey && isUniqueConstraint(err, 'idempotency_keys')) {
      const existing = deps.db.getIdempotency(sender.id, idemKey);
      if (existing) return replayOrConflict(deps, existing.messageId, existing.requestHash, hash);
    }
    throw err;
  }

  let message = deps.db.getMessage(messageId);
  if (!message) throw new HttpError(500, 'internal', 'Message disappeared after insert');
  if (!replayed && message.status === 'pending') {
    const recipient = deps.db.getBot(message.toId);
    if (recipient?.kind === 'a2a') await deliverToA2aAgent(deps, message);
    else await attemptDelivery(deps, message.id);
    message = deps.db.getMessage(message.id) ?? message;
  }
  if (!replayed) completeInboundFromReply(deps, message);
  return { message, replayed };
}

function replayOrConflict(deps: Deps, messageId: string, storedHash: string, hash: string): { message: Message; replayed: boolean } {
  if (storedHash !== hash) {
    throw new HttpError(409, 'idempotency_conflict', 'This Idempotency-Key was already used with a different request');
  }
  const message = deps.db.getMessage(messageId);
  if (!message) throw new HttpError(500, 'internal', 'Stored message for this Idempotency-Key is missing');
  return { message, replayed: true };
}

function resolveThread(deps: Deps, senderId: string, input: SendInput): { threadId: string; hop: number } {
  if (input.replyTo) {
    const parent = deps.db.getMessage(input.replyTo);
    if (!parent) throw new HttpError(400, 'invalid_request', 'reply_to does not match a message');
    if (parent.fromId !== senderId && parent.toId !== senderId) {
      throw new HttpError(403, 'not_allowed', 'You are not a participant in the message you are replying to');
    }
    if (input.threadId && input.threadId !== parent.threadId) {
      throw new HttpError(400, 'invalid_request', 'thread_id does not match reply_to');
    }
    return { threadId: parent.threadId, hop: deps.db.maxHop(parent.threadId) + 1 };
  }

  if (input.threadId) {
    const maxHop = deps.db.maxHop(input.threadId);
    if (maxHop === 0) return { threadId: input.threadId, hop: 1 };
    if (!deps.db.isParticipant(input.threadId, senderId)) {
      throw new HttpError(403, 'not_allowed', 'You are not a participant in this thread');
    }
    return { threadId: input.threadId, hop: maxHop + 1 };
  }

  return { threadId: newThreadId(), hop: 1 };
}
