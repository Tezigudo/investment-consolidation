import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { getUSDTHB } from '../services/fx.js';

const UpsertBody = z.object({
  platform: z.string().min(1),
  label: z.string().min(1),
  amount_thb: z.number().nonnegative(),
});

export async function cashRoutes(app: FastifyInstance) {
  app.get('/cash', async () => {
    const { rows } = await pool.query('SELECT * FROM cash');
    return rows;
  });

  app.put('/cash', async (req, reply) => {
    const parsed = UpsertBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.flatten().fieldErrors };
    }
    const fx = await getUSDTHB();
    const { platform, label, amount_thb } = parsed.data;
    const amount_usd = amount_thb / fx.rate;
    await pool.query(
      `INSERT INTO cash(platform, label, amount_thb, amount_usd, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform) DO UPDATE SET
         label = EXCLUDED.label,
         amount_thb = EXCLUDED.amount_thb,
         amount_usd = EXCLUDED.amount_usd,
         updated_at = EXCLUDED.updated_at`,
      [platform, label, amount_thb, amount_usd, Date.now()],
    );
    return { ok: true };
  });
}
