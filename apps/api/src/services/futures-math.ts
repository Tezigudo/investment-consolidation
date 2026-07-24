// Pure analytics math for futures + bot-event data. NO database, NO network —
// everything here is (rows in) → (numbers out), so it is unit-tested directly
// in futures-math.test.ts with synthetic rows. This is the verification path:
// the live fapi calls can't be exercised without a futures-enabled key, but
// the math that turns rows into the dashboard's headline numbers can.

import type {
  FuturesIncomeBucket,
  FuturesBotTrade,
  FuturesBotLegStats,
  FuturesReconciliation,
  FuturesExitPlan,
  FuturesPosition,
  ManualSymbolStats,
} from '@consolidate/shared';
import { isBotSymbol, BOT_SYMBOLS } from '@consolidate/shared';

/** UTC calendar day (YYYY-MM-DD) for a ms timestamp. */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface IncomeRow {
  incomeType: string; // REALIZED_PNL | FUNDING_FEE | COMMISSION | ...
  incomeUsd: number;  // signed exactly as Binance returns (funding < 0 = paid)
  ts: number;         // ms
  symbol?: string;    // the contract, e.g. BTCUSDT (empty for wallet transfers)
}

export interface IncomeSummary {
  realizedPnlUsd: number;
  realizedBySymbol: Record<string, number>; // realized PnL split per symbol
  fundingPaidUsd: number;      // positive magnitude of funding paid
  fundingReceivedUsd: number;  // positive magnitude of funding received
  fundingNetUsd: number;       // received − paid (signed)
  commissionUsd: number;       // total commission paid, positive
  netIncomeUsd: number;        // realized + fundingNet − commission
  byDay: FuturesIncomeBucket[];
}

/**
 * Aggregate the income ledger into totals + per-UTC-day buckets.
 *
 * Sign convention (Binance): `income` is negative when the user PAYS. So
 * funding < 0 = paid, > 0 = received; commission is always ≤ 0 (a cost).
 * We split funding into paid/received magnitudes but keep the per-day
 * `fundingUsd` and `commissionUsd` SIGNED so the daily netUsd adds up
 * without re-deriving signs downstream.
 */
