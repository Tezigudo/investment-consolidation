import { pool } from '../db/client.js';
import { fetchBinancePositions } from './binance.js';
import { isStable } from './binance-stables.js';
import { refreshPrices, getCachedPrices } from './prices.js';
import { getUSDTHB } from './fx.js';
import { aggregateTrades, aggregateTradesFIFO } from './cost-basis.js';
import type { PositionRow, TradeRow } from '../db/types.js';
import type {
  Platform,
  EnrichedPosition,
  Totals,
  PortfolioSnapshot,
} from '@consolidate/shared';

export type { EnrichedPosition, Totals, PortfolioSnapshot };

// ─────────────────────────────────────────────────────────────
// Hot path (GET /portfolio) reads exclusively from DB (positions,
// prices, fx_rates, cash, trades). refreshBinance/refreshPrices run
// from the cron (or an explicit ?refresh=1) so the dashboard can poll
// without hammering Binance.
// ─────────────────────────────────────────────────────────────

async function tradesBySymbol(platform: Platform): Promise<Map<string, TradeRow[]>> {
  const { rows } = await pool.query<TradeRow>(
    'SELECT * FROM trades WHERE platform = $1 ORDER BY ts ASC',
    [platform],
  );
  const map = new Map<string, TradeRow[]>();
  for (const r of rows) {
    const arr = map.get(r.symbol) ?? [];
    arr.push(r);
    map.set(r.symbol, arr);
  }
  return map;
}

const STOCK_META: Record<string, { name: string; sector: string }> = {
  NVDA: { name: 'NVIDIA Corp', sector: 'Semis' },
  GOOGL: { name: 'Alphabet Inc Cl A', sector: 'Tech' },
  AAPL: { name: 'Apple Inc', sector: 'Tech' },
  MSFT: { name: 'Microsoft Corp', sector: 'Tech' },
  TSLA: { name: 'Tesla Inc', sector: 'Auto' },
  AMZN: { name: 'Amazon.com Inc', sector: 'Retail' },
  VOO: { name: 'Vanguard S&P 500', sector: 'ETF' },
};
const CRYPTO_META: Record<string, { name: string; sector: string }> = {
  BTC: { name: 'Bitcoin', sector: 'Crypto' },
  ETH: { name: 'Ethereum', sector: 'Crypto' },
  SOL: { name: 'Solana', sector: 'Crypto' },
  DOGE: { name: 'Dogecoin', sector: 'Crypto' },
  XRP: { name: 'Ripple', sector: 'Crypto' },
  ADA: { name: 'Cardano', sector: 'Crypto' },
  USDT: { name: 'Tether', sector: 'Stable' },
  USDC: { name: 'USD Coin', sector: 'Stable' },
};

function enrich(row: {
  platform: Platform;
  symbol: string;
  qty: number;
  avgUSD: number;
  priceUSD: number;
  costTHB: number;
  marketFX: number;
  meta?: { name?: string; sector?: string } | null;
  realizedUSD?: number;
  realizedTHB?: number;
  fifoCostUSD?: number;
  fifoCostTHB?: number;
}): EnrichedPosition {
  const { qty, avgUSD, priceUSD, costTHB, marketFX } = row;
  const marketUSD = qty * priceUSD;
  const costUSD = qty * avgUSD;
  const pnlUSD = marketUSD - costUSD;
  const pnlPct = costUSD > 0 ? (pnlUSD / costUSD) * 100 : 0;
  const marketTHB = marketUSD * marketFX;
  const pnlTHB = marketTHB - costTHB;
  const pnlPctTHB = costTHB > 0 ? (pnlTHB / costTHB) * 100 : 0;
  const fxLocked = costUSD > 0 ? costTHB / costUSD : marketFX;
  const fxContribTHB = costUSD * (marketFX - fxLocked);
  return {
    platform: row.platform,
    symbol: row.symbol,
    name: row.meta?.name ?? null,
    sector: row.meta?.sector ?? null,
    qty,
    avgUSD,
    priceUSD,
    fxLocked,
    marketUSD,
    costUSD,
    pnlUSD,
    pnlPct,
    marketTHB,
    costTHB,
    pnlTHB,
    pnlPctTHB,
    fxContribTHB,
    realizedUSD: row.realizedUSD ?? 0,
    realizedTHB: row.realizedTHB ?? 0,
    fifoCostUSD: row.fifoCostUSD ?? costUSD,
    fifoCostTHB: row.fifoCostTHB ?? costTHB,
  };
}

