import { pool } from '../db/client.js';
import { dateKey, backfillUSDTHB } from './fx-history.js';
import { getUSDTHB } from './fx.js';
import { buildSnapshot } from './portfolio.js';
import { warmDailyHistoryBatch } from './price-history.js';
import type { TradeRow, PositionRow } from '../db/types.js';

// One row per UTC day. Today's snapshot is captured from the live
// `buildSnapshot` so it always agrees with what the dashboard shows;
// historical snapshots come from `backfillSnapshots`, which replays the
// DIME trade history day-by-day against `prices_daily` + `fx_daily`.
//
// What's exact in the historical line:
//   • DIME positions — full trade replay, historical prices, FX-locked cost
//
// What's approximated as a "today's value" baseline at each historical day:
//   • Binance — live cron rescales cost basis to current qty (Earn rewards
//     accrue qty without proportional cash spent, so trade-aggregated cost
//     diverges from the live "what I actually own × what it cost me" view).
//     We use today's qty + today's cost per symbol, priced at the day's
//     historical price. Historical USDT value moves only with FX.
//   • On-chain — no trade history exists; today's qty priced historically.
//   • Bank cash — today's THB amount; USD-equivalent moves inversely with FX.
//
// These approximations affect the *shape* of the curve for the static
// portions only. The dominant signal — DIME stocks moving with the
// market — is exact.

const ONE_DAY = 86_400_000;

export interface SnapshotRow {
  date: string;
  ts: number;
  marketUSD: number;
  marketTHB: number;
  costUSD: number;
  costTHB: number;
  pnlUSD: number;
  pnlTHB: number;
  fxUSDTHB: number;
}

interface PositionState {
  platform: string;
  symbol: string;
  qty: number;
  costUSD: number;
  costTHB: number;
}

function applyTrade(state: PositionState, t: TradeRow): void {
  if (t.side === 'BUY') {
    const grossUSD = t.qty * t.price_usd + (t.commission ?? 0);
    state.qty += t.qty;
    state.costUSD += grossUSD;
    state.costTHB += grossUSD * t.fx_at_trade;
  } else if (t.side === 'SELL') {
    if (state.qty <= 0) return;
    const sellQty = Math.min(t.qty, state.qty);
    const sellFrac = sellQty / state.qty;
    state.costUSD -= state.costUSD * sellFrac;
    state.costTHB -= state.costTHB * sellFrac;
    state.qty -= sellQty;
  }
  // DIV: no cost-basis effect
}

// Per-asset sorted [ts, price] pairs. Lookup is binary search for the
// largest ts <= queryDay; this is the standard "carry-forward" rule for
// sparse daily series (weekends, exchange holidays).
type Series = { ts: number; value: number }[];

function buildSeries(rows: { date: string; value: number }[]): Series {
  const out: Series = rows
    .map((r) => ({ ts: Date.parse(`${r.date}T00:00:00Z`), value: r.value }))
    .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.value));
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function lookupAt(series: Series, dayMs: number, fallback: number): number {
  if (series.length === 0) return fallback;
  // queryDay is before the series starts: don't extrapolate backward —
  // using a future-dated price for an old day inflates historical value.
  // Caller's fallback (typically avg cost) is the correct neutral choice.
  if (dayMs < series[0].ts) return fallback;
  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts <= dayMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? fallback : series[found].value;
}

function startOfDayUTC(ts: number): number {
  return Math.floor(ts / ONE_DAY) * ONE_DAY;
}

async function loadPriceSeries(symbols: string[]): Promise<Map<string, Series>> {
  const out = new Map<string, Series>();
  if (symbols.length === 0) return out;
  const { rows } = await pool.query<{ asset: string; date: string; price_usd: number }>(
    `SELECT asset, date, price_usd FROM prices_daily WHERE asset = ANY($1)`,
    [symbols],
  );
  const byAsset = new Map<string, { date: string; value: number }[]>();
  for (const r of rows) {
    const arr = byAsset.get(r.asset) ?? [];
    arr.push({ date: r.date, value: r.price_usd });
    byAsset.set(r.asset, arr);
  }
  for (const [asset, arr] of byAsset) out.set(asset, buildSeries(arr));
  return out;
}

async function loadFxSeries(): Promise<Series> {
  const { rows } = await pool.query<{ date: string; rate: number }>(
    `SELECT date, rate FROM fx_daily WHERE pair = 'USDTHB' ORDER BY date ASC`,
  );
  return buildSeries(rows.map((r) => ({ date: r.date, value: r.rate })));
}

