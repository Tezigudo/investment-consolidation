// GET /divergence — RSI divergence state for BTC across 4h / 1D / 1W.
//
// CONTEXT ONLY. This signal was measured to have no tradable edge (best z=+1.80
// on n=6 vs a 1.96 threshold; hit-rate marginally over base with NEGATIVE mean
// return at every timeframe — see services/divergence.ts). It exists so the
// dashboard can say "BTC is stretched on the daily", the same situational read
// the multi-timeframe workflow gives. No order anywhere may depend on it.
//
// Binance klines are rate-limited and this is a dashboard poll, so results are
// cached for CACHE_MS. Weekly candles move once a week; a stale minute is fine.

import type { FastifyInstance } from 'fastify';
import { binancePublicGet } from '../services/binance-http.js';
import { findDivergences, rsi, type Candle } from '../services/divergence.js';

const FRAMES = [
  { tf: '4h', interval: '4h', limit: 500 },
  { tf: '1D', interval: '1d', limit: 500 },
  { tf: '1W', interval: '1w', limit: 400 },
] as const;

const CACHE_MS = 5 * 60_000;
let cache: { at: number; payload: unknown } | null = null;

type RawKline = [number, string, string, string, string, string, ...unknown[]];

async function frameState(interval: string, limit: number, tf: string) {
  const rows = await binancePublicGet<RawKline[]>('/api/v3/klines', {
    symbol: 'BTCUSDT',
    interval,
    limit,
  });

  const candles: Candle[] = rows.map((r) => ({
    openTime: Number(r[0]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
  }));

  const hits = findDivergences(candles);
  const closes = candles.map((c) => c.close);
  const r = rsi(closes, 14);
  const lastRsi = r[r.length - 1];

  // The final candle is still forming; the last CLOSED bar is the honest
  // reference for "bars since", matching how the bot evaluates.
  const lastClosedIdx = candles.length - 2;
  const last = hits.length ? hits[hits.length - 1] : null;
  const barsAgo =
    last === null
      ? null
      : Math.max(0, candles.findIndex((c) => c.openTime === last.at) >= 0
          ? lastClosedIdx - candles.findIndex((c) => c.openTime === last.at)
          : 0);

  return {
    tf,
    rsi: Number.isFinite(lastRsi) ? Number(lastRsi.toFixed(1)) : null,
    bullCount: hits.filter((h) => h.kind === 'bull').length,
    bearCount: hits.filter((h) => h.kind === 'bear').length,
    last: last ? { kind: last.kind, at: last.at, rsi: last.rsi, barsAgo } : null,
    windowStart: candles.length ? candles[0].openTime : null,
  };
}

export async function divergenceRoutes(app: FastifyInstance) {
  app.get('/divergence', async () => {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.payload;

    const frames = [];
    for (const f of FRAMES) {
      try {
        frames.push(await frameState(f.interval, f.limit, f.tf));
      } catch (e) {
        // One bad timeframe must not blank the whole card.
        app.log.warn(`[divergence] ${f.tf} failed: ${(e as Error).message}`);
        frames.push({
          tf: f.tf, rsi: null, bullCount: 0, bearCount: 0,
          last: null, windowStart: null,
        });
      }
    }

    const payload = { asOf: Date.now(), symbol: 'BTCUSDT', frames };
    cache = { at: Date.now(), payload };
    return payload;
  });
}
