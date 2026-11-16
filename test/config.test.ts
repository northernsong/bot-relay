import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const BASE = {
  ADMIN_TOKEN: '12345678',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
  PUBLIC_BASE_URL: 'https://relay.example.test',
};

describe('loadConfig', () => {
  it('requires the admin token, encryption key, and public base url', () => {
    expect(() => loadConfig({})).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ADMIN_TOKEN: '12345678' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...BASE, ENCRYPTION_KEY: 'too-short-for-aes-key' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ADMIN_TOKEN: '12345678', ENCRYPTION_KEY: BASE.ENCRYPTION_KEY })).toThrow(
      /PUBLIC_BASE_URL/,
    );
    expect(() => loadConfig({ ...BASE, ADMIN_TOKEN: '12345678 ' })).toThrow(/whitespace/);
    expect(() => loadConfig({ ...BASE, PUBLIC_BASE_URL: 'relay.example.test' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig({ ...BASE, PUBLIC_BASE_URL: 'ftp://relay.example.test' })).toThrow(/PUBLIC_BASE_URL/);
  });

  it('applies defaults', () => {
    const config = loadConfig(BASE);
    expect(config.port).toBe(8080);
    expect(config.host).toBe('127.0.0.1');
    expect(config.databasePath).toBe('./data/bot-relay.sqlite');
    expect(config.trustedProxies).toEqual(['127.0.0.1/32', '::1/128']);
    expect(config.adminSessionTtlSec).toBe(12 * 3600);
    expect(config.allowHttpWebhooks).toBe(false);
    expect(config.allowPrivateWebhooks).toBe(false);
    expect(config.rateLimitWindowSec).toBe(60);
    expect(config.inquiryTtlSec).toBe(86_400);
    expect(config.inquiryDeliveryTimeoutMs).toBe(10_000);
    expect(config.identityTokenTtlSec).toBe(300);
    expect(config.registerRatePerMin).toBe(10);
    expect(config.loginRatePerMin).toBe(10);
    expect(config.inquiryRatePerMin).toBe(10);
    expect(config.inquiryPairRatePerHour).toBe(5);
    expect(config.defaultRatePerMin).toBe(60);
  });

  it('parses overrides', () => {
    const config = loadConfig({
      ...BASE,
      HOST: '0.0.0.0',
      ALLOW_HTTP_WEBHOOKS: 'yes',
      ALLOW_PRIVATE_WEBHOOKS: '0',
      TRUSTED_PROXIES: '::1/128, 10.0.0.0/8',
      INQUIRY_TTL_SEC: '3600',
      IDENTITY_TOKEN_TTL_SEC: '60',
      REGISTER_RATE_PER_MIN: '3',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.allowHttpWebhooks).toBe(true);
    expect(config.allowPrivateWebhooks).toBe(false);
    expect(config.trustedProxies).toEqual(['::1/128', '10.0.0.0/8']);
    expect(config.inquiryTtlSec).toBe(3600);
    expect(config.identityTokenTtlSec).toBe(60);
    expect(config.registerRatePerMin).toBe(3);
  });

  it('caps the identity token ttl at 300 seconds', () => {
    expect(() => loadConfig({ ...BASE, IDENTITY_TOKEN_TTL_SEC: '301' })).toThrow(/IDENTITY_TOKEN_TTL_SEC/);
    expect(() => loadConfig({ ...BASE, INQUIRY_DELIVERY_TIMEOUT_MS: '10' })).toThrow(/INQUIRY_DELIVERY_TIMEOUT_MS/);
  });

  it('validates TRUSTED_PROXIES entries', () => {
    expect(() => loadConfig({ ...BASE, TRUSTED_PROXIES: '127.0.0.1/64' })).toThrow(/TRUSTED_PROXIES/);
    expect(() => loadConfig({ ...BASE, TRUSTED_PROXIES: 'example.com' })).toThrow(/TRUSTED_PROXIES/);
    expect(() => loadConfig({ ...BASE, TRUSTED_PROXIES: '127.0.0.1/32, not-an-ip' })).toThrow(/TRUSTED_PROXIES/);
    expect(loadConfig({ ...BASE, TRUSTED_PROXIES: '::1' }).trustedProxies).toEqual(['::1']);
  });
});
