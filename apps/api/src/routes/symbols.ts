import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';
import { getPrice } from '../services/prices.js';
import { binancePublicGet } from './../services/binance-http.js';
import { dateKey } from '../services/fx-history.js';
import { aggregateTrades } from '../services/cost-basis.js';
import { readOnchainEarnForSymbol, readOnchainAirdropForSymbol } from '../services/onchain.js';
import { getUSDTHB } from '../services/fx.js';
import type { TradeRow } from '../db/types.js';

// Real daily price history. Reads from `prices_daily` cache first, then
// fills any gap with a single bulk fetch:
//   - crypto: Binance /api/v3/klines (1d candles in USDT)
//   - stock:  Yahoo /v8/finance/chart (1d candles, free, no key)
// Today's price is whatever `getPrice()` returns (live cached) so the
// chart's last point matches the dashboard.

const ONE_DAY = 86_400_000;

// After a daily backfill attempt (success OR failure), don't try again
// for this long. Protects against modal-open spam hammering Yahoo and
// triggering 429s on symbols whose history just isn't available.
const FETCH_COOLDOWN_MS = 60 * 1000;

function todayDayStart(): number {
  return Math.floor(Date.now() / ONE_DAY) * ONE_DAY;
}

async function readFetchedAt(asset: string): Promise<number> {
  const { rows } = await pool.query<{ last_fetched_at: string | number }>(
    'SELECT last_fetched_at FROM prices_daily_fetch WHERE asset = $1',
    [asset],
  );
  return rows[0] ? Number(rows[0].last_fetched_at) : 0;
}

async function markFetched(asset: string): Promise<void> {
  await pool.query(
    `INSERT INTO prices_daily_fetch(asset, last_fetched_at) VALUES ($1, $2)
     ON CONFLICT (asset) DO UPDATE SET last_fetched_at = EXCLUDED.last_fetched_at`,
    [asset, Date.now()],
  );
}

// Coalesce concurrent backfills for the same symbol+window. Two modal
// opens within the same second share one upstream call instead of
// racing two identical fetches into a 429.
const inflight = new Map<string, Promise<{ day: number; price: number }[]>>();

