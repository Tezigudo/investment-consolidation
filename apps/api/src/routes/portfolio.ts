import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';
import { buildSnapshot } from '../services/portfolio.js';
import {
  readSnapshots,
  backfillSnapshots,
  snapshotCount,
  captureSnapshotNow,
} from '../services/portfolio-history.js';

interface DeltaPoint {
  thb: number;
  usd: number;
  pct: number;
}

function delta(latest: number, prior: number): DeltaPoint {
  const thb = latest - prior;
  return { thb, usd: 0, pct: prior > 0 ? (thb / prior) * 100 : 0 };
}

// Compute today/week/month/YTD reference points by walking the series
// backward from the latest snapshot and finding the closest date that
// satisfies each lookback. Series is sorted ASC by date.
function computeDeltas(series: { date: string; marketTHB: number; marketUSD: number }[]) {
  if (series.length === 0) {
    return { today: null, week: null, month: null, ytd: null };
  }
  const latest = series[series.length - 1];
  const latestDate = new Date(latest.date + 'T00:00:00Z');
  const findOnOrBefore = (cutoff: Date): typeof latest | null => {
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].date <= cutoffStr) return series[i];
    }
    return null;
  };

  const yesterday = new Date(latestDate);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const lastWeek = new Date(latestDate);
  lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
  const lastMonth = new Date(latestDate);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const yearStart = new Date(Date.UTC(latestDate.getUTCFullYear(), 0, 1));

  const dThb = (prev: typeof latest | null): DeltaPoint | null => {
    if (!prev) return null;
    return {
      thb: latest.marketTHB - prev.marketTHB,
      usd: latest.marketUSD - prev.marketUSD,
      pct: prev.marketTHB > 0 ? ((latest.marketTHB - prev.marketTHB) / prev.marketTHB) * 100 : 0,
    };
  };

  return {
    today: dThb(findOnOrBefore(yesterday)),
    week: dThb(findOnOrBefore(lastWeek)),
    month: dThb(findOnOrBefore(lastMonth)),
    ytd: dThb(findOnOrBefore(yearStart)),
  };
}

// Time-weighted return. For each day t with prior value V_{t-1} and end
// value V_t and net inflow F_t, period return r_t = (V_t − F_t) / V_{t-1}
// − 1. TWR over a window = Π(1 + r_t) − 1. Removes the timing of
// deposits/withdrawals from the headline % so it's directly comparable
// to "SPY returned X% YTD" rather than confounded with when the user
// happened to put money in.
//
// Flow proxy: ΔCost_thb between consecutive days. The backfill rebuilds
// V_t purely from trade replay against historical prices, so a BUY that
// adds 1000 THB of cost basis lifts both V_t and Cost_t by ~the same
// amount on the trade day — using the deposits ledger as the flow source
// would mis-time the inflow (deposits don't always become positions on
// the same day) and miss positions funded before the deposit ledger
// started tracking. ΔCost_thb is the flow the backfill itself "sees".
//
// THB is the canonical currency here — that's what the dashboard
// defaults to and what the user thinks in.
async function computeTWR(
  series: { date: string; ts: number; marketTHB: number; marketUSD: number; costTHB: number }[],
): Promise<{ ytd: number | null; oneYear: number | null; all: number | null }> {
  if (series.length < 2) return { ytd: null, oneYear: null, all: null };

  // Walk the series; build cumulative TWR factor up to and including each
  // date so we can slice arbitrary windows in one pass.
  const factors = new Array<number>(series.length);
  let cumFactor = 1;
  factors[0] = 1;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].marketTHB;
    const cur = series[i].marketTHB;
    const flow = series[i].costTHB - series[i - 1].costTHB;
    if (prev > 0) {
      const r = (cur - flow) / prev - 1;
      cumFactor *= 1 + r;
    }
    factors[i] = cumFactor;
  }

  const sliceTwr = (fromDate: string): number | null => {
    let startIdx = -1;
    for (let i = 0; i < series.length; i++) {
      if (series[i].date >= fromDate) {
        startIdx = i === 0 ? 0 : i - 1;
        break;
      }
    }
    if (startIdx < 0) return null;
    const endIdx = series.length - 1;
    if (startIdx >= endIdx) return null;
    const startF = factors[startIdx];
    if (startF <= 0) return null;
    return factors[endIdx] / startF - 1;
  };

  const latest = series[series.length - 1];
  const latestDate = new Date(latest.date + 'T00:00:00Z');
  const yearStart = new Date(Date.UTC(latestDate.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10);
  const oneYearAgo = new Date(latestDate);
  oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);

  return {
    ytd: sliceTwr(yearStart),
    oneYear: sliceTwr(oneYearAgo.toISOString().slice(0, 10)),
    all: factors[series.length - 1] - 1,
  };
}