interface StaticPosition {
  symbol: string;
  qty: number;
  costUSD: number;
  costTHB: number;
}

async function loadStaticBaselines(): Promise<{
  bankTHB: number;
  binance: StaticPosition[];
  onchain: StaticPosition[];
}> {
  const cashRes = await pool.query<{ amount_thb: number; amount_usd: number }>(
    'SELECT amount_thb, amount_usd FROM cash',
  );
  let bankTHB = 0;
  for (const r of cashRes.rows) {
    // Heuristic: cash table has no explicit currency column. Default to
    // the THB side — accurate for the user's KKP X1270 row. A USD-only
    // bank row would be misclassified, but that's not a real case yet.
    bankTHB += Number(r.amount_thb);
  }

  const positionRes = await pool.query<PositionRow>(
    "SELECT * FROM positions WHERE platform IN ('OnChain', 'Binance') AND qty > 0",
  );
  const binance: StaticPosition[] = [];
  const onchain: StaticPosition[] = [];
  for (const p of positionRes.rows) {
    const sp: StaticPosition = {
      symbol: p.symbol,
      qty: Number(p.qty),
      costUSD: Number(p.qty) * Number(p.avg_cost_usd),
      costTHB: Number(p.cost_basis_thb),
    };
    if (p.platform === 'Binance') binance.push(sp);
    else onchain.push(sp);
  }
  return { bankTHB, binance, onchain };
}

async function writeSnapshot(s: SnapshotRow): Promise<'inserted' | 'updated'> {
  const r = await pool.query<{ inserted: boolean }>(
    `INSERT INTO portfolio_snapshots(date, ts, market_usd, market_thb, cost_usd, cost_thb, pnl_usd, pnl_thb, fx_usdthb)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (date) DO UPDATE SET
       ts = EXCLUDED.ts,
       market_usd = EXCLUDED.market_usd,
       market_thb = EXCLUDED.market_thb,
       cost_usd = EXCLUDED.cost_usd,
       cost_thb = EXCLUDED.cost_thb,
       pnl_usd = EXCLUDED.pnl_usd,
       pnl_thb = EXCLUDED.pnl_thb,
       fx_usdthb = EXCLUDED.fx_usdthb
     RETURNING (xmax = 0) AS inserted`,
    [s.date, s.ts, s.marketUSD, s.marketTHB, s.costUSD, s.costTHB, s.pnlUSD, s.pnlTHB, s.fxUSDTHB],
  );
  return r.rows[0]?.inserted ? 'inserted' : 'updated';
}

// Capture today's snapshot from the live builder so it always matches
// the dashboard. Idempotent — re-runs replace the same UTC-date row.
export async function captureSnapshotNow(): Promise<SnapshotRow> {
  const snap = await buildSnapshot();
  const today = dateKey(Date.now());
  const t = snap.totals.all;
  const row: SnapshotRow = {
    date: today,
    ts: Date.now(),
    marketUSD: t.marketUSD,
    marketTHB: t.marketTHB,
    costUSD: t.costUSD,
    costTHB: t.costTHB,
    pnlUSD: t.pnlUSD,
    pnlTHB: t.pnlTHB,
    fxUSDTHB: snap.fx.usdthb,
  };
  await writeSnapshot(row);
  return row;
}

// In-flight singleton: if two callers (e.g. boot sequence + a request
// hitting /portfolio/history during boot) both ask for a backfill at the
// same time, they share one execution instead of racing two parallel
// price-warm + DB-write batches against Yahoo/Binance. The second caller
// gets the same Promise back; cleared in `finally` so subsequent calls
// (e.g. a forced `?backfill=deep` after deploy) start fresh.
let inflightBackfill: Promise<{ inserted: number; updated: number; days: number }> | null = null;

// Replay every UTC day from the earliest trade until today, computing
// position state + market value at each day. Idempotent (UPSERT). Returns
// counts so callers can report what changed.
//
// `deepWarmPrices: true` first extends the prices_daily + fx_daily caches
// to cover the full backfill window. Without this, snapshots from periods
// before the cache's existing reach fall back to avg-cost (so PNL ≈ 0 for
// those days) — fine for a quick refresh but misleading for a first-ever
// backfill. The scheduler enables it on the one-time boot backfill.
export function backfillSnapshots(opts?: {
  since?: string;     // YYYY-MM-DD; defaults to earliest trade date
  deepWarmPrices?: boolean;
}): Promise<{ inserted: number; updated: number; days: number }> {
  if (inflightBackfill) return inflightBackfill;
  inflightBackfill = backfillSnapshotsImpl(opts).finally(() => {
    inflightBackfill = null;
  });
  return inflightBackfill;
}

