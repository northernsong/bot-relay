import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { ADMIN, api, expectStatus, makeApp } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

function rpc(
  app: Parameters<typeof api>[0],
  botId: string,
  token: string,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
) {
  return api(app, `/a2a/bots/${botId}`, {
    body: { jsonrpc: '2.0', id: 'rpc-1', method, params },
    headers: { authorization: `Bearer ${token}`, 'a2a-version': '1.0', ...headers },
  });
}

describe('inbound A2A', () => {
  it('publishes an Agent Card and turns SendMessage plus a relay reply into a completed task', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const alice = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'alice', display_name: 'Alice' } }),
      201,
    );
    expect(alice.a2a_token).toMatch(/^a2a_/);
    expect(alice.accept_a2a).toBe(true);

    const card = expectStatus(await api(app, '/a2a/bots/alice/.well-known/agent-card.json'), 200);
    expect(card.supportedInterfaces[0].protocolBinding).toBe('JSONRPC');
    expect(card.supportedInterfaces[0].protocolVersion).toBe('1.0');
    expect(card.supportedInterfaces[0].url).toContain('/a2a/bots/alice');
    expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe('Bearer');
    expect(card.capabilities.streaming).toBe(true);
    expect(JSON.stringify(card)).not.toContain(alice.a2a_token);

    const missingVersion = await rpc(app, 'alice', alice.a2a_token, 'SendMessage', sendParams('hi'), { 'a2a-version': '' });
    expect(missingVersion.json.error.code).toBe(-32009);

    const unauth = await api(app, '/a2a/bots/alice', {
      body: { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: sendParams('hi') },
      headers: { 'a2a-version': '1.0' },
    });
    expect(unauth.status).toBe(401);

    const accepted = expectStatus(
      await rpc(app, 'alice', alice.a2a_token, 'message/send', {
        ...sendParams('hello from a2a'),
        configuration: { returnImmediately: true },
      }),
      200,
    );
    expect(accepted.result.task.status.state).toBe('TASK_STATE_WORKING');
    const inbox = expectStatus(await api(app, '/inbox', { token: alice.token }), 200);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].from).toBe('a2a');
    expect(inbox.messages[0].body).toBe('hello from a2a');

    expectStatus(
      await api(app, '/messages', {
        token: alice.token,
        body: {
          to: 'a2a',
          body: 'hello back',
          thread_id: inbox.messages[0].thread_id,
          reply_to: inbox.messages[0].id,
        },
      }),
      202,
    );
    const fetched = expectStatus(
      await rpc(app, 'alice', alice.a2a_token, 'tasks/get', { id: accepted.result.task.id }),
      200,
    );
    expect(fetched.result.status.state).toBe('TASK_STATE_COMPLETED');
    expect(fetched.result.artifacts[0].parts[0].text).toBe('hello back');
    expect(fetched.result.history.map((entry: { role: string }) => entry.role)).toEqual(['ROLE_USER', 'ROLE_AGENT']);
    const canceled = await rpc(app, 'alice', alice.a2a_token, 'CancelTask', { id: accepted.result.task.id });
    expect(canceled.json.error.code).toBe(-32002);

    const replay = expectStatus(
      await rpc(app, 'alice', alice.a2a_token, 'SendMessage', {
        ...sendParams('hello from a2a'),
        configuration: { returnImmediately: true },
      }),
      200,
    );
    expect(replay.result.task.id).toBe(accepted.result.task.id);
    const inboxAfter = expectStatus(await api(app, '/inbox', { token: alice.token }), 200);
    expect(inboxAfter.messages.filter((message: { from: string }) => message.from === 'a2a')).toHaveLength(1);
  });

  it('blocks until the webhook reply and streams the completed task', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const hook = await startReplyingWebhook(app);
    open.push(hook);
    const alice = expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: { id: 'alice', display_name: 'Alice', webhook_url: hook.url },
      }),
      201,
    );
    hook.setToken(alice.token);

    const blocked = expectStatus(
      await rpc(app, 'alice', alice.a2a_token, 'SendMessage', sendParams('ping', 'msg-block')),
      200,
    );
    expect(blocked.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(blocked.result.task.artifacts[0].parts[0].text).toBe('pong');
    expect(hook.hits).toHaveLength(1);
    expect(hook.hits[0]?.from).toBe('a2a');

    const streamed = await api(app, '/a2a/bots/alice', {
      body: { jsonrpc: '2.0', id: 'stream-1', method: 'message/stream', params: sendParams('ping', 'msg-stream') },
      headers: { authorization: `Bearer ${alice.a2a_token}`, 'a2a-version': '1.0' },
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toContain('text/event-stream');
    expect(streamed.text).toContain('TASK_STATE_COMPLETED');
    expect(streamed.text).toContain('pong');
    expect(hook.hits).toHaveLength(2);
  });

  it('keeps allowlists, rejects non-text parts, and rate limits callers', async () => {
    const { app, deps } = makeApp({ rateLimitMax: 1 });
    open.push({ close: () => deps.db.close() });
    const alice = expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: { id: 'alice', display_name: 'Alice', allowlist: ['bob'] },
      }),
      201,
    );
    const denied = await rpc(app, 'alice', alice.a2a_token, 'SendMessage', sendParams('nope', 'msg-deny'));
    expect(denied.json.error.code).toBe(-32004);
    const inbox = expectStatus(await api(app, '/inbox', { token: alice.token }), 200);
    expect(inbox.messages).toEqual([]);

    expectStatus(
      await api(app, '/bots/me', { method: 'PATCH', token: alice.token, body: { allowlist: null } }),
      200,
    );
    const file = await rpc(app, 'alice', alice.a2a_token, 'SendMessage', {
      message: {
        role: 'ROLE_USER',
        messageId: 'msg-file',
        parts: [{ raw: 'aGVsbG8=', mediaType: 'application/pdf' }],
      },
    });
    expect(file.json.error.code).toBe(-32005);

    expectStatus(
      await rpc(app, 'alice', alice.a2a_token, 'SendMessage', {
        ...sendParams('one', 'msg-one'),
        configuration: { returnImmediately: true },
      }),
      200,
    );
    const limited = await rpc(app, 'alice', alice.a2a_token, 'SendMessage', {
      ...sendParams('two', 'msg-two'),
      configuration: { returnImmediately: true },
    });
    expect(limited.status).toBe(429);
    expect(limited.json.error.message).toMatch(/Too many messages/);
  });
});

