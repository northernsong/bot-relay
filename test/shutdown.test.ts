import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { stopBackgroundWork } from '../src/inquiry.js';
import {
  api,
  createInvite,
  expectStatus,
  login,
  makeApp,
  registerBot,
  startWebhook,
  until,
} from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

/** Two bots with a webhook that never answers, so delivery stays in flight. */
async function makeWorld(config: Partial<Config> = {}) {
  const { app, deps } = makeApp(config);
  const hook = await startWebhook({ hang: true });
  const session = await login(app);
  const alice = await registerBot(app, { id: 'alice', invite: (await createInvite(app, session)).code });
  const bob = await registerBot(app, {
    id: 'bob',
    invite: (await createInvite(app, session)).code,
    extra: { webhook_url: hook.url },
  });
  open.push({
    close: async () => {
      await hook.close();
      if (!deps.db.closed) deps.db.close();
    },
  });
  return { app, deps, alice, bob };
}

function startInquiry(app: ReturnType<typeof makeApp>['app'], token: string) {
  return api(app, '/v1/inquiries', { token, body: { to: 'bob' } });
}

describe('shutdown handoff (F5)', () => {
  it('stops the sweeper, then drains an in-flight delivery before the DB closes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const world = await makeWorld();
      const stop = vi.spyOn(world.deps.sweeper!, 'stop');
      const created = expectStatus(await startInquiry(world.app, world.alice), 202);
      const id = created.inquiry.id as string;

      await until(() => (world.deps.inflight?.size ?? 0) === 1);
      await stopBackgroundWork(world.deps, 2000);

      expect(stop).toHaveBeenCalledOnce();
      expect(world.deps.db.closed).toBe(false);
      expect(world.deps.inflight?.size ?? 0).toBe(0);
      // The drain waited for the delivery to settle while the DB was open.
      expect(world.deps.db.getInquiry(id)?.status).toBe('undelivered');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('stays silent when the database closes while a delivery is in flight', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const world = await makeWorld();
      expectStatus(await startInquiry(world.app, world.alice), 202);
      await until(() => (world.deps.inflight?.size ?? 0) === 1);

      world.deps.db.close();
      // Let the delivery hit its timeout and run its catch path against a
      // closed handle; it must not log inquiry_delivery_failed /
      // "database is not open".
      await until(() => (world.deps.inflight?.size ?? 0) === 0);

      expect(errors).not.toHaveBeenCalled();
      const logged = errors.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(logged).not.toContain('inquiry_delivery_failed');
      expect(logged).not.toContain('database is not open');
    } finally {
      errors.mockRestore();
    }
  });
});
