import type { Message } from './types.js';

/**
 * Key order is part of the signed bytes. Do not reorder these fields.
 * `timestamp` is when the relay accepted the message. The signature header
 * carries a separate delivery-time unix timestamp so retries stay fresh.
 */
export function envelopeJson(message: Message, maxHops: number): string {
  return JSON.stringify({
    v: 1,
    id: message.id,
    from: message.fromId,
    to: message.toId,
    thread_id: message.threadId,
    reply_to: message.replyTo,
    hop: message.hop,
    max_hops: maxHops,
    timestamp: new Date(message.createdAt).toISOString(),
    body: message.body,
    metadata: message.metadata,
  });
}
