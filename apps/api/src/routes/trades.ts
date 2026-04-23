import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
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
      where.push('platform = ?');
      params.push(platform);
    }
    if (symbol) {
      where.push('symbol = ?');
      params.push(symbol);
    }
    const sql = `SELECT * FROM trades ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    params.push(Math.min(Number(limit) || 100, 500));
    return db.prepare(sql).all(...params) as TradeRow[];
  });

  app.get('/dividends', async () => {
    return db
      .prepare("SELECT * FROM trades WHERE side = 'DIV' ORDER BY ts DESC LIMIT 500")
      .all() as TradeRow[];
  });
}