async function backfillSnapshotsImpl(opts?: {
  since?: string;
  deepWarmPrices?: boolean;
}): Promise<{ inserted: number; updated: number; days: number }> {
  // Only DIME trades drive the historical state machine. Binance is
  // approximated as a static-today baseline (see header comment) because
  // its live qty is rescaled by the cron in a way trade replay cannot
  // reproduce without point-in-time Earn-balance snapshots.
  const tradeRes = await pool.query<TradeRow>(
    "SELECT * FROM trades WHERE platform = 'DIME' ORDER BY ts ASC",
  );
  const trades = tradeRes.rows;

  // The chart should cover the whole history of activity, even before
  // the user's first DIME trade — Binance Earn started years earlier.
  // Use the earliest of (any trade) and (any deposit) as the floor.
  const floorRes = await pool.query<{ first_trade: string | null; first_deposit: string | null }>(
    `SELECT (SELECT MIN(ts) FROM trades) AS first_trade,
            (SELECT MIN(ts) FROM deposits) AS first_deposit`,
  );
  const tsCandidates = [
    Number(floorRes.rows[0]?.first_trade ?? 0),
    Number(floorRes.rows[0]?.first_deposit ?? 0),
  ].filter((n) => n > 0);
  const fallbackEarliest = tsCandidates.length > 0 ? Math.min(...tsCandidates) : Date.now();

  const sinceTs = opts?.since ? Date.parse(`${opts.since}T00:00:00Z`) : fallbackEarliest;
  const startDay = startOfDayUTC(sinceTs);
  const todayDay = startOfDayUTC(Date.now());

  if (todayDay < startDay) return { inserted: 0, updated: 0, days: 0 };

  // Pre-load all the historical data once. Trade-driven positions live
  // in the running state map; static positions + FX series are pulled in batch.
  const tradeSymbols = Array.from(new Set(trades.map((t) => t.symbol)));
  const baselines = await loadStaticBaselines();
  const staticSymbols = [
    ...baselines.binance.map((p) => p.symbol),
    ...baselines.onchain.map((p) => p.symbol),
  ];
  const allSymbols = Array.from(new Set([...tradeSymbols, ...staticSymbols]));

  if (opts?.deepWarmPrices) {
    // Cover the full backfill window. Yahoo accepts ranges up to 'max';
    // Binance klines accept arbitrary windows. Sequential to avoid 429s.
    const days = Math.ceil((todayDay - startDay) / 86_400_000) + 30;
    const stockSymbols = await pool.query<{ symbol: string }>(
      "SELECT DISTINCT symbol FROM trades WHERE platform = 'DIME'",
    );
    const cryptoSymbols = await pool.query<{ symbol: string }>(
      "SELECT DISTINCT symbol FROM trades WHERE platform = 'Binance'",
    );
    const entries = [
      ...stockSymbols.rows.map((r) => ({ symbol: r.symbol, kind: 'stock' as const })),
      ...cryptoSymbols.rows.map((r) => ({ symbol: r.symbol, kind: 'crypto' as const })),
      ...baselines.onchain.map((p) => ({ symbol: p.symbol, kind: 'crypto' as const })),
    ];
    try {
      await warmDailyHistoryBatch(entries, days);
    } catch (e) {
      console.warn('[portfolio-history] deep price warm failed:', (e as Error).message);
    }
    try {
      await backfillUSDTHB(dateKey(startDay));
    } catch (e) {
      console.warn('[portfolio-history] FX deep warm failed:', (e as Error).message);
    }
  }

  const [priceSeries, fxSeries, fxNow] = await Promise.all([
    loadPriceSeries(allSymbols),
    loadFxSeries(),
    getUSDTHB(false),
  ]);

  // Note: we deliberately do NOT fall back to today's live cached price
  // when a symbol's prices_daily series is missing for a given day. Using
  // today's price for historical dates inflates old marketUSD by however
  // much the asset has appreciated since (e.g. NVDA in 2021 ≠ NVDA today),
  // which produces a misleading "step down" at the boundary of the price
  // cache. Instead we fall back to the position's avg cost — historical
  // PNL reads as ≈ 0 for the un-priced window, which is honest about the
  // missing data. Users can deepen prices_daily coverage by re-running
  // the chart-cache warmer over a longer window.

  const state = new Map<string, PositionState>();
  let tradeIdx = 0;

  let inserted = 0;
  let updated = 0;
  let days = 0;

  for (let d = startDay; d <= todayDay; d += ONE_DAY) {
    const dayEnd = d + ONE_DAY - 1;

    // Apply every trade that fell on or before this day. Trades are
    // sorted ascending so the pointer only moves forward.
    while (tradeIdx < trades.length && Number(trades[tradeIdx].ts) <= dayEnd) {
      const t = trades[tradeIdx++];
      const key = `${t.platform}:${t.symbol}`;
      let s = state.get(key);
      if (!s) {
        s = { platform: t.platform, symbol: t.symbol, qty: 0, costUSD: 0, costTHB: 0 };
        state.set(key, s);
      }
      applyTrade(s, t);
    }

    // Fold in trade-driven positions at this day's price.
    let positionsMarketUSD = 0;
    let positionsCostUSD = 0;
    let positionsCostTHB = 0;
    for (const s of state.values()) {
      if (s.qty <= 0) continue;
      const series = priceSeries.get(s.symbol);
      const avgCost = s.costUSD / s.qty;
      const px = lookupAt(series ?? [], d, avgCost);
      positionsMarketUSD += s.qty * px;
      positionsCostUSD += s.costUSD;
      positionsCostTHB += s.costTHB;
    }

    // Static positions (Binance + OnChain): today's qty held, priced at
    // each day's historical price. Falls back to avg cost on days that
    // predate the symbol's prices_daily coverage, so the curve doesn't
    // inflate with today's price for early periods.
    for (const p of [...baselines.binance, ...baselines.onchain]) {
      if (p.qty <= 0) continue;
      const series = priceSeries.get(p.symbol);
      const avgCost = p.costUSD / p.qty;
      const px = lookupAt(series ?? [], d, avgCost);
      positionsMarketUSD += p.qty * px;
      positionsCostUSD += p.costUSD;
      positionsCostTHB += p.costTHB;
    }

    const fx = lookupAt(fxSeries, d, fxNow.rate);

    // Bank cash: assume THB-denominated. Constant THB value across days;
    // USD-equivalent moves inversely with FX.
    const bankMarketTHB = baselines.bankTHB;
    const bankMarketUSD = fx > 0 ? baselines.bankTHB / fx : 0;

    const marketUSD = positionsMarketUSD + bankMarketUSD;
    const marketTHB = positionsMarketUSD * fx + bankMarketTHB;
    const costUSD = positionsCostUSD + bankMarketUSD;        // cash has no PNL
    const costTHB = positionsCostTHB + bankMarketTHB;
    const pnlUSD = marketUSD - costUSD;
    const pnlTHB = marketTHB - costTHB;

    const row: SnapshotRow = {
      date: dateKey(d),
      ts: d + ONE_DAY - 1,                     // end-of-day UTC
      marketUSD,
      marketTHB,
      costUSD,
      costTHB,
      pnlUSD,
      pnlTHB,
      fxUSDTHB: fx,
    };
    const r = await writeSnapshot(row);
    if (r === 'inserted') inserted++;
    else updated++;
    days++;
  }

  // Today: overwrite the most recent backfilled row with the live snapshot
  // so the chart's last point exactly matches the rest of the dashboard
  // (live prices > daily-cache prices, etc).
  if (todayDay > 0) await captureSnapshotNow();

  return { inserted, updated, days };
}

export async function readSnapshots(days: number): Promise<SnapshotRow[]> {
  const cutoff = startOfDayUTC(Date.now() - (days - 1) * ONE_DAY);
  const cutoffDate = dateKey(cutoff);
  const { rows } = await pool.query<{
    date: string;
    ts: string;
    market_usd: number;
    market_thb: number;
    cost_usd: number;
    cost_thb: number;
    pnl_usd: number;
    pnl_thb: number;
    fx_usdthb: number;
  }>(
    `SELECT * FROM portfolio_snapshots WHERE date >= $1 ORDER BY date ASC`,
    [cutoffDate],
  );
  return rows.map((r) => ({
    date: r.date,
    ts: Number(r.ts),
    marketUSD: Number(r.market_usd),
    marketTHB: Number(r.market_thb),
    costUSD: Number(r.cost_usd),
    costTHB: Number(r.cost_thb),
    pnlUSD: Number(r.pnl_usd),
    pnlTHB: Number(r.pnl_thb),
    fxUSDTHB: Number(r.fx_usdthb),
  }));
}

export async function snapshotCount(): Promise<number> {
  const { rows } = await pool.query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM portfolio_snapshots',
  );
  return Number(rows[0]?.c ?? 0);
}