export function summarizeIncome(rows: IncomeRow[]): IncomeSummary {
  let realizedPnlUsd = 0;
  const realizedBySymbol: Record<string, number> = {};
  let fundingPaidUsd = 0;
  let fundingReceivedUsd = 0;
  let commissionUsd = 0; // accumulate paid as positive

  const byDayMap = new Map<string, FuturesIncomeBucket>();
  const bucket = (day: string): FuturesIncomeBucket => {
    let b = byDayMap.get(day);
    if (!b) {
      b = { day, realizedPnlUsd: 0, fundingUsd: 0, commissionUsd: 0, netUsd: 0 };
      byDayMap.set(day, b);
    }
    return b;
  };

  for (const r of rows) {
    const day = utcDay(r.ts);
    const b = bucket(day);
    switch (r.incomeType) {
      case 'REALIZED_PNL': {
        realizedPnlUsd += r.incomeUsd;
        const sym = r.symbol || 'UNKNOWN';
        realizedBySymbol[sym] = (realizedBySymbol[sym] ?? 0) + r.incomeUsd;
        b.realizedPnlUsd += r.incomeUsd;
        b.netUsd += r.incomeUsd;
        break;
      }
      case 'FUNDING_FEE':
        if (r.incomeUsd < 0) fundingPaidUsd += -r.incomeUsd;
        else fundingReceivedUsd += r.incomeUsd;
        b.fundingUsd += r.incomeUsd;
        b.netUsd += r.incomeUsd;
        break;
      case 'COMMISSION':
        commissionUsd += -r.incomeUsd; // income is negative → paid is positive
        b.commissionUsd += r.incomeUsd;
        b.netUsd += r.incomeUsd;
        break;
      default:
        // TRANSFER / REFERRAL_KICKBACK / etc. — not part of trading P&L, so
        // excluded from the headline net but kept out of byDay too (the chart
        // tracks trading economics, not wallet transfers).
        break;
    }
  }

  const byDay = Array.from(byDayMap.values())
    .map((b) => ({
      day: b.day,
      realizedPnlUsd: round2(b.realizedPnlUsd),
      fundingUsd: round2(b.fundingUsd),
      commissionUsd: round2(b.commissionUsd),
      netUsd: round2(b.netUsd),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const fundingNetUsd = fundingReceivedUsd - fundingPaidUsd;
  const realizedBySymbolRounded: Record<string, number> = {};
  for (const [sym, v] of Object.entries(realizedBySymbol)) realizedBySymbolRounded[sym] = round2(v);
  return {
    realizedPnlUsd: round2(realizedPnlUsd),
    realizedBySymbol: realizedBySymbolRounded,
    fundingPaidUsd: round2(fundingPaidUsd),
    fundingReceivedUsd: round2(fundingReceivedUsd),
    fundingNetUsd: round2(fundingNetUsd),
    commissionUsd: round2(commissionUsd),
    netIncomeUsd: round2(realizedPnlUsd + fundingNetUsd - commissionUsd),
    byDay,
  };
}

// ── Manual (non-bot) per-symbol rollup ──────────────────────────────────────

/**
 * Roll up MANUAL futures activity — every non-bot symbol on the account — into
 * one row per symbol, from the income ledger (realized / funding / fees over the
 * window) joined to the current open positions (live side/entry/mark/uPnL/SL/TP).
 *
 * A symbol appears if it had ANY income in the window OR is currently open, so
 * both closed hand-trades and live ones are covered. There is deliberately NO
 * win-rate: manual trades leave no paired entry/exit events (unlike bot legs),
 * so `realizedEvents` is the honest count of REALIZED_PNL ledger rows (partial
 * fills inflate it) — not a clean trade count. Bot symbols are excluded here;
 * they belong to the bot-legs attribution.
 *
 * Sort: open positions first, then most-recent activity, then symbol.
 */
export function deriveManualStats(
  income: IncomeRow[],
  positions: FuturesPosition[],
  botSymbols: readonly string[] = BOT_SYMBOLS,
): ManualSymbolStats[] {
  interface Agg {
    realized: number;
    fundingNet: number;
    commission: number; // accumulated paid as positive
    realizedEvents: number;
    lastTs: number | null;
  }
  const agg = new Map<string, Agg>();
  const bucket = (sym: string): Agg => {
    let a = agg.get(sym);
    if (!a) {
      a = { realized: 0, fundingNet: 0, commission: 0, realizedEvents: 0, lastTs: null };
      agg.set(sym, a);
    }
    return a;
  };

  for (const r of income) {
    const sym = r.symbol;
    if (!sym || isBotSymbol(sym, botSymbols)) continue; // skip transfers + bot symbols
    let touched = true;
    const a = bucket(sym);
    switch (r.incomeType) {
      case 'REALIZED_PNL':
        a.realized += r.incomeUsd;
        a.realizedEvents += 1;
        break;
      case 'FUNDING_FEE':
        a.fundingNet += r.incomeUsd;
        break;
      case 'COMMISSION':
        a.commission += -r.incomeUsd; // income is negative → paid is positive
        break;
      default:
        touched = false; // non-trading row: don't advance the activity clock
        break;
    }
    if (touched && (a.lastTs == null || r.ts > a.lastTs)) a.lastTs = r.ts;
  }

  // Index the currently-open non-bot positions by symbol.
  const openBySym = new Map<string, FuturesPosition>();
  for (const p of positions) {
    if (!isBotSymbol(p.symbol, botSymbols) && p.positionAmt !== 0) openBySym.set(p.symbol, p);
  }

  const symbols = new Set<string>([...agg.keys(), ...openBySym.keys()]);
  const out: ManualSymbolStats[] = [];
  for (const symbol of symbols) {
    const a = agg.get(symbol);
    const realized = a?.realized ?? 0;
    const fundingNet = a?.fundingNet ?? 0;
    const commission = a?.commission ?? 0;
    out.push({
      symbol,
      realizedPnlUsd: round2(realized),
      fundingNetUsd: round2(fundingNet),
      commissionUsd: round2(commission),
      netUsd: round2(realized + fundingNet - commission),
      realizedEvents: a?.realizedEvents ?? 0,
      lastActivityTs: a?.lastTs ?? null,
      open: openBySym.get(symbol) ?? null,
    });
  }

  return out.sort((x, y) => {
    if ((x.open != null) !== (y.open != null)) return x.open != null ? -1 : 1;
    const tx = x.lastActivityTs ?? 0;
    const ty = y.lastActivityTs ?? 0;
    if (tx !== ty) return ty - tx;
    return x.symbol.localeCompare(y.symbol);
  });
}

// ── Bot-event trade pairing ────────────────────────────────────────────────

export interface BotEventLite {
  source: string;
  kind: string; // boot | entry | exit | kill_switch | halt | boot_flatten | ...
  side?: 'long' | 'short' | null;
  qty?: number | null;
  price_usd?: number | null;
  notional_usd?: number | null;
  equity_usd?: number | null;
  bot_ts_ms: number;
  strategy?: string | null;
  payload?: Record<string, unknown> | null;
}

const CLOSING_KINDS = new Set(['exit', 'kill_switch', 'halt', 'boot_flatten']);

// ── Per-strategy exit metadata ──────────────────────────────────────────────
// Mirrored from the deployed snapback configs (config/params.yaml,
// config/params_donchian.yaml). The bot does NOT emit its hold window or bar
// timeframe in telemetry, so we key them by strategy_name here. There is no
// runtime cross-check — the bot's config is the source of truth; if a value
// diverges there, update it here too. Unknown strategies degrade gracefully
// (SL/TP still show from the payload; exitCondition/bars are just omitted).
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

interface StrategyMeta {
  barMs: number;         // entry-timeframe bar duration
  maxHoldBars: number;   // time-stop: flatten after this many bars
  placesTp: boolean;     // does the entry place a TP bracket leg?
  exitCondition: string; // human-readable "what closes this position"
}

const STRATEGY_META: Record<string, StrategyMeta> = {
  // 15m entry TF; fixed 1.5% SL / 3.0% TP bracket; time-stop 1344 bars (14d).
  'multifactor-v1': {
    barMs: 15 * MIN_MS,
    maxHoldBars: 1344,
    placesTp: true,
    exitCondition: 'SL 1.5% / TP 3.0% bracket',
  },
  // 4h entry TF; SL 1.5×ATR(20), NO TP — exits on a 4h close beyond the 10-bar
  // Donchian channel; time-stop 48 bars (8d).
  'donchian-v3': {
    barMs: 4 * HOUR_MS,
    maxHoldBars: 48,
    placesTp: false,
    exitCondition: '4h close beyond 10-bar Donchian · SL 1.5×ATR',
  },
};

function payloadNum(
  p: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const v = p?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Build the exit plan for an OPEN trade from its entry event. SL/TP come from
 * the entry payload — either absolute (`sl_price`/`tp_price`, market entries)
 * or reconstructed from the fill ± distance (`sl_distance`/`tp_distance`, the
 * live limit legs). The per-strategy map supplies the exit condition + hold
 * window; a TP is suppressed for SL-only strategies even if a phantom
 * `tp_distance` rode along in the payload (donchian records one but places no
 * TP leg). `nowMs` anchors bars-held so the countdown matches the payload's
 * generation time.
 */
function computeExitPlan(
  entry: BotEventLite,
  side: 'long' | 'short' | null,
  entryPrice: number | null,
  nowMs: number,
): FuturesExitPlan {
  const meta = entry.strategy ? STRATEGY_META[entry.strategy] : undefined;
  const p = entry.payload;
  const dir = side === 'short' ? -1 : 1; // long: SL below / TP above; short mirrors

  let slPriceUsd = payloadNum(p, 'sl_price');
  if (slPriceUsd == null && entryPrice != null) {
    const d = payloadNum(p, 'sl_distance');
    if (d != null) slPriceUsd = round2(entryPrice - dir * d);
  }
  let tpPriceUsd = payloadNum(p, 'tp_price');
  if (tpPriceUsd == null && entryPrice != null) {
    const d = payloadNum(p, 'tp_distance');
    if (d != null) tpPriceUsd = round2(entryPrice + dir * d);
  }
  if (meta && !meta.placesTp) tpPriceUsd = null; // suppress phantom TP

  let barsHeld: number | null = null;
  let barsLeft: number | null = null;
  if (meta) {
    barsHeld = Math.max(0, Math.floor((nowMs - entry.bot_ts_ms) / meta.barMs));
    barsLeft = Math.max(0, meta.maxHoldBars - barsHeld);
  }

  return {
    slPriceUsd,
    tpPriceUsd,
    exitCondition: meta?.exitCondition ?? null,
    maxHoldBars: meta?.maxHoldBars ?? null,
    barsHeld,
    barsLeft,
    barMs: meta?.barMs ?? null,
  };
}

/**
 * Pair each `entry` with the next closing event for the same source, in time
 * order, producing one FuturesBotTrade per round-trip. A trailing `entry`
 * with no close becomes an open trade (exitTs=null). Events must be sorted
 * ascending by bot_ts_ms within a source (the caller guarantees this).
 *
 * PnL preference: equity delta (entry.equity → exit.equity) captures fees and
 * is the bot's own ground truth; falls back to price-move × qty when equity
 * isn't on the events.
 */
export function pairBotTrades(
  events: BotEventLite[],
  nowMs: number = Date.now(),
): FuturesBotTrade[] {
  const bySource = new Map<string, BotEventLite[]>();
  for (const e of events) {
    const arr = bySource.get(e.source) ?? [];
    arr.push(e);
    bySource.set(e.source, arr);
  }

  const trades: FuturesBotTrade[] = [];
  for (const [source, evs] of bySource) {
    const sorted = [...evs].sort((a, b) => a.bot_ts_ms - b.bot_ts_ms);
    let open: BotEventLite | null = null;
    for (const e of sorted) {
      if (e.kind === 'entry') {
        // A new entry while one is open shouldn't happen (1-position rule),
        // but if it does, close the prior as open-unresolved and start fresh.
        if (open) trades.push(makeTrade(source, open, null, nowMs));
        open = e;
      } else if (CLOSING_KINDS.has(e.kind) && open) {
        trades.push(makeTrade(source, open, e, nowMs));
        open = null;
      }
    }
    if (open) trades.push(makeTrade(source, open, null, nowMs)); // still open
  }
  return trades.sort((a, b) => a.entryTs - b.entryTs);
}

function makeTrade(
  source: string,
  entry: BotEventLite,
  exit: BotEventLite | null,
  nowMs: number,
): FuturesBotTrade {
  const side = entry.side ?? null;
  const entryPrice = finiteOrNull(entry.price_usd);
  const exitPrice = exit ? finiteOrNull(exit.price_usd) : null;
  const qty = finiteOrNull(entry.qty);
  const entryEq = finiteOrNull(entry.equity_usd);
  const exitEq = exit ? finiteOrNull(exit.equity_usd) : null;

  let pnlUsd: number | null = null;
  if (exit) {
    if (entryEq != null && exitEq != null) {
      pnlUsd = round2(exitEq - entryEq);
    } else if (entryPrice != null && exitPrice != null && qty != null) {
      const dir = side === 'short' ? -1 : 1;
      pnlUsd = round2((exitPrice - entryPrice) * qty * dir);
    }
  }

  return {
    source,
    strategy: entry.strategy ?? null,
    side,
    entryTs: entry.bot_ts_ms,
    exitTs: exit ? exit.bot_ts_ms : null,
    entryPriceUsd: entryPrice,
    exitPriceUsd: exitPrice,
    qty,
    notionalUsd: finiteOrNull(entry.notional_usd),
    pnlUsd,
    exitReason: exit
      ? (typeof exit.payload?.exit_reason === 'string'
          ? (exit.payload.exit_reason as string)
          : exit.kind)
      : null,
    // Pending exit only exists while the trade is open.
    exitPlan: exit ? null : computeExitPlan(entry, side, entryPrice, nowMs),
  };
}

/**
 * Per-leg roll-up from paired trades. `live` supplies the bot's current
 * equity + halted flag per source (from bot-status), which trades alone
 * can't know.
 */
export function deriveLegStats(
  trades: FuturesBotTrade[],
  live: Map<string, { currentEquityUsd: number | null; isHalted: boolean }>,
): FuturesBotLegStats[] {
  const bySource = new Map<string, FuturesBotTrade[]>();
  for (const t of trades) {
    const arr = bySource.get(t.source) ?? [];
    arr.push(t);
    bySource.set(t.source, arr);
  }

  const out: FuturesBotLegStats[] = [];
  for (const [source, ts] of bySource) {
    const closed = ts.filter((t) => t.exitTs != null);
    const scored = closed.filter((t) => t.pnlUsd != null) as Array<
      FuturesBotTrade & { pnlUsd: number }
    >;
    const wins = scored.filter((t) => t.pnlUsd > 0).length;
    // Strictly < 0 — a break-even ($0) trade is neither a win nor a loss. (A
    // boot-flatten with insufficient telemetry used to compute exactly $0 and
    // get miscounted as a loss; the bot now emits real close price + equity.)
    const losses = scored.filter((t) => t.pnlUsd < 0).length;
    const netPnlUsd = round2(scored.reduce((s, t) => s + t.pnlUsd, 0));
    const l = live.get(source);
    out.push({
      source,
      strategy: ts.find((t) => t.strategy)?.strategy ?? null,
      trades: closed.length,
      wins,
      losses,
      // Win rate over DECIDED trades (wins + losses) — break-evens are excluded
      // so they don't dilute the rate or produce a 0/0 when a leg has only them.
      winRatePct: wins + losses ? round1((wins / (wins + losses)) * 100) : null,
      netPnlUsd,
      currentEquityUsd: l?.currentEquityUsd ?? null,
      isHalted: l?.isHalted ?? false,
      openTrade: ts.some((t) => t.exitTs == null),
      openExit: ts.find((t) => t.exitTs == null)?.exitPlan ?? null,
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * Reconcile the Binance futures account balance against the bot's own
 * reported equity. This is deliberately NOT an equality assertion: the
 * consolidate API key may belong to a DIFFERENT account than the bot trades
 * on (e.g. the spot key's account vs the bot's sub-accounts). We compute the
 * delta and a heuristic "likely same account" label so the UI can show the
 * two figures side-by-side and explain a gap instead of looking broken.
 *
 * @param futuresAccountUsd account-level value (margin balance), or null
 * @param botEquities       per-leg currentEquityUsd (nulls skipped)
 */
export function reconcileEquity(
  futuresAccountUsd: number | null,
  botEquities: Array<number | null>,
): FuturesReconciliation {
  const present = botEquities.filter(
    (x): x is number => x != null && Number.isFinite(x),
  );
  const botEquityTotalUsd = present.length
    ? round2(present.reduce((s, x) => s + x, 0))
    : null;

  if (futuresAccountUsd == null || botEquityTotalUsd == null) {
    return {
      futuresWalletUsd: futuresAccountUsd,
      botEquityTotalUsd,
      deltaUsd: null,
      likelySameAccount: null,
      note:
        futuresAccountUsd == null
          ? 'No futures account balance available — set a futures-enabled key to reconcile against the bot’s reported equity.'
          : 'No bot-reported equity yet — legs must push heartbeats carrying equity to reconcile.',
    };
  }

  const deltaUsd = round2(futuresAccountUsd - botEquityTotalUsd);
  // Within 50% of the wallet (and at least a $5 floor for tiny accounts) →
  // the key plausibly belongs to / includes the bot's account. A larger gap
  // means it's almost certainly a different account. Heuristic, never asserted.
  const likelySameAccount =
    Math.abs(deltaUsd) <= Math.max(5, futuresAccountUsd * 0.5);

  return {
    futuresWalletUsd: futuresAccountUsd,
    botEquityTotalUsd,
    deltaUsd,
    likelySameAccount,
    note: likelySameAccount
      ? 'Bot-reported equity is close to the futures account value — the key likely belongs to (or includes) the bot’s account.'
      : 'Bot-reported equity differs materially from the futures account — the consolidate key is probably a DIFFERENT account than the bot trades on. The two columns are independent, not an error.',
  };
}

// ── tiny helpers ────────────────────────────────────────────────────────────
function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
