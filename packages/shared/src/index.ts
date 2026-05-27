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

// ─── External bot events (snapback-btc and future bots) ──────────────────────
// The bot is the source of truth; the API logs events as they arrive.
// Kinds map 1:1 to what the bot records in its own state.db events table.

export type BotEventKind =
  | 'boot'                 // bot started; payload has env, dry_run, strategy_name, deploy_start_equity
  | 'heartbeat'            // periodic ping; payload has equity, halt_present — bot pushes this; API caches in-memory
  | 'heartbeat_snapshot'   // hourly persisted heartbeat row written by the API for equity history; bot never sends this kind
  | 'dry_run_signal'       // signal fired but no order placed (DRY_RUN); has signal_id, side, price, sl, tp
  | 'entry'                // live entry placed; has signal_id, side, qty, fill_price
  | 'exit'                 // position closed (time-stop / boot-flatten / HALT / kill-switch); has signal_id
  | 'kill_switch'          // kill-switch fired; bot will HALT
  | 'halt'                 // HALT file detected; bot exiting
  | 'boot_flatten'         // bot found open position at boot, flattened it
  | 'order_failed'         // exchange rejected an order; has error msg in payload
  | 'signal_skipped';      // signal fired but skipped (e.g. below exchange minimums)

export interface BotEventPayload {
  source: string;                // e.g. 'snapback-btc' — distinguishes if multiple bots ever exist
  external_id: string;           // bot-side monotonic id; (source, external_id) is the dedup key
  bot_ts_ms: number;             // ms epoch from the bot's clock when the event occurred
  kind: BotEventKind;
  signal_id?: string | null;     // snap-v1-<root> for tradeable events
  strategy?: string | null;      // 'multifactor-v1' etc.
  side?: 'long' | 'short' | null;
  qty?: number | null;
  price_usd?: number | null;
  notional_usd?: number | null;
  equity_usd?: number | null;
  payload?: Record<string, unknown>;
}

export interface BotEventRow extends BotEventPayload {
  id: number;
  received_at: number;
}

// Snapshot of the bot's signal-evaluator gate state — answers "what is
// currently true and what is it waiting for?". Pushed by the bot on every
// heartbeat as `payload.gates`. Stable JSON shape across strategies, even
// if the specific gate names differ.
export interface GateStatus {
  strategy: string;
  would_fire: 'long' | 'short' | null;
  // Per-strategy diagnostic values. Mostly numeric (RSI, price, slope, etc.),
  // but some strategies surface non-numeric state here — e.g. cnh-hybrid-short-v1
  // ships `last_admitted_pattern` (dict snapshot) and `pattern_fired` (string).
  // `fmtGateValue` in apps/web/src/lib/gates.ts handles all three shapes.
  values: Record<string, number | string | Record<string, unknown> | null>;
  thresholds: Record<string, number | boolean | null>;
  gates_long: Record<string, boolean>;
  gates_short: Record<string, boolean>;
  missing_long: string[];
  missing_short: string[];
  waiting_for: string;
}

export interface BotStatus {
  source: string;
  // Most recent boot event — defines current bot identity
  boot: {
    ts: number;
    env: string;                 // 'mainnet' | 'testnet'
    dry_run: boolean;
    strategy_name: string | null;
    commit: string | null;
  } | null;
  // Most recent heartbeat
  lastHeartbeatTs: number | null;
  heartbeatAgeS: number | null;  // (now - lastHeartbeat) / 1000
  // Last known equity + kill switch
  currentEquityUsd: number | null;
  deployStartEquityUsd: number | null;
  killSwitchLevelUsd: number | null;
  killSwitchHeadroomPct: number | null;
  // Status verdict: green / yellow / red
  health: 'healthy' | 'stale' | 'down' | 'unknown';
  isHalted: boolean;
  // Last few events for context
  recentEvents: BotEventRow[];
  // Current gate state from the most recent heartbeat with gates in payload.
  // Null until the bot has been upgraded to push gate snapshots.
  gates: GateStatus | null;
  // Lifetime counters
  totals: {
    entries: number;
    exits: number;
    dryRunSignals: number;
    killSwitchFires: number;
  };
}
