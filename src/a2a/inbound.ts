import { randomBytes } from 'node:crypto';

import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { newThreadId } from '../ids.js';
import { sendMessage } from '../send.js';
import type { A2aTask, Bot } from '../types.js';
import { isPlainObject } from '../validate.js';
import { A2A_GATEWAY_ID, RPC, isTerminal } from './constants.js';
import { RpcError, readHistoryLength, readSendConfig, readTextMessage, taskObject, userMessage } from './protocol.js';

export async function sendToBot(
  deps: Deps,
  bot: Bot,
  params: unknown,
  opts: { stream: boolean },
): Promise<{ task: A2aTask; historyLength: number | undefined }> {
  if (bot.disabled) throw new RpcError(RPC.unsupported, 'This bot is disabled');
  if (!isPlainObject(params)) throw new RpcError(RPC.invalidParams, 'params must be an object');
  if (params.tenant !== undefined) throw new RpcError(RPC.invalidParams, 'This agent has no tenant');
  const parsed = readTextMessage(params.message, deps.config.bodyMaxChars);
  const config = readSendConfig(params);
  const existing = deps.db.getA2aTaskByRemote(bot.id, 'inbound', parsed.messageId);
  if (existing) {
    return { task: await maybeWait(deps, existing, config.returnImmediately || opts.stream), historyLength: config.historyLength };
  }

  if (bot.allowlist && !bot.allowlist.includes(A2A_GATEWAY_ID)) {
    throw new RpcError(RPC.unsupported, 'Recipient allowlist does not include a2a');
  }
  const rate = deps.db.consumeRate(
    `a2a:${bot.id}`,
    deps.now(),
    deps.config.rateLimitWindowSec * 1000,
    deps.config.rateLimitMax,
  );
  if (!rate.allowed) {
    throw new RpcError(
      RPC.unauthenticated,
      `Too many messages. Limit is ${deps.config.rateLimitMax} per ${deps.config.rateLimitWindowSec}s.`,
      429,
    );
  }

  const continued = parsed.taskId ? deps.db.getA2aTask(parsed.taskId) : undefined;
  if (parsed.taskId) {
    if (!continued || continued.direction !== 'inbound' || continued.botId !== bot.id) {
      throw new RpcError(RPC.taskNotFound, 'Task not found');
    }
    if (isTerminal(continued.state)) throw new RpcError(RPC.unsupported, 'Task is in a terminal state');
    if (parsed.contextId && parsed.contextId !== continued.contextId) {
      throw new RpcError(RPC.invalidParams, 'contextId does not match the task');
    }
  }
  const contextId = continued?.contextId ?? parsed.contextId ?? newThreadId();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(contextId)) {
    throw new RpcError(RPC.invalidParams, 'contextId is not an acceptable thread id');
  }

  const now = deps.now();
  const taskId = `task_${randomBytes(16).toString('base64url')}`;
  const history = [...(continued?.history ?? []), userMessage({ id: taskId, contextId }, parsed.messageId, parsed.text)];
  try {
    deps.db.insertA2aTask({
      id: taskId,
      direction: 'inbound',
      botId: bot.id,
      contextId,
      threadId: contextId,
      relayMessageId: continued?.relayMessageId ?? null,
      state: 'TASK_STATE_SUBMITTED',
      remoteMessageId: parsed.messageId,
      requestText: parsed.text,
      responseText: null,
      history,
      createdAt: now,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('a2a_tasks')) {
      const raced = deps.db.getA2aTaskByRemote(bot.id, 'inbound', parsed.messageId);
      if (raced) return { task: raced, historyLength: config.historyLength };
    }
    throw err;
  }

  const gateway = deps.db.getBot(A2A_GATEWAY_ID);
  if (!gateway) throw new RpcError(RPC.internal, 'A2A gateway is not available');
  let relayId = '';
  try {
    const sent = await sendMessage(
      deps,
      gateway,
      {
        to: bot.id,
        body: parsed.text,
        threadId: contextId,
        replyTo: continued?.relayMessageId ?? null,
        metadata: { a2a: { taskId, contextId, messageId: parsed.messageId } },
      },
      null,
      { skipRateLimit: true },
    );
    relayId = sent.message.id;
  } catch (err) {
    deps.db.setA2aState(taskId, 'TASK_STATE_FAILED', deps.now());
    throw mapSendError(err);
  }
  deps.db.linkA2aRelayMessage(taskId, relayId, deps.now());
  const task = await maybeWait(deps, deps.db.getA2aTask(taskId) ?? fallbackTask(taskId), config.returnImmediately || opts.stream);
  return { task, historyLength: config.historyLength };
}

export async function getTask(deps: Deps, bot: Bot, params: unknown): Promise<{ task: A2aTask; historyLength: number | undefined }> {
  if (!isPlainObject(params) || typeof params.id !== 'string' || params.id.length === 0) {
    throw new RpcError(RPC.invalidParams, 'id is required');
  }
  const task = deps.db.getA2aTask(params.id);
  if (!task || task.direction !== 'inbound' || task.botId !== bot.id) throw new RpcError(RPC.taskNotFound, 'Task not found');
  return { task, historyLength: readHistoryLength(params.historyLength) };
}

export async function cancelTask(deps: Deps, bot: Bot, params: unknown): Promise<A2aTask> {
  const { task } = await getTask(deps, bot, params);
  if (isTerminal(task.state)) throw new RpcError(RPC.taskNotCancelable, 'Task cannot be canceled');
  deps.db.setA2aState(task.id, 'TASK_STATE_CANCELED', deps.now());
  return deps.db.getA2aTask(task.id) ?? task;
}

export function taskResult(task: A2aTask, historyLength: number | undefined): Record<string, unknown> {
  return taskObject(task, historyLength);
}

async function maybeWait(deps: Deps, task: A2aTask, skipWait: boolean): Promise<A2aTask> {
  if (skipWait || isTerminal(task.state)) return deps.db.getA2aTask(task.id) ?? task;
  const started = Date.now();
  let current = task;
  while (!isTerminal(current.state) && Date.now() - started < deps.config.a2aBlockTimeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    current = deps.db.getA2aTask(task.id) ?? current;
  }
  return current;
}

function mapSendError(err: unknown): RpcError {
  if (err instanceof RpcError) return err;
  if (err instanceof HttpError) {
    if (err.status === 403 || err.status === 409) return new RpcError(RPC.unsupported, err.message);
    if (err.status === 404) return new RpcError(RPC.taskNotFound, err.message);
    if (err.status === 429) return new RpcError(RPC.unauthenticated, err.message, 429);
    return new RpcError(RPC.invalidParams, err.message);
  }
  return new RpcError(RPC.internal, 'Internal error');
}

function fallbackTask(id: string): A2aTask {
  return {
    id,
    direction: 'inbound',
    botId: '',
    contextId: null,
    threadId: '',
    relayMessageId: null,
    state: 'TASK_STATE_WORKING',
    remoteMessageId: null,
    requestText: '',
    responseText: null,
    history: [],
    createdAt: 0,
    updatedAt: 0,
  };
}