function fetchDailyOnce(
  asset: string,
  kind: 'stock' | 'crypto',
  fromDay: number,
  toDay: number,
  days: number,
): Promise<{ day: number; price: number }[]> {
  const key = `${kind}:${asset}:${days}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (kind === 'crypto'
    ? fetchCryptoDaily(asset, fromDay, toDay)
    : fetchStockDaily(asset, days)
  ).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function readDailyCache(
  asset: string,
  fromDay: number,
  toDay: number,
): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ date: string; price_usd: number }>(
    `SELECT date, price_usd FROM prices_daily WHERE asset = $1 AND date >= $2 AND date <= $3`,
    [asset, dateKey(fromDay), dateKey(toDay)],
  );
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.date, r.price_usd);
  return out;
}

async function writeDailyCache(
  asset: string,
  source: string,
  points: { day: number; price: number }[],
): Promise<void> {
  if (!points.length) return;
  const dates = points.map((p) => dateKey(p.day));
  const prices = points.map((p) => p.price);
  await pool.query(
    `INSERT INTO prices_daily(asset, date, price_usd, source)
     SELECT $1, date, price_usd, $4
     FROM unnest($2::text[], $3::numeric[]) AS t(date, price_usd)
     ON CONFLICT (asset, date) DO UPDATE SET price_usd = EXCLUDED.price_usd, source = EXCLUDED.source`,
    [asset, dates, prices, source],
  );
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
  const cache = await readDailyCache(symbol, fromDay, today);

  // 2. Decide whether to refetch.
  //   a) cold cache (<30% of window populated) → backfill the whole window.
  //   b) warm cache but the freshest entry is more than STALE_DAYS old
  //      relative to *yesterday* → refetch (today is overlaid by
  //      getPrice(), so today missing from prices_daily is normal and
  //      must not, by itself, trigger a fetch).
  // Stocks legitimately have weekend/holiday gaps, so we allow up to 3
  // missing days at the tail before refetching.
  const STALE_DAYS = 3;
  let latestCachedDay = 0;
  for (const k of cache.keys()) {
    const d = Date.parse(k);
    if (Number.isFinite(d) && d > latestCachedDay) latestCachedDay = d;
  }
  const yesterday = today - ONE_DAY;
  const isCold = cache.size < days * 0.3;
  const isStale = latestCachedDay > 0 && yesterday - latestCachedDay > STALE_DAYS * ONE_DAY;
  let needFetch = isCold || isStale;

  // Cooldown: even if the cache is cold/stale, don't retry an upstream
  // we just hit. Prevents modal-open spam from cycling 429s on symbols
  // whose backfill returned empty.
  if (needFetch) {
    const lastFetched = await readFetchedAt(symbol);
    if (lastFetched > 0 && Date.now() - lastFetched < FETCH_COOLDOWN_MS) {
      needFetch = false;
    }
  }

  if (needFetch) {
    const fresh = await fetchDailyOnce(symbol, kind, fromDay, today, days);
    // Mark the attempt regardless of outcome so a failing upstream
    // doesn't get hammered on every modal open.
    await markFetched(symbol);
    if (fresh.length) {
      await writeDailyCache(symbol, kind === 'crypto' ? 'binance-klines' : 'yahoo-chart', fresh);
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

    const { rows: trades } = await pool.query<TradeRow>(
      'SELECT * FROM trades WHERE symbol = $1 ORDER BY ts ASC',
      [sym],
    );

    // Spot-only view (excludes Earn rewards) keeps cost basis aligned with
    // what brokers like DIME show. Reward rows land as side:'BUY' with
    // source:'api-reward' but should not contribute to cost or realized PNL.
    const isReward = (t: TradeRow) => t.source === 'api-reward';
    const spotTrades = trades.filter(
      (t) => (t.side === 'BUY' || t.side === 'SELL') && !isReward(t),
    );
    const rewardRows = trades.filter(isReward);
    const agg = aggregateTrades(spotTrades);

    // Aggregate Earn rewards into one block so the client can render a
    // single "Total earned" stat instead of a wall of $0.00 rows.
    const earned = rewardRows.reduce(
      (acc, r) => {
        const valueUSD = r.qty * r.price_usd;
        acc.qty += r.qty;
        acc.valueUSD += valueUSD;
        acc.valueTHB += valueUSD * r.fx_at_trade;
        acc.count += 1;
        if (r.ts < acc.firstTs || acc.firstTs === 0) acc.firstTs = r.ts;
        if (r.ts > acc.lastTs) acc.lastTs = r.ts;
        return acc;
      },
      { qty: 0, valueUSD: 0, valueTHB: 0, count: 0, firstTs: 0, lastTs: 0 },
    );

    const todayUSD = await getPrice(sym, kind);

    const onchain = await readOnchainEarnForSymbol(sym);
    if (onchain && onchain.qty > 0) {
      const fx = todayUSD > 0 ? await getUSDTHB() : null;
      const valueUSD = onchain.qty * todayUSD;
      earned.qty += onchain.qty;
      earned.valueUSD += valueUSD;
      earned.valueTHB += fx ? valueUSD * fx.rate : 0;
      earned.count += onchain.vaultCount;
    }

    const airdropAgg = await readOnchainAirdropForSymbol(sym);
    let airdrop:
      | { qty: number; valueUSD: number; valueTHB: number; count: number; sources: number; firstTs: number; lastTs: number }
      | null = null;
    if (airdropAgg && airdropAgg.qty > 0) {
      const fx = todayUSD > 0 ? await getUSDTHB() : null;
      const valueUSD = airdropAgg.qty * todayUSD;
      airdrop = {
        qty: airdropAgg.qty,
        valueUSD,
        valueTHB: fx ? valueUSD * fx.rate : 0,
        count: airdropAgg.count,
        sources: airdropAgg.sources,
        firstTs: airdropAgg.firstTs,
        lastTs: airdropAgg.lastTs,
      };
    }

    const series = await buildSeries(sym, kind, n, todayUSD);

    return {
      symbol: sym,
      todayUSD,
      avgUSD: agg.avgUSD,
      heldQty: agg.qty,
      realizedUSD: agg.realizedUSD,
      realizedTHB: agg.realizedTHB,
      realizedFxContribTHB: agg.realizedFxContribTHB,
      series,
      earned,
      airdrop,
      // Trades list now spot-only — Earn rewards roll up into `earned`.
      trades: spotTrades.map((t) => ({
        id: t.id,
        ts: t.ts,
        side: t.side,
        qty: t.qty,
        price_usd: t.price_usd,
        fx_at_trade: t.fx_at_trade,
        commission: t.commission,
        source: t.source,
      })),
    };
  });
}
