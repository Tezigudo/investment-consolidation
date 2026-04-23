import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { getPrice } from '../services/prices.js';
import type { TradeRow } from '../db/types.js';

// Symbol price history. For a personal dashboard we don't persist full
// series per symbol — instead we return a reasonable synthesized trail
// anchored to today's real price. If you want full history, swap this
// with a provider call (Finnhub /stock/candle, Binance /api/v3/klines).
function synthSeries(symbol: string, todayUSD: number, avgUSD: number, days: number) {
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  const start = avgUSD * (0.85 + Math.abs(rnd()) * 0.15);
  const out: { t: number; price: number }[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const p = i / (days - 1);
    const trend = start + (todayUSD - start) * p;
    const vol = todayUSD * (0.012 + Math.abs(rnd()) * 0.01);
    const noise = Math.sin(i * 0.32 + seed * 0.0001) * vol + Math.sin(i * 0.11) * vol * 0.7 + rnd() * vol * 1.4;
    out.push({ t: now - (days - 1 - i) * 86400000, price: Math.max(trend + noise, todayUSD * 0.1) });
  }
  out[out.length - 1].price = todayUSD;
  return out;
}

export async function symbolRoutes(app: FastifyInstance) {
  app.get('/symbols/:sym/history', async (req) => {
    const { sym } = req.params as { sym: string };
    const { days = '180', kind = 'stock' } = req.query as { days?: string; kind?: 'stock' | 'crypto' };
    const trades = db.prepare('SELECT * FROM trades WHERE symbol = ? ORDER BY ts ASC').all(sym) as TradeRow[];
    const avgUSD = trades.length
      ? trades.reduce((a, t) => a + t.price_usd * t.qty, 0) /
        Math.max(1, trades.reduce((a, t) => a + t.qty, 0))
      : 0;
    const todayUSD = await getPrice(sym, kind);
    const n = Math.min(365, Math.max(30, Number(days) || 180));
    return {
      symbol: sym,
      todayUSD,
      avgUSD,
      series: synthSeries(sym, todayUSD || avgUSD || 1, avgUSD || todayUSD || 1, n),
    };
  });
}
