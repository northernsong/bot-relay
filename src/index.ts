import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { Deps } from './deps.js';
import { startDeliveryWorker } from './delivery.js';
import { openDatabase } from './db.js';

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid configuration';
    console.error(message);
    process.exit(1);
  }
})();

if (!config.encryptionKey) {
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'ENCRYPTION_KEY is not set. Stored webhook and A2A credentials are encrypted with a key derived from RELAY_SECRET. Set ENCRYPTION_KEY to separate them.',
    }),
  );
}

const db = openDatabase(config.databasePath);
const deps: Deps = { config, db, now: () => Date.now() };
const app = createApp(deps);
const stopWorker = startDeliveryWorker(deps);

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    console.log(JSON.stringify({ level: 'info', msg: 'listening', host: config.host, port: info.port }));
  },
);

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', msg: 'shutdown', signal }));
  stopWorker();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
