import { pool } from '../db/client.js';
import { fetchKlinePriceAt } from './binance.js';
import { binancePublicGet } from './binance-http.js';
import { dateKey } from './fx-history.js';
import { isStable } from './binance-stables.js';

// Historical crypto-in-USDT price lookup, cached per (asset, date) in
// prices_daily. Used by the Binance history importer to mark-to-market
// Earn rewards at the moment of payout without re-calling /klines for
// every reward row.

const ONE_DAY = 86_400_000;
// Re-fetch a symbol's daily window only if the freshest cached entry is
// older than this many days. Stocks legitimately have weekend gaps so
// the threshold has to swallow at least Sat+Sun+holiday.
const STALE_DAYS = 3;

function todayDayStart(): number {
  return Math.floor(Date.now() / ONE_DAY) * ONE_DAY;
}

export async function getPriceUSDTForTs(asset: string, ts: number): Promise<number | null> {
  if (isStable(asset)) return 1;
  const date = dateKey(ts);

  const { rows } = await pool.query<{ price_usd: number }>(
    `SELECT price_usd FROM prices_daily WHERE asset = $1 AND date = $2`,
    [asset, date],
  );
  if (rows[0]) return rows[0].price_usd;

  let price = await fetchKlinePriceAt(asset, ts, 'USDT');
  if (price == null) {
    // Fall back to BUSD for pre-2024 rows where {ASSET}USDT didn't
    // exist but {ASSET}BUSD did. BUSD ≈ 1 USD so it's a fine proxy.
    price = await fetchKlinePriceAt(asset, ts, 'BUSD');
  }
  if (price == null) return null;

  await pool.query(
    `INSERT INTO prices_daily(asset, date, price_usd, source)
     VALUES ($1, $2, $3, 'binance-klines')
     ON CONFLICT (asset, date) DO UPDATE SET price_usd = EXCLUDED.price_usd, source = EXCLUDED.source`,
    [asset, date, price],
  );
  return price;
}

async function fetchCryptoDailyWindow(asset: string, fromDay: number, toDay: number): Promise<{ day: number; price: number }[]> {
  try {
    const rows = await binancePublicGet<unknown[][]>('/api/v3/klines', {
      symbol: `${asset}USDT`,
      interval: '1d',
      startTime: fromDay,
      endTime: toDay + ONE_DAY - 1,
      limit: 1000,
    });
    return rows
      .map((r) => ({ day: Math.floor(Number(r[0]) / ONE_DAY) * ONE_DAY, price: Number(r[4]) }))
      .filter((p) => Number.isFinite(p.price) && p.price > 0);
  } catch (e) {
    console.warn(`[price-history] crypto klines ${asset} failed:`, (e as Error).message);
    return [];
  }
}

async function fetchStockDailyWindow(symbol: string, days: number): Promise<{ day: number; price: number }[]> {
  const range =
    days <= 30 ? '1mo'
    : days <= 90 ? '3mo'
    : days <= 180 ? '6mo'
    : days <= 365 ? '1y'
    : days <= 730 ? '2y'
    : days <= 1825 ? '5y'
    : 'max';
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
    console.warn(`[price-history] yahoo chart ${symbol} failed:`, (e as Error).message);
    return [];
  }
}

async function writeDailyWindow(
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

export async function warmDailyHistory(symbol: string, kind: 'stock' | 'crypto', days: number): Promise<boolean> {
  const today = todayDayStart();
  const fromDay = today - (days - 1) * ONE_DAY;

  const { rows } = await pool.query<{ date: string }>(
    `SELECT date FROM prices_daily WHERE asset = $1 AND date >= $2 AND date <= $3`,
    [symbol, dateKey(fromDay), dateKey(today)],
  );
  let latestCachedDay = 0;
  for (const r of rows) {
    const d = Date.parse(r.date);
    if (Number.isFinite(d) && d > latestCachedDay) latestCachedDay = d;
  }
  const yesterday = today - ONE_DAY;
  const isCold = rows.length < days * 0.3;
  const isStale = latestCachedDay > 0 && yesterday - latestCachedDay > STALE_DAYS * ONE_DAY;
  if (!isCold && !isStale) return false;

  const fresh = kind === 'crypto'
    ? await fetchCryptoDailyWindow(symbol, fromDay, today)
    : await fetchStockDailyWindow(symbol, days);
  if (!fresh.length) return false;

  await writeDailyWindow(symbol, kind === 'crypto' ? 'binance-klines' : 'yahoo-chart', fresh);
  return true;
}

// Sequential — Binance and Yahoo will 429 on parallel hits per IP.
export async function warmDailyHistoryBatch(
  entries: { symbol: string; kind: 'stock' | 'crypto' }[],
  days: number,
): Promise<{ warmed: number; skipped: number }> {
  let warmed = 0;
  let skipped = 0;
  for (const { symbol, kind } of entries) {
    try {
      const fetched = await warmDailyHistory(symbol, kind, days);
      if (fetched) warmed++;
      else skipped++;
    } catch (e) {
      console.warn(`[price-history] warm ${kind}:${symbol} failed:`, (e as Error).message);
    }
  }
  return { warmed, skipped };
}
