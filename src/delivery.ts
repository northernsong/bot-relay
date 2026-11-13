import type { Deps } from './deps.js';
import { envelopeJson } from './envelope.js';
import { decryptSecret } from './secret.js';
import { signPayload } from './sign.js';
import { assertWebhookUrl, BlockedAddressError, pinnedFetch } from './ssrf.js';
import { VERSION } from './version.js';

const ERROR_MAX = 300;

export async function attemptDelivery(deps: Deps, messageId: string): Promise<void> {
  const attempt = deps.db.claimDelivery(messageId);
  if (attempt === undefined) return;
  try {
    await deliverClaimed(deps, messageId, attempt);
  } catch {
    recordAndSettle(deps, messageId, attempt, null, 'delivery failed', false);
  }
}

export async function pumpDeliveries(deps: Deps, limit = 20): Promise<number> {
  const ids = deps.db.dueMessageIds(deps.now(), limit);
  for (const id of ids) await attemptDelivery(deps, id);
  return ids.length;
}

export function startDeliveryWorker(deps: Deps): () => void {
  const interval = Math.max(50, deps.config.deliveryPollMs);
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    pumpDeliveries(deps)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'delivery worker failed';
        console.error(JSON.stringify({ level: 'error', msg: 'delivery worker', error: message }));
      })
      .finally(() => {
        running = false;
      });
  }, interval);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function deliverClaimed(deps: Deps, messageId: string, attempt: number): Promise<void> {
  const message = deps.db.getMessage(messageId);
  if (!message) return;
  const recipient = deps.db.getBot(message.toId);
  if (!recipient || recipient.disabled) {
    recordAndSettle(deps, messageId, attempt, null, recipient ? 'recipient disabled' : 'recipient not found', false);
    return;
  }
  if (!recipient.webhookUrl) {
    deps.db.finishDelivery(messageId, {
      status: 'inbox',
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: null,
    });
    return;
  }

  let webhookUrl: string;
  try {
    webhookUrl = await assertWebhookUrl(recipient.webhookUrl, {
      allowHttp: deps.config.allowHttpWebhooks,
      allowPrivate: deps.config.allowPrivateWebhooks,
      lookupHost: deps.lookup,
    });
  } catch {
    recordAndSettle(deps, messageId, attempt, null, 'webhook url not allowed', false);
    return;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': `bot-relay/${VERSION}`,
  };
  if (recipient.authHeaderName && recipient.authHeaderValueEnc) {
    try {
      headers[recipient.authHeaderName] = decryptSecret(recipient.authHeaderValueEnc, {
        relaySecret: deps.config.relaySecret,
        encryptionKey: deps.config.encryptionKey,
      });
    } catch {
      recordAndSettle(deps, messageId, attempt, null, 'could not decrypt webhook auth header', false);
      return;
    }
  }

  const raw = envelopeJson(message, deps.config.maxHops);
  const timestampSec = Math.floor(deps.now() / 1000);
  headers['x-bot-relay-signature'] = signPayload(raw, deps.config.relaySecret, timestampSec);
  headers['x-bot-relay-timestamp'] = String(timestampSec);
  headers['x-bot-relay-id'] = message.id;

  const fetchImpl = deps.fetchImpl
    ? deps.fetchImpl
    : (url: string, init?: RequestInit) =>
        pinnedFetch(url, init, {
          allowHttp: deps.config.allowHttpWebhooks,
          allowPrivate: deps.config.allowPrivateWebhooks,
          lookupHost: deps.lookup,
          timeoutMs: deps.config.deliveryTimeoutMs,
        });
  let response: Response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers,
      body: raw,
      redirect: 'error',
      signal: AbortSignal.timeout(deps.config.deliveryTimeoutMs),
    });
  } catch (err) {
    const classified = classifyFetchError(err);
    recordAndSettle(deps, messageId, attempt, null, classified.message, classified.retryable);
    return;
  }

  await response.body?.cancel().catch(() => undefined);
  if (response.ok) {
    deps.db.recordAttempt({
      messageId,
      attempt,
      statusCode: response.status,
      error: null,
      createdAt: deps.now(),
    });
    deps.db.finishDelivery(messageId, {
      status: 'delivered',
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: deps.now(),
    });
    return;
  }

  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  recordAndSettle(deps, messageId, attempt, response.status, `HTTP ${response.status}`, retryable);
}

function recordAndSettle(
  deps: Deps,
  messageId: string,
  attempt: number,
  statusCode: number | null,
  error: string,
  retryable: boolean,
): void {
  const clipped = error.slice(0, ERROR_MAX);
  deps.db.recordAttempt({
    messageId,
    attempt,
    statusCode,
    error: clipped,
    createdAt: deps.now(),
  });
  if (retryable && attempt < deps.config.deliveryMaxAttempts) {
    const delay = Math.min(deps.config.deliveryBackoffMs * 2 ** (attempt - 1), 300_000);
    deps.db.finishDelivery(messageId, {
      status: 'pending',
      lastError: clipped,
      nextAttemptAt: deps.now() + delay,
      deliveredAt: null,
    });
    return;
  }
  deps.db.finishDelivery(messageId, {
    status: 'failed',
    lastError: clipped,
    nextAttemptAt: null,
    deliveredAt: null,
  });
}

function classifyFetchError(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof BlockedAddressError || (err && typeof err === 'object' && 'name' in err && err.name === 'BlockedAddressError')) {
    return { message: 'webhook url not allowed', retryable: false };
  }
  if (err && typeof err === 'object' && 'name' in err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { message: 'timeout', retryable: true };
  }
  const cause = err && typeof err === 'object' && 'cause' in err ? err.cause : undefined;
  const causeMsg = cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : '';
  if (causeMsg.toLowerCase().includes('redirect')) {
    return { message: 'redirect not allowed', retryable: false };
  }
  return { message: 'connection failed', retryable: true };
}
