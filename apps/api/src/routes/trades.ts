import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';
import type { TradeRow } from '../db/types.js';

export async function tradeRoutes(app: FastifyInstance) {
  app.get('/trades', async (req) => {
    const { platform, symbol, limit = 100 } = (req.query as {
      platform?: string;
      symbol?: string;
      limit?: number;
    }) || {};
    const where: string[] = [];
    const params: unknown[] = [];
    if (platform) {
      params.push(platform);
      where.push(`platform = $${params.length}`);
    }
    if (symbol) {
      params.push(symbol);
      where.push(`symbol = $${params.length}`);
    }
    params.push(Math.min(Number(limit) || 100, 500));
    const sql = `SELECT * FROM trades ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT $${params.length}`;
    const { rows } = await pool.query<TradeRow>(sql, params);
    return rows;
  });

  app.get('/dividends', async () => {
    const { rows } = await pool.query<TradeRow>(
      "SELECT * FROM trades WHERE side = 'DIV' ORDER BY ts DESC LIMIT 500",
    );
    return rows;
  });
}