const ZERO_TOTALS: Totals = {
  marketUSD: 0,
  marketTHB: 0,
  costUSD: 0,
  costTHB: 0,
  pnlUSD: 0,
  pnlTHB: 0,
  fxContribTHB: 0,
  realizedUSD: 0,
  realizedTHB: 0,
  realizedFxContribTHB: 0,
};

function sumTotals(rows: EnrichedPosition[], realized?: RealizedTotals): Totals {
  const t = rows.reduce<Totals>(
    (a, p) => ({
      ...a,
      marketUSD: a.marketUSD + p.marketUSD,
      marketTHB: a.marketTHB + p.marketTHB,
      costUSD: a.costUSD + p.costUSD,
      costTHB: a.costTHB + p.costTHB,
      pnlUSD: a.pnlUSD + p.pnlUSD,
      pnlTHB: a.pnlTHB + p.pnlTHB,
      fxContribTHB: a.fxContribTHB + p.fxContribTHB,
    }),
    { ...ZERO_TOTALS },
  );
  if (realized) {
    t.realizedUSD = realized.realizedUSD;
    t.realizedTHB = realized.realizedTHB;
    t.realizedFxContribTHB = realized.realizedFxContribTHB;
  }
  return t;
}

interface RealizedTotals {
  realizedUSD: number;
  realizedTHB: number;
  realizedFxContribTHB: number;
}

function sumRealized(...rs: RealizedTotals[]): RealizedTotals {
  return rs.reduce<RealizedTotals>(
    (a, r) => ({
      realizedUSD: a.realizedUSD + r.realizedUSD,
      realizedTHB: a.realizedTHB + r.realizedTHB,
      realizedFxContribTHB: a.realizedFxContribTHB + r.realizedFxContribTHB,
    }),
    { realizedUSD: 0, realizedTHB: 0, realizedFxContribTHB: 0 },
  );
}

// Walk every symbol (regardless of current qty) so fully-sold-out
// positions still contribute to realized totals.
function realizedAcrossSymbols(tradeMap: Map<string, TradeRow[]>): RealizedTotals {
  let realizedUSD = 0;
  let realizedTHB = 0;
  let realizedFxContribTHB = 0;
  for (const trades of tradeMap.values()) {
    const a = aggregateTrades(trades);
    realizedUSD += a.realizedUSD;
    realizedTHB += a.realizedTHB;
    realizedFxContribTHB += a.realizedFxContribTHB;
  }
  return { realizedUSD, realizedTHB, realizedFxContribTHB };
}

async function upsertPosition(p: EnrichedPosition): Promise<void> {
  await pool.query(
    `INSERT INTO positions(platform, symbol, name, qty, avg_cost_usd, cost_basis_thb, sector, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (platform, symbol) DO UPDATE SET
       name = EXCLUDED.name,
       qty = EXCLUDED.qty,
       avg_cost_usd = EXCLUDED.avg_cost_usd,
       cost_basis_thb = EXCLUDED.cost_basis_thb,
       sector = EXCLUDED.sector,
       updated_at = EXCLUDED.updated_at`,
    [p.platform, p.symbol, p.name, p.qty, p.avgUSD, p.costTHB, p.sector, Date.now()],
  );
}

