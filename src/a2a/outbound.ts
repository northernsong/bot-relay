import { randomBytes } from 'node:crypto';

import type { Deps } from '../deps.js';
import { decryptSecret } from '../secret.js';
import { sendMessage } from '../send.js';
import type { Bot, Message } from '../types.js';
import { isPlainObject } from '../validate.js';
import { A2A_PROTOCOL_VERSION, isTerminal } from './constants.js';
import { partsText } from './protocol.js';

export async function deliverToA2aAgent(deps: Deps, message: Message): Promise<void> {
  const peer = deps.db.getBot(message.toId);
  if (!peer || peer.kind !== 'a2a' || !peer.a2aEndpoint) {
    deps.db.finishMessage(message.id, 'failed', 'agent endpoint missing', null);
    return;
  }
  const previous = deps.db.latestOutboundTask(peer.id, message.threadId);
  const contextId = previous?.contextId ?? null;
  const taskId = previous && !isTerminal(previous.state) ? previous.id : null;
  try {
    const first = await call(deps, peer, 'SendMessage', {
      message: {
        messageId: message.id,
        role: 'ROLE_USER',
        parts: [{ text: message.body, mediaType: 'text/plain' }],
        ...(contextId ? { contextId } : {}),
        ...(taskId ? { taskId } : {}),
      },
      ...(peer.a2aTenant ? { tenant: peer.a2aTenant } : {}),
      configuration: { returnImmediately: false },
    });
    let extracted = interpret(first);
    const deadline = Date.now() + deps.config.a2aBlockTimeoutMs;
    while (extracted.taskId && !isTerminal(extracted.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const polled = await call(deps, peer, 'GetTask', { id: extracted.taskId, ...(peer.a2aTenant ? { tenant: peer.a2aTenant } : {}) });
      const next = interpret(polled);
      if (next.state) extracted = { ...extracted, ...next, taskId: next.taskId ?? extracted.taskId };
    }
    const now = deps.now();
    const remoteTaskId = extracted.taskId ?? `remote_${randomBytes(8).toString('base64url')}`;
    deps.db.insertA2aTask({
      id: remoteTaskId,
      direction: 'outbound',
      botId: peer.id,
      contextId: extracted.contextId,
      threadId: message.threadId,
      relayMessageId: message.id,
      state: extracted.state || 'TASK_STATE_WORKING',
      remoteMessageId: message.id,
      requestText: message.body,
      responseText: extracted.text,
      history: [],
      createdAt: now,
    });
    deps.db.mergeMessageMetadata(message.id, {
      a2a_task_id: remoteTaskId,
      a2a_state: extracted.state || 'TASK_STATE_WORKING',
      ...(extracted.contextId ? { a2a_context_id: extracted.contextId } : {}),
      ...(extracted.text ? { a2a_response: extracted.text } : {}),
    });
    const failed = extracted.state === 'TASK_STATE_FAILED' || extracted.state === 'TASK_STATE_REJECTED';
    deps.db.finishMessage(message.id, failed ? 'failed' : 'delivered', failed ? extracted.text || extracted.state : null, failed ? null : now);
    if (extracted.text) await forwardReply(deps, peer, message, extracted.text, remoteTaskId, extracted.state);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'A2A call failed';
    deps.db.finishMessage(message.id, 'failed', reason.slice(0, 300), null);
  }
}

async function forwardReply(deps: Deps, peer: Bot, message: Message, text: string, taskId: string, state: string): Promise<void> {
  const body = text.length > deps.config.bodyMaxChars ? text.slice(0, deps.config.bodyMaxChars) : text;
  try {
    await sendMessage(
      deps,
      peer,
      {
        to: message.fromId,
        body,
        threadId: message.threadId,
        replyTo: message.id,
        metadata: { a2a_task_id: taskId, a2a_state: state },
      },
      null,
      { skipRateLimit: true },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'reply was not forwarded';
    deps.db.mergeMessageMetadata(message.id, { a2a_forward_error: reason.slice(0, 300) });
  }
}

async function call(deps: Deps, peer: Bot, method: string, params: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, application/a2a+json',
    'a2a-version': A2A_PROTOCOL_VERSION,
    'user-agent': 'bot-relay/0.1.0',
  };
  let url = peer.a2aEndpoint ?? '';
  if (peer.authHeaderName && peer.authHeaderValueEnc) {
    const value = decryptSecret(peer.authHeaderValueEnc, deps.config.relaySecret);
    if (peer.a2aAuthIn === 'query') {
      const parsed = new URL(url);
      parsed.searchParams.set(peer.authHeaderName, value);
      url = parsed.href;
    } else {
      headers[peer.authHeaderName] = value;
    }
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: randomBytes(8).toString('hex'), method, params }),
    redirect: 'error',
    signal: AbortSignal.timeout(deps.config.deliveryTimeoutMs),
  });
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`A2A agent returned non-JSON (HTTP ${response.status})`);
    }
  }
  if (isPlainObject(parsed) && parsed.error && typeof parsed.error === 'object') {
    const message = isPlainObject(parsed.error) && typeof parsed.error.message === 'string' ? parsed.error.message : 'A2A error';
    throw new Error(message);
  }
  if (!response.ok) throw new Error(`A2A agent returned HTTP ${response.status}`);
  if (!isPlainObject(parsed) || !('result' in parsed)) throw new Error('A2A agent returned no result');
  return parsed.result;
}

function interpret(result: unknown): { taskId: string | null; contextId: string | null; state: string; text: string | null } {
  const task = unwrapTask(result);
  if (task) {
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
    const artifactText = artifacts
      .map((artifact) => (isPlainObject(artifact) ? partsText(artifact.parts) : ''))
      .filter((text) => text.length > 0)
      .join('\n');
    const status = isPlainObject(task.status) ? task.status : {};
    const statusText = isPlainObject(status.message) ? partsText(status.message.parts) : '';
    const text = artifactText || statusText || null;
    return {
      taskId: typeof task.id === 'string' ? task.id : null,
      contextId: typeof task.contextId === 'string' ? task.contextId : null,
      state: typeof status.state === 'string' ? status.state : 'TASK_STATE_WORKING',
      text,
    };
  }
  const message = isPlainObject(result) && isPlainObject(result.message) ? result.message : isPlainObject(result) ? result : null;
  if (message && Array.isArray(message.parts)) {
    return {
      taskId: typeof message.taskId === 'string' ? message.taskId : null,
      contextId: typeof message.contextId === 'string' ? message.contextId : null,
      state: 'TASK_STATE_COMPLETED',
      text: partsText(message.parts) || null,
    };
  }
  throw new Error('A2A agent returned an unrecognized result');
}

function unwrapTask(result: unknown): Record<string, unknown> | null {
  if (!isPlainObject(result)) return null;
  if (isPlainObject(result.task)) return result.task;
  if (typeof result.id === 'string' && isPlainObject(result.status)) return result;
  return null;
}
