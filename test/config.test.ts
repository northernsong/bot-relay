import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('requires the admin token and relay secret', () => {
    expect(() => loadConfig({})).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ADMIN_TOKEN: 'short', RELAY_SECRET: '0123456789abcdef' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ADMIN_TOKEN: '12345678', RELAY_SECRET: 'too-short' })).toThrow(/RELAY_SECRET/);
    expect(() => loadConfig({ ADMIN_TOKEN: '12345678 ', RELAY_SECRET: '0123456789abcdef' })).toThrow(/whitespace/);
  });

  it('applies defaults and parses overrides', () => {
    const config = loadConfig({
      ADMIN_TOKEN: '12345678',
      RELAY_SECRET: '0123456789abcdef',
      ALLOW_HTTP_WEBHOOKS: 'yes',
      ALLOW_PRIVATE_WEBHOOKS: '0',
      MAX_HOPS: '3',
    });
    expect(config.port).toBe(8080);
    expect(config.databasePath).toBe('./data/bot-relay.sqlite');
    expect(config.maxHops).toBe(3);
    expect(config.allowHttpWebhooks).toBe(true);
    expect(config.allowPrivateWebhooks).toBe(false);
    expect(config.rateLimitMax).toBe(60);
  });
});