// Expensive — calls Binance. Only from cron / explicit refresh.
//
// Stablecoins are NOT written as crypto positions. They're treated as
// USD-equivalent cash: every stable asset's balance contributes to a
// single synthesized "Binance USDT cash" row (symbol='USDT', sector=
// 'Cash'). The deposits ledger carries the FX-locked principal that
// funded the cash; the cash row itself is cost==market so it doesn't
// drag PNL up or down. Mirrors buildDimeCashRow's "no FX gain on idle
// USD" choice — see project_realized_pnl.md.
export async function refreshBinance(marketFX: number): Promise<EnrichedPosition[]> {
  const live = await fetchBinancePositions();
  const tradeMap = await tradesBySymbol('Binance');
  const out: EnrichedPosition[] = [];
  let stableUSD = 0;
  for (const pos of live) {
    if (pos.qty <= 0 || pos.priceUSD <= 0) continue;
    if (isStable(pos.asset)) {
      stableUSD += pos.qty * pos.priceUSD;
      continue;
    }
    const trades = tradeMap.get(pos.asset) ?? [];
    const agg = aggregateTrades(trades);
    const qty = pos.qty;
    const avgUSD = agg.qty > 0 ? agg.avgUSD : pos.priceUSD;
    const costTHB = agg.qty > 0 ? agg.costTHB * (qty / agg.qty) : qty * avgUSD * marketFX;
    const meta = CRYPTO_META[pos.asset];
    const enriched = enrich({
      platform: 'Binance',
      symbol: pos.asset,
      qty,
      avgUSD,
      priceUSD: pos.priceUSD,
      costTHB,
      marketFX,
      meta,
      realizedUSD: agg.realizedUSD,
      realizedTHB: agg.realizedTHB,
    });
    await upsertPosition(enriched);
    out.push(enriched);
  }

  if (stableUSD > 0.005) {
    const cash = enrich({
      platform: 'Binance',
      symbol: 'USDT',
      qty: stableUSD,
      avgUSD: 1,
      priceUSD: 1,
      costTHB: stableUSD * marketFX,
      marketFX,
      meta: { name: 'Binance USDT cash', sector: 'Cash' },
    });
    await upsertPosition(cash);
    out.push(cash);
  } else {
    // Balance went to zero — clear any prior synth row so it doesn't linger.
    await pool.query("DELETE FROM positions WHERE platform = 'Binance' AND symbol = 'USDT'");
  }
  return out;
}

// Synthesize a DIME USD-cash row only when sells genuinely exceed buys
// (i.e. the user is actually holding idle USD inside the DIME settlement
// account). DIME holds THB by default and converts on each BUY, so
// deposits do NOT translate into a USD balance — modelling them that way
// over-counted by ~$1.3k against the DIME app. Net residue is computed
// purely from trades: `usd = sum(SELL.usd) − sum(BUY.usd)`. If positive,
// emit a cash row with cost = today's FX (we don't track when each
// proceeds-USD was held, so no FX gain is implied).
function buildDimeCashRow(
  tradeMap: Map<string, TradeRow[]>,
  marketFX: number,
): EnrichedPosition | null {
  let usd = 0;
  for (const trades of tradeMap.values()) {
    for (const t of trades) {
      if (t.side === 'BUY') usd -= t.qty * t.price_usd;
      else if (t.side === 'SELL') usd += t.qty * t.price_usd;
    }
  }
  if (usd <= 0.005) return null; // no idle USD — buys absorbed all sell proceeds
  const marketTHB = usd * marketFX;
  return {
    platform: 'DIME',
    symbol: 'USD',
    name: 'DIME USD wallet',
    sector: 'Cash',
    qty: usd,
    avgUSD: 1,
    priceUSD: 1,
    fxLocked: marketFX,
    marketUSD: usd,
    costUSD: usd,
    pnlUSD: 0,
    pnlPct: 0,
    marketTHB,
    costTHB: marketTHB,
    pnlTHB: 0,
    pnlPctTHB: 0,
    fxContribTHB: 0,
    realizedUSD: 0,
    realizedTHB: 0,
    fifoCostUSD: usd,
    fifoCostTHB: marketTHB,
  };
}

