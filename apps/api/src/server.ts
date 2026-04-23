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

await app.register(cors, { origin: config.CORS_ORIGIN, credentials: true });
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

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
  await app.listen({ port: config.API_PORT, host: '127.0.0.1' });
  startJobs();
  app.log.info(
    `Binance: ${config.binanceEnabled ? 'enabled' : 'disabled (set BINANCE_API_KEY/SECRET)'}`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
