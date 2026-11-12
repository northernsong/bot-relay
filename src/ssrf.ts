import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import type { LookupFn } from './deps.js';
import { HttpError } from './errors.js';

const blocked = new BlockList();

function block4(subnet: string, prefix: number): void {
  blocked.addSubnet(subnet, prefix, 'ipv4');
}
function block6(subnet: string, prefix: number): void {
  blocked.addSubnet(subnet, prefix, 'ipv6');
}

block4('0.0.0.0', 8);
block4('10.0.0.0', 8);
block4('100.64.0.0', 10);
block4('127.0.0.0', 8);
block4('169.254.0.0', 16);
block4('172.16.0.0', 12);
block4('192.0.0.0', 24);
block4('192.0.2.0', 24);
block4('192.168.0.0', 16);
block4('198.18.0.0', 15);
block4('198.51.100.0', 24);
block4('203.0.113.0', 24);
block4('224.0.0.0', 4);
blocked.addAddress('255.255.255.255', 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
block6('fc00::', 7);
block6('fe80::', 10);
block6('ff00::', 8);
block6('2001:db8::', 32);

export function isBlockedIp(raw: string): boolean {
  const host = stripBrackets(raw.trim().toLowerCase());
  const family = isIP(host);
  if (family === 4) return blocked.check(host, 'ipv4');
  if (family === 6) return blocked.check(host, 'ipv6');
  return true;
}

export async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export async function assertWebhookUrl(
  raw: string,
  opts: { allowHttp: boolean; allowPrivate: boolean; lookupHost?: LookupFn },
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url is not a valid URL');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url must not include credentials');
  }
  if (url.hash) {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url must not include a fragment');
  }
  const https = url.protocol === 'https:';
  const httpOk = opts.allowHttp && url.protocol === 'http:';
  if (!https && !httpOk) {
    throw new HttpError(400, 'invalid_webhook', 'webhook_url must use https');
  }
  const host = stripBrackets(url.hostname).toLowerCase();
  if (!host) throw new HttpError(400, 'invalid_webhook', 'webhook_url is missing a host');

  if (!opts.allowPrivate) {
    if (isBlockedHostname(host)) {
      throw new HttpError(400, 'invalid_webhook', 'webhook_url host is not allowed');
    }
    if (isIP(host)) {
      if (isBlockedIp(host)) {
        throw new HttpError(400, 'invalid_webhook', 'webhook_url host is not allowed');
      }
    } else {
      const resolve = opts.lookupHost ?? defaultLookup;
      let addresses: string[];
      try {
        addresses = await resolve(host);
      } catch {
        throw new HttpError(400, 'invalid_webhook', 'webhook_url host could not be resolved');
      }
      if (addresses.length === 0 || addresses.some((address) => isBlockedIp(address))) {
        throw new HttpError(400, 'invalid_webhook', 'webhook_url host is not allowed');
      }
    }
  }

  return url.href;
}

function isBlockedHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal' ||
    host === 'metadata.internal'
  );
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}
