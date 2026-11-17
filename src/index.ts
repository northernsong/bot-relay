import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { Deps } from './deps.js';
import { openDatabase } from './db.js';
import { stopBackgroundWork } from './inquiry.js';

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid configuration';
    console.error(message);
    process.exit(1);
  }
})();

const db = openDatabase(config.databasePath);
const deps: Deps = { config, db, now: () => Date.now() };
const app = createApp(deps);

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    console.log(JSON.stringify({ level: 'info', msg: 'listening', host: config.host, port: info.port }));
  },
);

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', msg: 'shutdown', signal }));
  server.close(() => {
    void (async () => {
      // Stop the sweeper and drain in-flight deliveries before closing the
      // database, so background writes never hit a closed handle (F5).
      await stopBackgroundWork(deps);
      db.close();
      process.exit(0);
    })();
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
