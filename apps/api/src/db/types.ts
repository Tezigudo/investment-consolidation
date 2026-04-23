// Re-export shared domain types; keep DB-row-only types local.
export type { Platform, TradeSide, TradeRow } from '@consolidate/shared';

export interface DepositRow {
  id: number;
  platform: import('@consolidate/shared').Platform;
  amount_thb: number;
  amount_usd: number;
  fx_locked: number;
  ts: number;
  note: string | null;
  source: string | null;
}

export interface PositionRow {
  platform: import('@consolidate/shared').Platform;
  symbol: string;
  name: string | null;
  qty: number;
  avg_cost_usd: number;
  cost_basis_thb: number;
  sector: string | null;
  updated_at: number;
}

export interface CashRow {
  platform: import('@consolidate/shared').Platform;
  label: string;
  amount_thb: number;
  amount_usd: number;
  updated_at: number;
}

export interface PriceRow {
  symbol: string;
  price_usd: number;
  source: string | null;
  ts: number;
}

export interface FxRow {
  pair: string;
  rate: number;
  source: string | null;
  ts: number;
}
