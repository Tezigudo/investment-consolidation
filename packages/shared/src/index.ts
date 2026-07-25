export type Platform = 'DIME' | 'Binance' | 'Bank' | 'OnChain' | 'Futures';
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
  // Optional as-of timestamp (ms since epoch) for synthesized rows sourced
  // from a periodic snapshot rather than live trade data — e.g. the Futures
  // "Bot equity" row, whose value is the latest hourly futures_account_snapshot.
  // Lets the UI render "as of Xh ago" without a staleness cutoff. Undefined
  // for all trade-derived rows.
  asOf?: number | null;
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
    // Snapback trading bots' futures equity, synthesized as a single cash-like
    // "Bot equity" row from the latest futures_account_snapshot (margin_usd).
    // Empty when no snapshot exists.
    futures: EnrichedPosition[];
  };
  totals: {
    dime: Totals;
    binance: Totals;
    bank: Totals;
    onchain: Totals;
    // Futures bot equity bucket. Zeroed when no snapshot exists, so `all`
    // stays identical to the pre-futures total in that state.
    futures: Totals;
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
  | 'signal_skipped'       // signal fired but skipped (e.g. below exchange minimums)
  | 'daily_loss_breaker';  // intraday drawdown hit MAX_DAILY_LOSS_PCT; new entries blocked until next UTC day

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

// ─── Binance USDT-M Futures analytics ────────────────────────────────────────
// Two data sources, kept DISTINCT on purpose (see CLAUDE.md "both sources"):
//   - "account" = ground truth from the Binance futures account the
//     consolidate API key belongs to (fapi /v3/account, /v1/income,
//     /v2/positionRisk). Reflects ALL futures activity on that account, not
//     only the snapback bot's. Requires a futures-enabled read-only key.
//   - "bot"     = per-leg attribution synthesized from bot_events (entry→exit
//     pairs + hourly heartbeat equity). What the snapback legs actually did.
// These MAY be different accounts — the consolidate key might not be the bot's
// account. The UI shows them side-by-side and never assumes equality. The
// account side degrades to available=false when no futures key is configured;
// the bot side always works (it reads bot_events). All monetary values USDT.

export type FuturesIncomeType =
  | 'REALIZED_PNL'
  | 'FUNDING_FEE'
  | 'COMMISSION'
  | 'TRANSFER'
  | 'OTHER';

export interface FuturesPosition {
  symbol: string;
  positionSide: string;        // BOTH / LONG / SHORT
  positionAmt: number;         // signed; < 0 = short
  entryPrice: number;
  markPrice: number;
  unrealizedPnlUsd: number;
  leverage: number;
  liquidationPrice: number | null;
  notionalUsd: number;         // |positionAmt| × markPrice
  updatedAt: number;           // ms
  // Resting reduce-only bracket orders on the account (Tier 2 — the droplet
  // relay fetches /fapi/v1/openOrders and matches SL=STOP_MARKET,
  // TP=TAKE_PROFIT_MARKET by symbol). null when none placed / not fetched.
  // ACCOUNT-level: the relay reads ONE account, and futures_positions is keyed
  // by symbol (one BTC row) — for per-LEG SL/TP that survives that collision,
  // see FuturesBotLegStats.openExit (synthesized from each leg's own telemetry).
  slPriceUsd?: number | null;
  tpPriceUsd?: number | null;
}

export interface FuturesEquityPoint {
  ts: number;                  // ms
  walletBalanceUsd: number;
  marginBalanceUsd: number;    // wallet + unrealized
}

export interface FuturesIncomeBucket {
  day: string;                 // YYYY-MM-DD (UTC)
  realizedPnlUsd: number;
  fundingUsd: number;          // net signed: + received, − paid
  commissionUsd: number;       // signed (negative = paid)
  netUsd: number;              // realized + funding + commission
}

export interface FuturesAccountSummary {
  available: boolean;          // false when no futures key / key lacks perms
  asOf: number | null;         // ms of latest account snapshot, null if none
  walletBalanceUsd: number | null;
  marginBalanceUsd: number | null;
  unrealizedPnlUsd: number | null;
  availableBalanceUsd: number | null;
  // Aggregated over the loaded income window:
  realizedPnlUsd: number;
  realizedBySymbol: Record<string, number>; // realized PnL per symbol (bot=BTC vs manual alts)
  fundingPaidUsd: number;      // sum of funding PAID, reported as a positive number
  fundingReceivedUsd: number;  // sum of funding RECEIVED, positive
  fundingNetUsd: number;       // received − paid (signed)
  commissionUsd: number;       // total commission paid, positive number
  netIncomeUsd: number;        // realized + fundingNet − commission
}

/** The symbol(s) the trading bot trades. Realized PnL on these is "bot"; any
 * other symbol on the account is manual/discretionary. Keep in sync with the
 * bots' traded symbols.
 *
 * NOTE (2026-07-25): the old comment here claimed "both bot legs are BTC-only,
 * so non-bot symbols on that account are hand trades". That is no longer true —
 * the sol_supertrend leg trades SOLUSDT. It runs in its OWN sub-account, which
 * the relay does not currently read, so no SOLUSDT rows reach this code today;
 * SOLUSDT is listed anyway so that the day the relay does see that account, a
 * bot-traded alt is never mislabelled a hand trade. Adding a symbol here is
 * safe in the other direction too: it only excludes rows from the "manual"
 * bucket, and there are no SOLUSDT rows in the relay's account to exclude. */
export const BOT_SYMBOLS = ['BTCUSDT', 'SOLUSDT'] as const;

/** True if a symbol is one the trading bot trades (→ a bot position/trade);
 * false = a manual/discretionary trade on the same account. Single source of
 * truth for the bot-vs-manual distinction across realized PnL and positions. */
export function isBotSymbol(
  symbol: string,
  botSymbols: readonly string[] = BOT_SYMBOLS,
): boolean {
  return botSymbols.includes(symbol);
}

export interface RealizedSplit {
  botUsd: number;           // realized on bot symbols (BTC)
  manualUsd: number;        // realized on every other symbol
  manualSymbols: string[];  // sorted non-bot symbols that had realized PnL
  hasManual: boolean;       // true when any non-bot symbol had realized activity
}

/** Split a per-symbol realized map into bot (BTC) vs manual (everything else),
 * so the dashboard can show WHY a red Realized figure isn't the bot losing. */
export function splitRealizedBySymbol(
  realizedBySymbol: Record<string, number>,
  botSymbols: readonly string[] = BOT_SYMBOLS,
): RealizedSplit {
  let botUsd = 0;
  let manualUsd = 0;
  const manualSymbols: string[] = [];
  for (const [sym, usd] of Object.entries(realizedBySymbol)) {
    if (isBotSymbol(sym, botSymbols)) {
      botUsd += usd;
    } else {
      manualUsd += usd;
      if (usd !== 0) manualSymbols.push(sym);
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    botUsd: r2(botUsd),
    manualUsd: r2(manualUsd),
    manualSymbols: manualSymbols.sort(),
    hasManual: manualSymbols.length > 0,
  };
}

// The pending exit of an OPEN bot trade: where it stops, and when the
// time-stop force-closes it. Reconstructed from the entry event's telemetry
// (sl_price/tp_price for market entries, or fill ± sl_distance/tp_distance for
// the live LIMIT legs) plus a per-strategy hold-window map. null on closed
// trades. NOTE: barsLeft is the OUTER ceiling (the max-hold time-stop), NOT an
// ETA — most trades exit far sooner via the bracket or channel condition.
export interface FuturesExitPlan {
  slPriceUsd: number | null;
  tpPriceUsd: number | null;      // null for SL-only strategies (e.g. donchian)
  exitCondition: string | null;   // human trigger, e.g. '4h close beyond 10-bar Donchian · SL 1.5×ATR'
  maxHoldBars: number | null;     // time-stop ceiling, in entry-TF bars
  barsHeld: number | null;        // entry-TF bars elapsed since entry
  barsLeft: number | null;        // max(0, maxHoldBars − barsHeld)
  barMs: number | null;           // entry-bar duration (ms) — lets the UI render bars as time
}

// Per-leg attribution from bot_events: pair each entry with its next exit.
export interface FuturesBotTrade {
  source: string;              // bot source (leg), e.g. 'snapback-btc-cnh-short'
  strategy: string | null;
  side: 'long' | 'short' | null;
  entryTs: number;
  exitTs: number | null;       // null = still open
  entryPriceUsd: number | null;
  exitPriceUsd: number | null;
  qty: number | null;
  notionalUsd: number | null;
  pnlUsd: number | null;       // equity-delta if available, else price move × qty
  exitReason: string | null;
  exitPlan: FuturesExitPlan | null;  // pending exit (open trades only; null once closed)
}

export interface FuturesBotLegStats {
  source: string;
  strategy: string | null;
  trades: number;              // closed trades
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnlUsd: number;
  currentEquityUsd: number | null;
  isHalted: boolean;
  openTrade: boolean;          // an entry without a matching exit
  // The open trade's pending exit (SL/TP + condition + bars-left), carried on
  // the leg so per-leg SL/TP/exit is displayable without the account position
  // row (which can't be leg-attributed — see FuturesPosition). null when flat.
  openExit: FuturesExitPlan | null;
}

/** Per-symbol rollup of MANUAL (non-bot) futures activity on the account — the
 * hand-traded alt positions that share the account with the BTC bot. Realized /
 * funding / fees come from the income ledger over the loaded window; `open` is
 * the live position (side/entry/mark/uPnL/SL/TP) when the symbol is currently
 * held, null when flat. NOTE: `realizedEvents` counts REALIZED_PNL ledger rows
 * (partial fills inflate it) — it is NOT a clean round-trip trade count, and
 * there is deliberately NO win-rate here: manual trades leave no entry/exit
 * events to pair (unlike the bot legs), so a trade-level win rate would be
 * fabricated. */
export interface ManualSymbolStats {
  symbol: string;
  realizedPnlUsd: number;         // Σ REALIZED_PNL on this symbol (window)
  fundingNetUsd: number;          // Σ funding, signed (+ received, − paid)
  commissionUsd: number;          // commission paid, positive
  netUsd: number;                 // realized + fundingNet − commission
  realizedEvents: number;         // # of REALIZED_PNL rows (≈ closes; not clean trades)
  lastActivityTs: number | null;  // ms of most recent income row, null if none
  open: FuturesPosition | null;   // live open position, null when flat
}

export interface FuturesReconciliation {
  futuresWalletUsd: number | null;
  botEquityTotalUsd: number | null;
  deltaUsd: number | null;
  likelySameAccount: boolean | null;  // |delta| small vs wallet
  note: string;
}

export interface FuturesAnalytics {
  generatedAt: number;
  rangeDays: number;
  // ── Account side (Binance ground truth; may be empty/disabled) ──
  account: FuturesAccountSummary;
  equityCurve: FuturesEquityPoint[];   // from futures_account_snapshot
  incomeByDay: FuturesIncomeBucket[];  // realized / funding / commission per day
  positions: FuturesPosition[];        // current open futures positions
  manualTrades: ManualSymbolStats[];   // per-symbol MANUAL (non-bot) activity + live open status
  // ── Bot side (always available from bot_events) ──
  botLegs: FuturesBotLegStats[];
  botTrades: FuturesBotTrade[];
  botEquityCurve: { ts: number; equityUsd: number; source: string }[];
  // ── Reconciliation (Phase 2; null until built) ──
  reconciliation: FuturesReconciliation | null;
}