describe('outbound A2A', () => {
  it('registers an Agent Card and forwards the task result to the sender', async () => {
    const remote = await startRemoteAgent();
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() }, remote);
    const alice = expectStatus(
      await api(app, '/bots', { token: ADMIN, body: { id: 'alice', display_name: 'Alice' } }),
      201,
    );
    const weather = expectStatus(
      await api(app, '/bots', {
        token: ADMIN,
        body: {
          id: 'weather',
          display_name: 'Weather',
          a2a_card_url: `${remote.url}/.well-known/agent-card.json`,
          auth_header_name: 'Authorization',
          auth_header_value: 'Bearer let-me-in',
        },
      }),
      201,
    );
    expect(weather.kind).toBe('a2a');
    expect(weather.a2a_token).toBeUndefined();
    expectStatus(await api(app, '/a2a/bots/weather/.well-known/agent-card.json'), 404);

    const sent = expectStatus(
      await api(app, '/messages', { token: alice.token, body: { to: 'weather', body: 'forecast please' } }),
      202,
    );
    expect(sent.status).toBe('delivered');
    expect(sent.metadata.a2a_state).toBe('TASK_STATE_COMPLETED');
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]?.authorization).toBe('Bearer let-me-in');
    expect(remote.calls[0]?.version).toBe('1.0');
    expect(remote.calls[0]?.method).toBe('SendMessage');
    expect(remote.calls[0]?.text).toBe('forecast please');

    const inbox = expectStatus(await api(app, '/inbox', { token: alice.token }), 200);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].from).toBe('weather');
    expect(inbox.messages[0].body).toBe('sunny');
    expect(inbox.messages[0].hop).toBe(2);
    expect(inbox.messages[0].reply_to).toBe(sent.id);
  });

  it('rejects agent cards whose only auth scheme is unsupported', async () => {
    const remote = await startRemoteAgent({ scheme: 'oauth' });
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() }, remote);
    const denied = await api(app, '/bots', {
      token: ADMIN,
      body: {
        id: 'oauth-agent',
        display_name: 'OAuth agent',
        a2a_card_url: `${remote.url}/.well-known/agent-card.json`,
        auth_header_name: 'Authorization',
        auth_header_value: 'Bearer token',
      },
    });
    expectStatus(denied, 400);
    expect(denied.json.error.code).toBe('unsupported_auth_scheme');
  });
});

function sendParams(text: string, messageId = 'msg-hello') {
  return {
    message: {
      role: 'ROLE_USER',
      messageId,
      parts: [{ text, mediaType: 'text/plain' }],
    },
  };
}

async function startReplyingWebhook(app: Parameters<typeof api>[0]) {
  let token = '';
  const hits: Array<{ from?: string; id?: string; thread_id?: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { from?: string; id?: string; thread_id?: string };
        hits.push(body);
        await app.request('/messages', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'a2a', body: 'pong', thread_id: body.thread_id, reply_to: body.id }),
        });
        res.writeHead(200);
        res.end('ok');
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    hits,
    setToken(value: string) {
      token = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

async function startRemoteAgent(opts?: { scheme?: 'bearer' | 'oauth' }) {
  const calls: Array<{ authorization?: string; version?: string; method?: string; text?: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET') {
        const port = (server.address() as { port: number }).port;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(agentCard(`http://127.0.0.1:${port}/rpc`, opts?.scheme ?? 'bearer')));
        return;
      }
      const body = JSON.parse(raw) as { method?: string; params?: { message?: { parts?: Array<{ text?: string }> } } };
      calls.push({
        authorization: req.headers.authorization,
        version: req.headers['a2a-version'] as string | undefined,
        method: body.method,
        text: body.params?.message?.parts?.[0]?.text,
      });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            task: {
              id: 'task-weather',
              contextId: 'ctx-weather',
              status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-11-12T00:00:00.000Z' },
              artifacts: [{ artifactId: 'art-1', parts: [{ text: 'sunny' }] }],
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function agentCard(rpcUrl: string, scheme: 'bearer' | 'oauth') {
  const securitySchemes =
    scheme === 'oauth'
      ? { oauth: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: 'https://example.com/token' } } } } }
      : { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } };
  const securityRequirements =
    scheme === 'oauth' ? [{ schemes: { oauth: { list: [] } } }] : [{ schemes: { bearer: { list: [] } } }];
  return {
    name: 'Weather',
    description: 'Forecasts',
    supportedInterfaces: [{ url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    version: '1.0.0',
    capabilities: { streaming: false },
    securitySchemes,
    securityRequirements,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'forecast', name: 'Forecast', description: 'Weather', tags: ['weather'] }],
  };
}