export async function portfolioRoutes(app: FastifyInstance) {
  app.get('/portfolio', async (req) => {
    const refresh = (req.query as { refresh?: string })?.refresh === '1';
    return buildSnapshot({ refresh });
  });

  app.get<{ Querystring: { days?: string; backfill?: string } }>(
    '/portfolio/history',
    async (req) => {
      const days = Math.min(Math.max(Number(req.query.days) || 365, 7), 3650);
      // Lazy backfill on first call so the chart shows real data the
      // first time someone opens the dashboard after deploy. Subsequent
      // calls are cheap (just read from the snapshot table).
      if (await snapshotCount() < 2) {
        try {
          const r = await backfillSnapshots();
          req.log.info(
            `[portfolio-history] lazy backfill: +${r.inserted} inserted, ${r.updated} updated, ${r.days} days`,
          );
        } catch (e) {
          req.log.warn({ err: e }, '[portfolio-history] lazy backfill failed');
        }
      }
      // Force-rebackfill on demand. `?backfill=1` is fast (uses whatever
      // prices_daily already has). `?backfill=deep` extends the price +
      // FX caches to cover the full window before recomputing — slower
      // but accurate for the entire history. Use after a fresh import or
      // when you've just expanded coverage of new stock symbols.
      if (req.query.backfill === '1' || req.query.backfill === 'deep') {
        const r = await backfillSnapshots({ deepWarmPrices: req.query.backfill === 'deep' });
        req.log.info(
          `[portfolio-history] forced backfill (${req.query.backfill}): +${r.inserted} inserted, ${r.updated} updated`,
        );
      }
      const series = await readSnapshots(days);
      const deltas = computeDeltas(
        series.map((s) => ({ date: s.date, marketTHB: s.marketTHB, marketUSD: s.marketUSD })),
      );
      const twr = await computeTWR(series);
      return { series, deltas, twr };
    },
  );

  // Manual snapshot capture (dev/testing). Cron does this nightly.
  app.post('/portfolio/snapshot', async () => {
    return captureSnapshotNow();
  });

  // Trade attribution — "what if you'd never sold?". For each symbol with
  // trade history, compares the actual return (current market + realized)
  // against a buy-and-hold counterfactual (every BUY held to today).
  // Negative impact = sells gave up upside; positive = sells got out at
  // a relative top.
  app.get('/portfolio/attribution', async () => {
    const tradesRes = await pool.query<{
      platform: string;
      symbol: string;
      side: 'BUY' | 'SELL' | 'DIV';
      qty: number;
      price_usd: number;
    }>(
      `SELECT platform, symbol, side, qty, price_usd
       FROM trades
       WHERE platform IN ('DIME', 'Binance')
       ORDER BY ts ASC`,
    );

    const allSymbols = Array.from(new Set(tradesRes.rows.map((r) => r.symbol)));
    if (allSymbols.length === 0) {
      return { totalImpactUSD: 0, bySymbol: [] };
    }
    const { rows: priceRows } = await pool.query<{ symbol: string; price_usd: number }>(
      `SELECT symbol, price_usd FROM prices WHERE symbol = ANY($1::text[])`,
      [allSymbols],
    );
    const priceMap = new Map(priceRows.map((r) => [r.symbol, Number(r.price_usd)]));

    type Acc = {
      buyQty: number;
      buyCostUSD: number;
      sellQty: number;
      sellProceedsUSD: number;
    };
    const byKey = new Map<string, Acc>();
    for (const t of tradesRes.rows) {
      if (t.side === 'DIV') continue;
      const key = `${t.platform}:${t.symbol}`;
      let a = byKey.get(key);
      if (!a) {
        a = { buyQty: 0, buyCostUSD: 0, sellQty: 0, sellProceedsUSD: 0 };
        byKey.set(key, a);
      }
      if (t.side === 'BUY') {
        a.buyQty += Number(t.qty);
        a.buyCostUSD += Number(t.qty) * Number(t.price_usd);
      } else {
        a.sellQty += Number(t.qty);
        a.sellProceedsUSD += Number(t.qty) * Number(t.price_usd);
      }
    }

    const bySymbol: {
      platform: string;
      symbol: string;
      buyQty: number;
      sellQty: number;
      currentQty: number;
      avgBuyUSD: number;
      currentPriceUSD: number;
      actualReturnUSD: number;
      counterfactualReturnUSD: number;
      tradingImpactUSD: number;
    }[] = [];

    let totalImpactUSD = 0;
    for (const [key, a] of byKey) {
      if (a.sellQty <= 0) continue; // no sells = nothing to attribute
      const [platform, symbol] = key.split(':') as [string, string];
      const currentPrice = priceMap.get(symbol);
      if (currentPrice == null || currentPrice <= 0) continue;
      const currentQty = a.buyQty - a.sellQty;
      if (currentQty < -0.0001) continue; // shouldn't happen — short positions
      const avgBuyUSD = a.buyQty > 0 ? a.buyCostUSD / a.buyQty : 0;
      // Counterfactual: held everything, would now be worth buyQty × currentPrice.
      const counterfactualMarketUSD = a.buyQty * currentPrice;
      const counterfactualReturnUSD = counterfactualMarketUSD - a.buyCostUSD;
      // Actual return = current market on remaining + sell proceeds − total cost paid.
      const currentMarketUSD = Math.max(currentQty, 0) * currentPrice;
      const actualReturnUSD = currentMarketUSD + a.sellProceedsUSD - a.buyCostUSD;
      const tradingImpactUSD = actualReturnUSD - counterfactualReturnUSD;
      totalImpactUSD += tradingImpactUSD;
      bySymbol.push({
        platform,
        symbol,
        buyQty: a.buyQty,
        sellQty: a.sellQty,
        currentQty: Math.max(currentQty, 0),
        avgBuyUSD,
        currentPriceUSD: currentPrice,
        actualReturnUSD,
        counterfactualReturnUSD,
        tradingImpactUSD,
      });
    }

    bySymbol.sort((a, b) => Math.abs(b.tradingImpactUSD) - Math.abs(a.tradingImpactUSD));
    return { totalImpactUSD, bySymbol };
  });

  app.get('/health', async () => ({ ok: true, ts: Date.now() }));
}

void delta; // legacy helper retained for future per-series breakdowns
