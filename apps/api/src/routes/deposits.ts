import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';
import { getUSDTHB } from '../services/fx.js';
import type { DepositRow } from '../db/types.js';

export interface DepositSummary {
  totalTHB: number;             // sum of amount_thb across deposits
  totalUSD: number;             // sum of amount_usd (i.e. THB-equivalent in USD at lock time)
  weightedFX: number;           // total_thb / total_usd → effective baseline FX
  currentFX: number;            // today's USDTHB
  // What the deposited THB *would be worth* if the user un-converted everything
  // back to USD at today's rate, ignoring market PNL on what they bought:
  //   totalUSD_if_today = totalTHB / currentFX
  // gap = totalUSD_if_today - totalUSD = how much "FX baseline" alone is worth now
  fxBaselineDeltaUSD: number;
  count: number;                // # of deposit rows
  byPlatform: Record<string, { totalTHB: number; totalUSD: number; count: number }>;
  firstTs: number | null;
  lastTs: number | null;
}

export interface DepositsResponse {
  rows: DepositRow[];
  summary: DepositSummary;
}

export async function depositRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>('/deposits', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const { rows } = await pool.query<DepositRow>(
      'SELECT * FROM deposits ORDER BY ts DESC LIMIT $1',
      [limit],
    );

    let totalTHB = 0;
    let totalUSD = 0;
    let firstTs: number | null = null;
    let lastTs: number | null = null;
    const byPlatform: Record<string, { totalTHB: number; totalUSD: number; count: number }> = {};
    for (const r of rows) {
      totalTHB += r.amount_thb;
      totalUSD += r.amount_usd;
      const ts = Number(r.ts);
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
      const p = byPlatform[r.platform] ?? { totalTHB: 0, totalUSD: 0, count: 0 };
      p.totalTHB += r.amount_thb;
      p.totalUSD += r.amount_usd;
      p.count += 1;
      byPlatform[r.platform] = p;
    }

    const fx = await getUSDTHB(false);
    const currentFX = fx.rate;
    const weightedFX = totalUSD > 0 ? totalTHB / totalUSD : currentFX;
    const fxBaselineDeltaUSD = currentFX > 0 ? totalTHB / currentFX - totalUSD : 0;

    const summary: DepositSummary = {
      totalTHB,
      totalUSD,
      weightedFX,
      currentFX,
      fxBaselineDeltaUSD,
      count: rows.length,
      byPlatform,
      firstTs,
      lastTs,
    };
    return { rows, summary };
  });
}
