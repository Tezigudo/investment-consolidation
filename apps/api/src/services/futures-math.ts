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
} from '@consolidate/shared';

/** UTC calendar day (YYYY-MM-DD) for a ms timestamp. */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface IncomeRow {
  incomeType: string; // REALIZED_PNL | FUNDING_FEE | COMMISSION | ...
  incomeUsd: number;  // signed exactly as Binance returns (funding < 0 = paid)
  ts: number;         // ms
}

export interface IncomeSummary {
  realizedPnlUsd: number;
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
      case 'REALIZED_PNL':
        realizedPnlUsd += r.incomeUsd;
        b.realizedPnlUsd += r.incomeUsd;
        b.netUsd += r.incomeUsd;
        break;
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
  return {
    realizedPnlUsd: round2(realizedPnlUsd),
    fundingPaidUsd: round2(fundingPaidUsd),
    fundingReceivedUsd: round2(fundingReceivedUsd),
    fundingNetUsd: round2(fundingNetUsd),
    commissionUsd: round2(commissionUsd),
    netIncomeUsd: round2(realizedPnlUsd + fundingNetUsd - commissionUsd),
    byDay,
  };
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
export function pairBotTrades(events: BotEventLite[]): FuturesBotTrade[] {
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
        if (open) trades.push(makeTrade(source, open, null));
        open = e;
      } else if (CLOSING_KINDS.has(e.kind) && open) {
        trades.push(makeTrade(source, open, e));
        open = null;
      }
    }
    if (open) trades.push(makeTrade(source, open, null)); // still open
  }
  return trades.sort((a, b) => a.entryTs - b.entryTs);
}

function makeTrade(
  source: string,
  entry: BotEventLite,
  exit: BotEventLite | null,
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
    const losses = scored.filter((t) => t.pnlUsd <= 0).length;
    const netPnlUsd = round2(scored.reduce((s, t) => s + t.pnlUsd, 0));
    const l = live.get(source);
    out.push({
      source,
      strategy: ts.find((t) => t.strategy)?.strategy ?? null,
      trades: closed.length,
      wins,
      losses,
      winRatePct: scored.length ? round1((wins / scored.length) * 100) : null,
      netPnlUsd,
      currentEquityUsd: l?.currentEquityUsd ?? null,
      isHalted: l?.isHalted ?? false,
      openTrade: ts.some((t) => t.exitTs == null),
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
