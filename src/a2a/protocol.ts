import type { A2aTask } from '../types.js';
import { isPlainObject } from '../validate.js';
import { RPC, isTerminal } from './constants.js';

export type RpcId = string | number | null;

export class RpcError extends Error {
  readonly rpcCode: number;
  readonly httpStatus: number;
  readonly data?: unknown;

  constructor(rpcCode: number, message: string, httpStatus = 200, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.rpcCode = rpcCode;
    this.httpStatus = httpStatus;
    this.data = data;
  }
}

export function rpcResult(id: RpcId, result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function rpcError(id: RpcId, error: RpcError): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code: error.rpcCode,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    }),
    { status: error.httpStatus, headers: { 'content-type': 'application/json' } },
  );
}

export function acceptsVersion(header: string | undefined): boolean {
  const raw = (header ?? '').trim();
  if (raw === '') return false;
  const [major, minor] = raw.split('.');
  return major === '1' && minor === '0';
}

export function readTextMessage(message: unknown, maxChars: number): { messageId: string; text: string; taskId: string | null; contextId: string | null } {
  if (!isPlainObject(message)) throw new RpcError(RPC.invalidParams, 'message must be an object');
  if (message.role !== 'ROLE_USER') throw new RpcError(RPC.invalidParams, 'message.role must be ROLE_USER');
  if (typeof message.messageId !== 'string' || message.messageId.length < 1 || message.messageId.length > 200) {
    throw new RpcError(RPC.invalidParams, 'message.messageId must be 1-200 characters');
  }
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new RpcError(RPC.invalidParams, 'message.parts must contain at least one part');
  }
  const texts: string[] = [];
  for (const part of message.parts) texts.push(readTextPart(part));
  const text = texts.join('\n');
  if (text.length > maxChars) throw new RpcError(RPC.invalidParams, `message text exceeds ${maxChars} characters`);
  const taskId = optionalId(message.taskId, 'taskId');
  const contextId = optionalId(message.contextId, 'contextId');
  return { messageId: message.messageId, text, taskId, contextId };
}

function readTextPart(part: unknown): string {
  if (!isPlainObject(part)) throw new RpcError(RPC.invalidParams, 'each part must be an object');
  const contentKeys = ['text', 'raw', 'url', 'data'].filter((key) => part[key] !== undefined);
  if (contentKeys.length !== 1) throw new RpcError(RPC.invalidParams, 'each part must contain exactly one of text, raw, url, or data');
  if (contentKeys[0] !== 'text') {
    throw new RpcError(RPC.contentType, 'Only text parts are supported', 200, [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'CONTENT_TYPE_NOT_SUPPORTED', domain: 'a2a-protocol.org' },
    ]);
  }
  if (typeof part.text !== 'string' || part.text.trim().length === 0) {
    throw new RpcError(RPC.invalidParams, 'text parts must be non-empty strings');
  }
  if (part.mediaType !== undefined) {
    if (typeof part.mediaType !== 'string' || !part.mediaType.toLowerCase().startsWith('text/')) {
      throw new RpcError(RPC.contentType, `Unsupported media type ${String(part.mediaType)}`);
    }
  }
  return part.text;
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new RpcError(RPC.invalidParams, `${field} must be a string`);
  }
  return value;
}

export function readSendConfig(params: Record<string, unknown>): { returnImmediately: boolean; historyLength: number | undefined } {
  const configuration = params.configuration;
  if (configuration === undefined || configuration === null) return { returnImmediately: false, historyLength: undefined };
  if (!isPlainObject(configuration)) throw new RpcError(RPC.invalidParams, 'configuration must be an object');
  let returnImmediately = false;
  if (configuration.returnImmediately !== undefined) {
    if (typeof configuration.returnImmediately !== 'boolean') {
      throw new RpcError(RPC.invalidParams, 'configuration.returnImmediately must be a boolean');
    }
    returnImmediately = configuration.returnImmediately;
  }
  return { returnImmediately, historyLength: readHistoryLength(configuration.historyLength) };
}

export function readHistoryLength(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new RpcError(RPC.invalidParams, 'historyLength must be an integer from 0 to 100');
  }
  return value;
}

export function taskObject(task: A2aTask, historyLength: number | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: task.id,
    contextId: task.contextId,
    status: {
      state: task.state,
      timestamp: new Date(task.updatedAt).toISOString(),
      ...(task.responseText && isTerminal(task.state)
        ? { message: agentMessage(task, task.responseText) }
        : {}),
    },
  };
  if (task.responseText && task.state === 'TASK_STATE_COMPLETED') {
    body.artifacts = [
      {
        artifactId: `${task.id}-reply`,
        name: 'reply',
        parts: [{ text: task.responseText, mediaType: 'text/plain' }],
      },
    ];
  }
  if (historyLength !== 0) {
    const history = historyLength === undefined ? task.history : task.history.slice(-historyLength);
    if (history.length > 0) body.history = history;
  }
  return body;
}

export function userMessage(task: { id: string; contextId: string | null }, messageId: string, text: string): Record<string, unknown> {
  return {
    messageId,
    contextId: task.contextId,
    taskId: task.id,
    role: 'ROLE_USER',
    parts: [{ text, mediaType: 'text/plain' }],
  };
}

export function agentMessage(task: { id: string; contextId: string | null }, text: string): Record<string, unknown> {
  return {
    messageId: `${task.id}-reply`,
    contextId: task.contextId,
    taskId: task.id,
    role: 'ROLE_AGENT',
    parts: [{ text, mediaType: 'text/plain' }],
  };
}

export function partsText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const bits: string[] = [];
  for (const part of value) {
    if (isPlainObject(part) && typeof part.text === 'string' && part.text.length > 0) bits.push(part.text);
  }
  return bits.join('\n');
}
