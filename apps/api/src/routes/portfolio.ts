import type { FastifyInstance } from 'fastify';
import { buildSnapshot } from '../services/portfolio.js';

export async function portfolioRoutes(app: FastifyInstance) {
  app.get('/portfolio', async (req) => {
    const refresh = (req.query as { refresh?: string })?.refresh === '1';
    return buildSnapshot({ refresh });
  });

  app.get('/health', async () => ({ ok: true, ts: Date.now() }));
}
