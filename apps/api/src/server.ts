import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import './db/client.js'; // triggers migrations
import { portfolioRoutes } from './routes/portfolio.js';
import { tradeRoutes } from './routes/trades.js';
import { importRoutes } from './routes/import.js';
import { symbolRoutes } from './routes/symbols.js';
import { cashRoutes } from './routes/cash.js';
import { startJobs } from './jobs/scheduler.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });

// CORS: allow configured origins for the web app. Mobile (RN) does not
// send Origin headers, so it bypasses this check entirely — no extra
// LAN origin needed for the iPhone client. Wildcards via the env var
// are allowed (e.g. `https://*.pages.dev`) — match handled per-request.
await app.register(cors, {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // mobile / curl / server-to-server
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
      reply.code(401).send({ error: 'unauthorized' });
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

app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message });
});

try {
  // Bind to 0.0.0.0 so the mobile client (Expo on a real iPhone) can
  // hit the API over the LAN. Vite still proxies /api → 127.0.0.1 for
  // the web side, so nothing changes there.
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  startJobs();
  app.log.info(
    `Binance: ${config.binanceEnabled ? 'enabled' : 'disabled (set BINANCE_API_KEY/SECRET)'}`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
