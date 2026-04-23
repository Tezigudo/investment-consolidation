export type Platform = 'DIME' | 'Binance' | 'Bank';
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
}

export interface Totals {
  marketUSD: number;
  marketTHB: number;
  costUSD: number;
  costTHB: number;
  pnlUSD: number;
  pnlTHB: number;
  fxContribTHB: number;
}

export interface PortfolioSnapshot {
  fx: { usdthb: number; ts: number };
  positions: {
    dime: EnrichedPosition[];
    binance: EnrichedPosition[];
    bank: EnrichedPosition[];
  };
  totals: {
    dime: Totals;
    binance: Totals;
    bank: Totals;
    all: Totals;
  };
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
