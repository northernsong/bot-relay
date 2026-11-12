import { timingSafeEqual } from 'node:crypto';

import type { Hono } from 'hono';
import type { Context } from 'hono';

import type { Deps } from '../deps.js';
import { hashToken } from '../secret.js';
import { buildAgentCard } from './card.js';
import { A2A_PROTOCOL_VERSION, RPC } from './constants.js';
import { cancelTask, getTask, sendToBot, taskResult } from './inbound.js';
import { RpcError, acceptsVersion, rpcError, rpcResult, type RpcId } from './protocol.js';

const METHODS: Record<string, 'send' | 'stream' | 'get' | 'cancel' | 'subscribe' | 'extended' | 'push'> = {
  SendMessage: 'send',
  'message/send': 'send',
  SendStreamingMessage: 'stream',
  'message/stream': 'stream',
  GetTask: 'get',
  'tasks/get': 'get',
  CancelTask: 'cancel',
  'tasks/cancel': 'cancel',
  SubscribeToTask: 'subscribe',
  'tasks/resubscribe': 'subscribe',
  GetExtendedAgentCard: 'extended',
  CreateTaskPushNotificationConfig: 'push',
  GetTaskPushNotificationConfig: 'push',
  ListTaskPushNotificationConfigs: 'push',
  DeleteTaskPushNotificationConfig: 'push',
};

export function registerA2aRoutes(app: Hono, deps: Deps): void {
  app.get('/a2a/bots/:id/.well-known/agent-card.json', (c) => {
    const bot = hostedBot(deps, c.req.param('id'));
    if (!bot) return c.json({ error: { code: 'not_found', message: 'Bot not found' } }, 404);
    return c.json(buildAgentCard(bot, publicBase(deps, c)), 200, { 'cache-control': 'public, max-age=60' });
  });

  app.post('/a2a/bots/:id', async (c) => {
    const bot = hostedBot(deps, c.req.param('id'));
    if (!bot) return rpcError(null, new RpcError(RPC.taskNotFound, 'Bot not found', 404));
    let body: unknown;
    try {
      body = await readRpcBody(c);
    } catch (err) {
      return rpcError(null, err instanceof RpcError ? err : new RpcError(RPC.parse, 'Invalid JSON payload', 400));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return rpcError(null, new RpcError(RPC.invalidRequest, 'Request payload validation error', 400));
    }
    const request = body as Record<string, unknown>;
    const id = rpcId(request.id);
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return rpcError(id, new RpcError(RPC.invalidRequest, 'Request payload validation error', 400));
    }
    if (!acceptsVersion(c.req.header('a2a-version'))) {
      return rpcError(
        id,
        new RpcError(RPC.version, 'A2A-Version 1.0 is required. A missing header is treated as 0.3.', 200, {
          supportedVersions: [A2A_PROTOCOL_VERSION],
        }),
      );
    }
    if (!authorized(c.req.header('authorization'), bot.a2aInboundTokenHash)) {
      return rpcError(id, new RpcError(RPC.unauthenticated, 'Bearer a2a_token required', 401));
    }
    const method = METHODS[request.method];
    try {
      if (method === 'push') throw new RpcError(RPC.pushNotSupported, 'Push notifications are not supported');
      if (method === 'extended') throw new RpcError(RPC.unsupported, 'Extended agent cards are not supported');
      if (!method) throw new RpcError(RPC.methodNotFound, 'Method not found');
      if (method === 'get') {
        const found = await getTask(deps, bot, request.params);
        return rpcResult(id, taskResult(found.task, found.historyLength));
      }
      if (method === 'cancel') return rpcResult(id, taskResult(await cancelTask(deps, bot, request.params), undefined));
      if (method === 'subscribe') {
        const found = await getTask(deps, bot, request.params);
        if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(found.task.state)) {
          throw new RpcError(RPC.unsupported, 'Task is in a terminal state');
        }
        return sse(id, deps, found.task.id, found.historyLength);
      }
      const sent = await sendToBot(deps, bot, request.params, { stream: method === 'stream' });
      if (method === 'stream') return sse(id, deps, sent.task.id, sent.historyLength);
      return rpcResult(id, { task: taskResult(sent.task, sent.historyLength) });
    } catch (err) {
      const rpc = err instanceof RpcError ? err : new RpcError(RPC.internal, 'Internal error');
      return rpcError(id, rpc);
    }
  });
}

function hostedBot(deps: Deps, id: string) {
  const bot = deps.db.getBot(id);
  if (!bot || bot.kind !== 'relay' || !bot.acceptA2a || !bot.a2aInboundTokenHash) return undefined;
  return bot;
}

function authorized(header: string | undefined, storedHash: string | null): boolean {
  if (!header || !storedHash) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const actual = Buffer.from(hashToken(match[1]));
  const expected = Buffer.from(storedHash);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function rpcId(value: unknown): RpcId {
  if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
  return null;
}

async function readRpcBody(c: Context): Promise<unknown> {
  const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && contentType !== 'application/a2a+json') {
    throw new RpcError(RPC.invalidRequest, 'Content-Type must be application/json or application/a2a+json', 415);
  }
  const raw = await c.req.text();
  if (raw.length > 65_536) throw new RpcError(RPC.invalidRequest, 'Request body is too large', 413);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RpcError(RPC.parse, 'Invalid JSON payload', 400);
  }
}

function publicBase(deps: Deps, c: Context): string {
  if (deps.config.publicBaseUrl) return deps.config.publicBaseUrl;
  return new URL(c.req.url).origin;
}

function sse(id: RpcId, deps: Deps, taskId: string, historyLength: number | undefined): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (result: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`));
      };
      const started = Date.now();
      let last = '';
      for (;;) {
        const task = deps.db.getA2aTask(taskId);
        if (!task) break;
        const view = taskResult(task, historyLength);
        const serialized = JSON.stringify(view);
        if (serialized !== last) {
          send({ task: view });
          last = serialized;
        }
        const terminal = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(task.state);
        if (terminal || Date.now() - started >= deps.config.a2aBlockTimeoutMs) break;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
