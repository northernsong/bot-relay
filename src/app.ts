import { Hono } from 'hono';

import { registerV1Routes } from './api.js';
import { registerAdminRoutes } from './admin/routes.js';
import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { VERSION } from './version.js';

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    const type = c.res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      c.header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
    const path = c.req.path;
    if (path.startsWith('/admin') || path.startsWith('/register') || path.startsWith('/v1')) {
      c.header('Cache-Control', 'no-store');
    }
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (err.headers) {
        for (const [key, value] of Object.entries(err.headers)) c.header(key, value);
      }
      return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
    }
    const message = err instanceof Error ? err.message : 'error';
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', error: message }));
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));

  app.get('/', (c) => c.json({ name: 'bot-relay', version: VERSION, health: '/health' }));

  app.get('/health', (c) => {
    if (!deps.db.ping()) {
      return c.json({ ok: false, version: VERSION, db: 'error' }, 503);
    }
    return c.json({ ok: true, version: VERSION, db: 'ok' });
  });

  registerV1Routes(app, deps);
  registerAdminRoutes(app, deps);
  return app;
}
