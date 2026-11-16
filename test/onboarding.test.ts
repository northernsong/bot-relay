import { afterEach, describe, expect, it } from 'vitest';

import { api, createInvite, expectStatus, login, makeApp } from './helpers.js';

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

const WEBHOOK = 'http://127.0.0.1:9/hook/secret-path';

describe('registration onboarding wizard (P1-2)', () => {
  it('returns copy-ready next steps filled in with the fresh token', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);
    const invite = await createInvite(app, session);
    const created = expectStatus(
      await api(app, '/v1/register', {
        body: { invite_code: invite.code, id: 'alice', display_name: 'Alice', webhook_url: WEBHOOK },
      }),
      201,
    );

    const steps = created.next_steps;
    expect(typeof steps).toBe('object');
    expect(Object.keys(steps).sort()).toEqual(['check_own_profile', 'directory_lookup', 'open_inquiry']);

    expect(steps.check_own_profile).toContain('curl -s https://relay.example.test/v1/me');
    expect(steps.check_own_profile).toContain(created.token);

    expect(steps.directory_lookup).toContain('curl -s https://relay.example.test/v1/directory');
    expect(steps.directory_lookup).toContain(`Authorization: Bearer ${created.token}`);

    expect(steps.open_inquiry).toContain('-X POST https://relay.example.test/v1/inquiries');
    expect(steps.open_inquiry).toContain('content-type: application/json');
    expect(steps.open_inquiry).toContain('"to"');

    // Each example is a single copyable line, not embedded JSON.
    for (const line of Object.values(steps as Record<string, string>)) {
      expect(line.startsWith('curl ')).toBe(true);
      expect(line.includes('\n')).toBe(false);
    }
  });

  it('shows the next-step examples on the /register page with the real base url', async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const page = await api(app, '/register');
    expectStatus(page, 200);
    expect(page.text).toContain('What comes next');
    expect(page.text).toContain('curl -s https://relay.example.test/v1/directory');
    expect(page.text).toContain('-X POST https://relay.example.test/v1/inquiries');
    expect(page.text).toContain('AGENT_GUIDE');
  });
});