// Recompute DIME positions from trades. Cheap (DB-only) so safe on hot path.
async function readDimePositions(
  marketFX: number,
): Promise<{ positions: EnrichedPosition[]; tradeMap: Map<string, TradeRow[]> }> {
  const tradeMap = await tradesBySymbol('DIME');

  // Aggregate all symbols first so we know which are active, then batch
  // fetch their prices in one query instead of one query per symbol.
  const aggs = new Map<string, ReturnType<typeof aggregateTrades>>();
  for (const [symbol, trades] of tradeMap) aggs.set(symbol, aggregateTrades(trades));
  const activeSymbols = [...aggs.entries()].filter(([, a]) => a.qty > 0).map(([s]) => s);
  const priceMap = await getCachedPrices(activeSymbols);

  const out: EnrichedPosition[] = [];
  for (const [symbol, trades] of tradeMap) {
    const agg = aggs.get(symbol)!
    if (agg.qty <= 0) continue;
    const cached = priceMap.get(symbol);
    const priceUSD = cached?.price_usd ?? agg.avgUSD;
    const meta = STOCK_META[symbol];
    const fifo = aggregateTradesFIFO(trades);
    const enriched = enrich({
      platform: 'DIME',
      symbol,
      qty: agg.qty,
      avgUSD: agg.avgUSD,
      priceUSD,
      costTHB: agg.costTHB,
      marketFX,
      meta,
      realizedUSD: agg.realizedUSD,
      realizedTHB: agg.realizedTHB,
      fifoCostUSD: fifo.fifoCostUSD,
      fifoCostTHB: fifo.fifoCostTHB,
    });
    await upsertPosition(enriched);
    out.push(enriched);
  }
  const cash = buildDimeCashRow(tradeMap, marketFX);
  if (cash) out.push(cash);
  return { positions: out, tradeMap };
}

// Read on-chain positions written by the cron (refreshOnChainWLD). No
// trades exist for on-chain rows — cost basis lives in the positions
// table directly (set from ONCHAIN_WLD_COST_USD env). Realized PNL is
// always 0 since we don't model on-chain SELLs (yet).
async function readOnChainPositionsFromDb(marketFX: number): Promise<EnrichedPosition[]> {
  const { rows } = await pool.query<PositionRow>(
    "SELECT * FROM positions WHERE platform = 'OnChain'",
  );
  const priceMap = await getCachedPrices(rows.map((p) => p.symbol));
  const out: EnrichedPosition[] = [];
  for (const p of rows) {
    const cached = priceMap.get(p.symbol);
    const priceUSD = cached?.price_usd ?? p.avg_cost_usd;
    out.push(
      enrich({
        platform: 'OnChain',
        symbol: p.symbol,
        qty: p.qty,
        avgUSD: p.avg_cost_usd,
        priceUSD,
        costTHB: p.cost_basis_thb,
        marketFX,
        meta: { name: p.name ?? undefined, sector: p.sector ?? undefined },
      }),
    );
  }
  return out;
}

async function readBinancePositionsFromDb(
  marketFX: number,
  tradeMap: Map<string, TradeRow[]>,
): Promise<EnrichedPosition[]> {
  const { rows } = await pool.query<PositionRow>(
    "SELECT * FROM positions WHERE platform = 'Binance'",
  );
  // Stable rows are the synthesized cash row from refreshBinance — they
  // have no trade history (USDT is a quote asset, not a base) so we
  // skip the price/trade lookups entirely.
  const cryptoSymbols = rows.filter((p) => !isStable(p.symbol)).map((p) => p.symbol);
  const priceMap = await getCachedPrices(cryptoSymbols);
  const out: EnrichedPosition[] = [];
  for (const p of rows) {
    if (isStable(p.symbol)) {
      out.push(
        enrich({
          platform: 'Binance',
          symbol: p.symbol,
          qty: p.qty,
          avgUSD: 1,
          priceUSD: 1,
          costTHB: p.cost_basis_thb,
          marketFX,
          meta: { name: 'Binance USDT cash', sector: 'Cash' },
        }),
      );
      continue;
    }
    const cached = priceMap.get(p.symbol);
    const priceUSD = cached?.price_usd ?? p.avg_cost_usd;
    const agg = aggregateTrades(tradeMap.get(p.symbol) ?? []);
    out.push(
      enrich({
        platform: 'Binance',
        symbol: p.symbol,
        qty: p.qty,
        avgUSD: p.avg_cost_usd,
        priceUSD,
        costTHB: p.cost_basis_thb,
        marketFX,
        meta: CRYPTO_META[p.symbol],
        realizedUSD: agg.realizedUSD,
        realizedTHB: agg.realizedTHB,
      }),
    );
  }
  return out;
}

