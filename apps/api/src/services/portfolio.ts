import { db } from '../db/client.js';
import { fetchBinancePositions } from './binance.js';
import { refreshPrices, getCachedPrice } from './prices.js';
import { getUSDTHB } from './fx.js';
import { aggregateTrades } from './cost-basis.js';
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

function tradesBySymbol(platform: Platform): Map<string, TradeRow[]> {
  const rows = db
    .prepare('SELECT * FROM trades WHERE platform = ? ORDER BY ts ASC')
    .all(platform) as TradeRow[];
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

function upsertPosition(p: EnrichedPosition) {
  db.prepare(
    `INSERT INTO positions(platform, symbol, name, qty, avg_cost_usd, cost_basis_thb, sector, updated_at)
     VALUES (@platform, @symbol, @name, @qty, @avgUSD, @costTHB, @sector, @ts)
     ON CONFLICT(platform, symbol) DO UPDATE SET
       name = excluded.name,
       qty = excluded.qty,
       avg_cost_usd = excluded.avg_cost_usd,
       cost_basis_thb = excluded.cost_basis_thb,
       sector = excluded.sector,
       updated_at = excluded.updated_at`,
  ).run({
    platform: p.platform,
    symbol: p.symbol,
    name: p.name,
    qty: p.qty,
    avgUSD: p.avgUSD,
    costTHB: p.costTHB,
    sector: p.sector,
    ts: Date.now(),
  });
}

// Expensive — calls Binance. Only from cron / explicit refresh.
export async function refreshBinance(marketFX: number): Promise<EnrichedPosition[]> {
  const live = await fetchBinancePositions();
  const tradeMap = tradesBySymbol('Binance');
  const out: EnrichedPosition[] = [];
  for (const pos of live) {
    if (pos.qty <= 0 || pos.priceUSD <= 0) continue;
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
    });
    upsertPosition(enriched);
    out.push(enriched);
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
  };
}

// Recompute DIME positions from trades. Cheap (DB-only) so safe on hot path.
function readDimePositions(
  marketFX: number,
): { positions: EnrichedPosition[]; tradeMap: Map<string, TradeRow[]> } {
  const tradeMap = tradesBySymbol('DIME');
  const out: EnrichedPosition[] = [];
  for (const [symbol, trades] of tradeMap) {
    const agg = aggregateTrades(trades);
    if (agg.qty <= 0) continue;
    const cached = getCachedPrice(symbol);
    const priceUSD = cached?.price_usd ?? agg.avgUSD;
    const meta = STOCK_META[symbol];
    const enriched = enrich({
      platform: 'DIME',
      symbol,
      qty: agg.qty,
      avgUSD: agg.avgUSD,
      priceUSD,
      costTHB: agg.costTHB,
      marketFX,
      meta,
    });
    upsertPosition(enriched);
    out.push(enriched);
  }
  const cash = buildDimeCashRow(tradeMap, marketFX);
  if (cash) out.push(cash);
  return { positions: out, tradeMap };
}

function readBinancePositionsFromDb(marketFX: number): EnrichedPosition[] {
  const rows = db
    .prepare("SELECT * FROM positions WHERE platform = 'Binance'")
    .all() as PositionRow[];
  return rows.map((p) => {
    const priceUSD = getCachedPrice(p.symbol)?.price_usd ?? p.avg_cost_usd;
    return enrich({
      platform: 'Binance',
      symbol: p.symbol,
      qty: p.qty,
      avgUSD: p.avg_cost_usd,
      priceUSD,
      costTHB: p.cost_basis_thb,
      marketFX,
      meta: CRYPTO_META[p.symbol],
    });
  });
}

export function buildBankPositions(): EnrichedPosition[] {
  const rows = db.prepare('SELECT * FROM cash').all() as {
    platform: Platform;
    label: string;
    amount_thb: number;
    amount_usd: number;
  }[];
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
  }));
}

export async function buildSnapshot(opts: { refresh?: boolean } = {}): Promise<PortfolioSnapshot> {
  const fx = await getUSDTHB(false);

  if (opts.refresh) {
    try {
      const dimeSymbols = db
        .prepare("SELECT DISTINCT symbol FROM trades WHERE platform = 'DIME'")
        .all() as { symbol: string }[];
      const binanceSymbols = db
        .prepare("SELECT DISTINCT symbol FROM trades WHERE platform = 'Binance'")
        .all() as { symbol: string }[];
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

  const dimeRes = readDimePositions(fx.rate);
  const dime = dimeRes.positions;
  const binance = readBinancePositionsFromDb(fx.rate);
  const bank = buildBankPositions();

  const dimeRealized = realizedAcrossSymbols(dimeRes.tradeMap);
  const binanceRealized = realizedAcrossSymbols(tradesBySymbol('Binance'));
  const allRealized = sumRealized(dimeRealized, binanceRealized);

  const totals = {
    dime: sumTotals(dime, dimeRealized),
    binance: sumTotals(binance, binanceRealized),
    bank: sumTotals(bank),
    all: sumTotals([...dime, ...binance, ...bank], allRealized),
  };

  return {
    fx: { usdthb: fx.rate, ts: fx.ts },
    positions: { dime, binance, bank },
    totals,
    asOf: Date.now(),
  };
}
