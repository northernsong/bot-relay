import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { api, createInvite, expectStatus, login, makeApp, registerBot } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

const DIRECTORY_FIELDS = ['capabilities', 'display_name', 'id', 'status', 'updated_at'];

async function newBot(app: Hono, id: string, extra: Record<string, unknown> = {}): Promise<string> {
  const session = await login(app);
  const invite = await createInvite(app, session);
  return registerBot(app, { id, invite: invite.code, extra });
}

describe('directory', () => {
  it('lists every bot with basic info only — never any contact details', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const alice = await newBot(app, 'alice', {
      capabilities: 'weather reports',
      webhook_auth_name: 'Authorization',
      webhook_auth_value: 'Bearer alice-secret',
    });
    await newBot(app, 'bob', { webhook_url: 'http://127.0.0.1:9/hook/secret-path' });
    const session = await login(app);
    expectStatus(await api(app, '/admin/api/bots/bob/disable', { method: 'POST', headers: session.headers }), 200);

    expectStatus(await api(app, '/v1/directory'), 401);
    const list = expectStatus(await api(app, '/v1/directory', { token: alice }), 200);
    expect(list.bots).toHaveLength(2);
    for (const entry of list.bots) {
      expect(Object.keys(entry).sort()).toEqual(DIRECTORY_FIELDS);
    }
    const byId = new Map<string, any>(list.bots.map((bot: { id: string }) => [bot.id, bot]));
    expect(byId.get('alice')).toMatchObject({ id: 'alice', display_name: 'alice', capabilities: 'weather reports', status: 'active' });
    expect(byId.get('bob')?.status).toBe('disabled');
    expect(byId.get('bob')?.updated_at).toBeTruthy();

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain('webhook');
    expect(serialized).not.toContain('alice-secret');
    expect(serialized).not.toContain('secret-path');
    expect(serialized).not.toContain('intake');
  });

  it('fetches a single entry and 404s for unknown ids', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const alice = await newBot(app, 'alice');

    const single = await api(app, '/v1/directory/bob', { token: alice });
    expectStatus(single, 404);
    await newBot(app, 'bob');
    const found = expectStatus(await api(app, '/v1/directory/bob', { token: alice }), 200);
    expect(Object.keys(found.bot).sort()).toEqual(DIRECTORY_FIELDS);
    expect(found.bot.id).toBe('bob');
    expect(single.json.error.code).toBe('not_found');
  });

  it('refuses disabled callers (P0-4⑥)', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const alice = await newBot(app, 'alice');
    const session = await login(app);
    expectStatus(await api(app, '/admin/api/bots/alice/disable', { method: 'POST', headers: session.headers }), 200);

    const blocked = await api(app, '/v1/directory', { token: alice });
    expectStatus(blocked, 403);
    expect(blocked.json.error.code).toBe('bot_disabled');
    expectStatus(await api(app, '/v1/directory/bob', { token: alice }), 403);
  });
});
