import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { importTradesCsv } from '../services/csv-importer.js';

const Query = z.object({
  platform: z.enum(['DIME', 'Binance']).default('DIME'),
});

export async function importRoutes(app: FastifyInstance) {
  app.post('/import/trades-csv', async (req, reply) => {
    const { platform } = Query.parse(req.query);
    const file = await req.file();
    if (!file) {
      reply.code(400);
      return { error: 'multipart file field required' };
    }
    const buf = await file.toBuffer();
    const text = buf.toString('utf8');
    try {
      return importTradesCsv(text, platform);
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });
}
