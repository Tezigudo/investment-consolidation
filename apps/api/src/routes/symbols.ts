import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { getPrice } from '../services/prices.js';
import { binancePublicGet } from './../services/binance-http.js';
import { dateKey } from '../services/fx-history.js';
import type { TradeRow } from '../db/types.js';

// Real daily price history. Reads from `prices_daily` cache first, then
// fills any gap with a single bulk fetch:
//   - crypto: Binance /api/v3/klines (1d candles in USDT)
//   - stock:  Yahoo /v8/finance/chart (1d candles, free, no key)
// Today's price is whatever `getPrice()` returns (live cached) so the
// chart's last point matches the dashboard.

const ONE_DAY = 86_400_000;

function todayDayStart(): number {
  return Math.floor(Date.now() / ONE_DAY) * ONE_DAY;
}

function readDailyCache(asset: string, fromDay: number, toDay: number): Map<string, number> {
  const rows = db
    .prepare(`SELECT date, price_usd FROM prices_daily WHERE asset = ? AND date >= ? AND date <= ?`)
    .all(asset, dateKey(fromDay), dateKey(toDay)) as { date: string; price_usd: number }[];
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.date, r.price_usd);
  return out;
}

function writeDailyCache(asset: string, source: string, points: { day: number; price: number }[]) {
  const stmt = db.prepare(
    `INSERT INTO prices_daily(asset, date, price_usd, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(asset, date) DO UPDATE SET price_usd = excluded.price_usd, source = excluded.source`,
  );
  const tx = db.transaction((rows: { day: number; price: number }[]) => {
    for (const r of rows) stmt.run(asset, dateKey(r.day), r.price, source);
  });
  tx(points);
}

async function fetchCryptoDaily(asset: string, fromDay: number, toDay: number): Promise<{ day: number; price: number }[]> {
  // Binance returns up to 1000 candles per call; our window is ≤365 so a single call works.
  const symbol = `${asset}USDT`;
  try {
    const rows = await binancePublicGet<unknown[][]>('/api/v3/klines', {
      symbol,
      interval: '1d',
      startTime: fromDay,
      endTime: toDay + ONE_DAY - 1,
      limit: 1000,
    });
    return rows
      .map((r) => ({ day: Math.floor(Number(r[0]) / ONE_DAY) * ONE_DAY, price: Number(r[4]) }))
      .filter((p) => Number.isFinite(p.price) && p.price > 0);
  } catch (e) {
    console.warn(`[symbol-history] crypto klines ${asset} failed:`, (e as Error).message);
    return [];
  }
}

async function fetchStockDaily(symbol: string, days: number): Promise<{ day: number; price: number }[]> {
  // Yahoo's chart endpoint snaps to its own range buckets. Pick the
  // tightest one that fits, then trim client-side.
  const range = days <= 30 ? '1mo' : days <= 90 ? '3mo' : days <= 180 ? '6mo' : '1y';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (consolidate-dashboard)' } });
    if (!res.ok) throw new Error(`yahoo ${res.status}`);
    const data = (await res.json()) as {
      chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
    };
    const r = data.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const out: { day: number; price: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c) || c <= 0) continue;
      out.push({ day: Math.floor((ts[i] * 1000) / ONE_DAY) * ONE_DAY, price: c });
    }
    return out;
  } catch (e) {
    console.warn(`[symbol-history] yahoo chart ${symbol} failed:`, (e as Error).message);
    return [];
  }
}

async function buildSeries(
  symbol: string,
  kind: 'stock' | 'crypto',
  days: number,
  todayUSD: number,
): Promise<{ t: number; price: number }[]> {
  const today = todayDayStart();
  const fromDay = today - (days - 1) * ONE_DAY;

  // 1. Read cache.
  const cache = readDailyCache(symbol, fromDay, today);

  // 2. If cache misses any day older than today, refetch the whole window.
  // (Backfill is cheap — 1 API call — and avoids dealing with weekend gaps for stocks.)
  let needFetch = false;
  for (let d = fromDay; d < today; d += ONE_DAY) {
    // Stocks have legit weekend/holiday gaps. We treat any single gap as fillable
    // by carrying forward, so only refetch when the cache has NO recent rows at all.
  }
  const cacheCount = cache.size;
  // Heuristic: refetch if we have <30% of expected days for the window.
  if (cacheCount < days * 0.3) needFetch = true;

  if (needFetch) {
    const fresh =
      kind === 'crypto'
        ? await fetchCryptoDaily(symbol, fromDay, today)
        : await fetchStockDaily(symbol, days);
    if (fresh.length) {
      writeDailyCache(symbol, kind === 'crypto' ? 'binance-klines' : 'yahoo-chart', fresh);
      for (const p of fresh) cache.set(dateKey(p.day), p.price);
    }
  }

  // 3. Materialize a daily series, carrying last known price across gaps
  // (weekends/holidays for stocks, kline misses for crypto).
  const series: { t: number; price: number }[] = [];
  let last: number | null = null;
  for (let d = fromDay; d <= today; d += ONE_DAY) {
    const k = dateKey(d);
    const p = cache.get(k);
    if (p != null) last = p;
    if (last != null) series.push({ t: d, price: last });
  }

  // 4. Override the final point with today's live price so chart matches the dashboard.
  if (todayUSD > 0 && series.length) series[series.length - 1] = { t: today, price: todayUSD };

  return series;
}

export async function symbolRoutes(app: FastifyInstance) {
  app.get('/symbols/:sym/history', async (req) => {
    const { sym } = req.params as { sym: string };
    const { days = '180', kind = 'stock' } = req.query as { days?: string; kind?: 'stock' | 'crypto' };
    const n = Math.min(365, Math.max(30, Number(days) || 180));

    const trades = db
      .prepare('SELECT * FROM trades WHERE symbol = ? ORDER BY ts ASC')
      .all(sym) as TradeRow[];

    const totalQty = trades.reduce((a, t) => (t.side === 'BUY' ? a + t.qty : t.side === 'SELL' ? a - t.qty : a), 0);
    const buyValue = trades.filter((t) => t.side === 'BUY').reduce((a, t) => a + t.qty * t.price_usd, 0);
    const buyQty = trades.filter((t) => t.side === 'BUY').reduce((a, t) => a + t.qty, 0);
    const avgUSD = buyQty > 0 ? buyValue / buyQty : 0;

    const todayUSD = await getPrice(sym, kind);
    const series = await buildSeries(sym, kind, n, todayUSD);

    return {
      symbol: sym,
      todayUSD,
      avgUSD,
      heldQty: totalQty,
      series,
      trades: trades.map((t) => ({
        id: t.id,
        ts: t.ts,
        side: t.side,
        qty: t.qty,
        price_usd: t.price_usd,
        fx_at_trade: t.fx_at_trade,
        source: t.source,
      })),
    };
  });
}