export async function buildBankPositions(): Promise<EnrichedPosition[]> {
  const { rows } = await pool.query<{
    platform: Platform;
    label: string;
    amount_thb: number;
    amount_usd: number;
  }>('SELECT platform, label, amount_thb, amount_usd FROM cash');
  return rows.map((r) => ({
    platform: 'Bank',
    symbol: r.platform,
    name: r.label,
    sector: 'Cash',
    qty: 1,
    avgUSD: 0,
    priceUSD: 0,
    fxLocked: r.amount_usd > 0 ? r.amount_thb / r.amount_usd : 0,
    marketUSD: r.amount_usd,
    costUSD: r.amount_usd,
    pnlUSD: 0,
    pnlPct: 0,
    marketTHB: r.amount_thb,
    costTHB: r.amount_thb,
    pnlTHB: 0,
    pnlPctTHB: 0,
    fxContribTHB: 0,
    realizedUSD: 0,
    realizedTHB: 0,
    fifoCostUSD: r.amount_usd,
    fifoCostTHB: r.amount_thb,
  }));
}

export async function buildSnapshot(opts: { refresh?: boolean } = {}): Promise<PortfolioSnapshot> {
  const fx = await getUSDTHB(false);

  if (opts.refresh) {
    try {
      const { rows: dimeSymbols } = await pool.query<{ symbol: string }>(
        "SELECT DISTINCT symbol FROM trades WHERE platform = 'DIME'",
      );
      const { rows: binanceSymbols } = await pool.query<{ symbol: string }>(
        "SELECT DISTINCT symbol FROM trades WHERE platform = 'Binance'",
      );
      await refreshPrices({
        stocks: dimeSymbols.map((r) => r.symbol),
        crypto: binanceSymbols.map((r) => r.symbol),
      });
      await refreshBinance(fx.rate).catch((e) =>
        console.warn('[portfolio] binance refresh failed:', (e as Error).message),
      );
    } catch (e) {
      console.warn('[portfolio] refresh failed:', (e as Error).message);
    }
  }

  const dimeRes = await readDimePositions(fx.rate);
  const dime = dimeRes.positions;
  const binanceTrades = await tradesBySymbol('Binance');
  const binance = await readBinancePositionsFromDb(fx.rate, binanceTrades);
  const bank = await buildBankPositions();
  const onchain = await readOnChainPositionsFromDb(fx.rate);

  const dimeRealized = realizedAcrossSymbols(dimeRes.tradeMap);
  const binanceRealized = realizedAcrossSymbols(binanceTrades);
  const allRealized = sumRealized(dimeRealized, binanceRealized);

  const totals = {
    dime: sumTotals(dime, dimeRealized),
    binance: sumTotals(binance, binanceRealized),
    bank: sumTotals(bank),
    onchain: sumTotals(onchain),
    all: sumTotals([...dime, ...binance, ...bank, ...onchain], allRealized),
  };

  return {
    fx: { usdthb: fx.rate, ts: fx.ts },
    positions: { dime, binance, bank, onchain },
    totals,
    asOf: Date.now(),
  };
}
