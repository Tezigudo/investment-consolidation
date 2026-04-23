import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { getUSDTHB } from '../services/fx.js';

const UpsertBody = z.object({
  platform: z.string().min(1),
  label: z.string().min(1),
  amount_thb: z.number().nonnegative(),
});

export async function cashRoutes(app: FastifyInstance) {
  app.get('/cash', async () => db.prepare('SELECT * FROM cash').all());

  app.put('/cash', async (req, reply) => {
    const parsed = UpsertBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.flatten().fieldErrors };
    }
    const fx = await getUSDTHB();
    const { platform, label, amount_thb } = parsed.data;
    const amount_usd = amount_thb / fx.rate;
    db.prepare(
      `INSERT INTO cash(platform, label, amount_thb, amount_usd, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(platform) DO UPDATE SET
         label = excluded.label,
         amount_thb = excluded.amount_thb,
         amount_usd = excluded.amount_usd,
         updated_at = excluded.updated_at`,
    ).run(platform, label, amount_thb, amount_usd, Date.now());
    return { ok: true };
  });
}
