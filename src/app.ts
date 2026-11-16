import { Hono } from 'hono';

import { registerV1Routes } from './api.js';
import { registerAdminRoutes } from './admin/routes.js';
import { isAdminBearer } from './auth.js';
import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { buildJwks, ensureSigningKey } from './identity.js';
import { Metrics, normalizeRoute, renderMetrics } from './metrics.js';
import { redactLogLine } from './redact.js';
import { ADMIN_COOKIE, readCookie, readSession } from './session.js';
import { VERSION } from './version.js';

export function createApp(deps: Deps): Hono {
  const app = new Hono();
  // Attached before any route registration so handlers and background tasks
  // can increment counters from the first request on.
  deps.metrics ??= new Metrics();

  // First start generates the Ed25519 signing key pair (§7.1): the private
  // half is encrypted at rest right away, the public half only ever leaves
  // through the JWKS endpoint. Every later signature reuses this key.
  ensureSigningKey(deps);

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
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', error: redactLogLine(message) }));
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

  // Public verification key set for both JWT and inquiry payload signatures
  // (design §5.1, §7.3). Short caching keeps rotation visible within minutes.
  app.get('/.well-known/bot-relay/jwks.json', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(buildJwks(deps));
  });

  // Business-plane latency histogram (design §11). Route ids collapse to
  // :id so the label stays small; wall-clock timing, not deps.now.
  app.use('/v1/*', async (c, next) => {
    const startedAt = performance.now();
    await next();
    deps.metrics?.observe(
      'http_request_duration_seconds',
      { route: normalizeRoute(c.req.method, c.req.path), status: String(c.res.status) },
      (performance.now() - startedAt) / 1000,
    );
  });

  // Prometheus text exposition, deployer-only (design §5.7, §11): admin
  // bearer token or a logged-in admin session; nothing else may scrape it.
  app.get('/metrics', (c) => {
    if (!isAdminBearer(deps, c.req.header('authorization'))) {
      const raw = readCookie(c.req.header('cookie'), ADMIN_COOKIE);
      if (!readSession(raw ?? undefined, deps.db.getServerSecret(), deps.now())) {
        throw new HttpError(401, 'unauthorized', 'Admin token required', { 'www-authenticate': 'Bearer' });
      }
    }
    c.header('Cache-Control', 'no-store');
    return c.body(renderMetrics(deps), 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
  });

  registerV1Routes(app, deps);
  registerAdminRoutes(app, deps);
  return app;
}
