import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { ensureMigrations } from './db/client.js'; // run AFTER listen (below)
import { portfolioRoutes } from './routes/portfolio.js';
import { tradeRoutes } from './routes/trades.js';
import { importRoutes } from './routes/import.js';
import { symbolRoutes } from './routes/symbols.js';
import { cashRoutes } from './routes/cash.js';
import { depositRoutes } from './routes/deposits.js';
import { incomeRoutes } from './routes/income.js';
import { botEventRoutes } from './routes/bot-events.js';
import { futuresRoutes } from './routes/futures.js';
import { divergenceRoutes } from './routes/divergence.js';
import { startJobs } from './jobs/scheduler.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });

// Safety net: a background job (cron, boot warm-up, migration retry) that
// throws must NOT crash the whole API. During the May 2026 Neon outage an
// uncaught DB error in startJobs() exited the process (code 1) → crash-loop →
// every deploy failed its health check. Log and stay alive instead; request
// handlers still surface their own errors via setErrorHandler below.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandledRejection — kept alive');
});

// CORS: allow configured origins for the web app. Wildcards via the env
// var are allowed (e.g. `https://*.pages.dev`) — match handled per-request.
// Requests with no Origin header (curl, server-to-server) bypass entirely.
await app.register(cors, {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl / server-to-server
    for (const pattern of config.CORS_ORIGIN) {
      if (pattern === origin) return cb(null, true);
      if (pattern.includes('*')) {
        const re: RegExp = new RegExp(
          '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
        );
        if (re.test(origin)) return cb(null, true);
      }
    }
    cb(new Error('CORS: origin not allowed'), false);
  },
  credentials: true,
});
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

// Bearer-token auth. /health is the only exempt route — Fly's machine
// healthcheck cannot send headers, and the path leaks no data. Every
// other route demands `Authorization: Bearer <API_AUTH_TOKEN>`.
if (config.authEnabled) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || req.url.startsWith('/health?')) return;
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== config.API_AUTH_TOKEN) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
} else {
  app.log.warn('API_AUTH_TOKEN not set — API is OPEN. Fine for localhost only.');
}

await app.register(portfolioRoutes);
await app.register(tradeRoutes);
await app.register(importRoutes);
await app.register(symbolRoutes);
await app.register(cashRoutes);
await app.register(depositRoutes);
await app.register(incomeRoutes);
await app.register(botEventRoutes);
await app.register(futuresRoutes);
await app.register(divergenceRoutes);

app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message });
});

try {
  // Bind to 0.0.0.0 so a phone on the LAN can reach the API directly
  // when hitting the dev web bundle from the same WiFi network. Vite
  // still proxies /api → 127.0.0.1 on the desktop side, so nothing
  // changes there.
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  // Migrations run AFTER we're listening, in the background with retry. A down
  // DB (e.g. Neon quota suspension) must never prevent the API from listening —
  // /health has to answer so the deploy health-check passes and the app stays
  // reachable. ensureMigrations self-heals when the DB returns.
  void ensureMigrations();
  startJobs();
  app.log.info(
    `Binance: ${config.binanceEnabled ? 'enabled' : 'disabled (set BINANCE_API_KEY/SECRET)'}`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
