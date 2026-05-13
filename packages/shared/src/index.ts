export type Platform = 'DIME' | 'Binance' | 'Bank' | 'OnChain';
export type TradeSide = 'BUY' | 'SELL' | 'DIV';

export interface TradeRow {
  id: number;
  platform: Platform;
  symbol: string;
  side: TradeSide;
  qty: number;
  price_usd: number;
  fx_at_trade: number;
  commission: number;
  ts: number;
  external_id: string | null;
  source: string | null;
}

export interface EnrichedPosition {
  platform: Platform;
  symbol: string;
  name: string | null;
  sector: string | null;
  qty: number;
  avgUSD: number;
  priceUSD: number;
  fxLocked: number;
  marketUSD: number;
  costUSD: number;
  pnlUSD: number;
  pnlPct: number;
  marketTHB: number;
  costTHB: number;
  pnlTHB: number;
  pnlPctTHB: number;
  fxContribTHB: number;
  realizedUSD: number;
  realizedTHB: number;
  // FIFO cost basis of currently-held shares — what the DIME app shows
  // as "Total cost" / "Cost per Share". Falls back to weighted-avg cost
  // (=costUSD) when there's no SELL history to disambiguate.
  fifoCostUSD: number;
  fifoCostTHB: number;
}

export interface Totals {
  marketUSD: number;
  marketTHB: number;
  costUSD: number;
  costTHB: number;
  pnlUSD: number;             // unrealized USD (currently held)
  pnlTHB: number;              // unrealized THB (currently held)
  fxContribTHB: number;        // unrealized FX contribution
  realizedUSD: number;         // realized USD across all SELLs (lifetime)
  realizedTHB: number;         // realized THB across all SELLs (lifetime)
  realizedFxContribTHB: number; // FX-only portion of realized THB
}

export interface PortfolioSnapshot {
  fx: { usdthb: number; ts: number };
  positions: {
    dime: EnrichedPosition[];
    binance: EnrichedPosition[];
    bank: EnrichedPosition[];
    onchain: EnrichedPosition[];
  };
  totals: {
    dime: Totals;
    binance: Totals;
    bank: Totals;
    onchain: Totals;
    all: Totals;
  };
  // Lifetime realized PNL keyed by ticker, summed across DIME + Binance.
  // Lets the UI compute symbol-level net PNL (unrealized + realized) even
  // when one platform fully closed the position and dropped out of
  // `positions` — e.g. WLD: -$71.63 realized on Binance + +$72.81
  // unrealized on OnChain = ~$1.18 net, not the misleading +$72.81 alone.
  realizedBySymbol: Record<string, { realizedUSD: number; realizedTHB: number }>;
  asOf: number;
}

export interface ImportSummary {
  platform: Platform;
  total: number;
  imported: number;
  skipped: number;
  errors: { row: number; error: string }[];
}

export interface DividendRow {
  id: number;
  platform: Platform;
  symbol: string;
  amount_usd: number;
  fx: number;
  ts: number;
}

export type Currency = 'USD' | 'THB' | 'USDT';
