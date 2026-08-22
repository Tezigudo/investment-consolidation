// Donchian channel-exit ladder — "where does the trailing exit sit, and where
// does it move next" for a leg whose profit-taking IS a channel cross.
//
// WHY THIS EXISTS
// The donchian-v3 leg places entry + SL only. It has NO take-profit order: it
// exits when a CLOSED 4h bar closes beyond the N-bar Donchian exit channel. So
// "what's my TP" has no single answer on the dashboard — the honest answer is a
// LADDER of where that trailing level sits over the coming bars.
//
// PARITY IS THE WHOLE POINT
// The level here must match strategy/live_donchian_v3.channel_exit_signal in
// snapback-btc exactly, or the dashboard lies about a live position:
//
//     exit_lower = Close.rolling(N, min_periods=N).min().shift(1)
//     exit_upper = Close.rolling(N, min_periods=N).max().shift(1)
//     long  exits when close <  exit_lower      (STRICT <)
//     short exits when close >  exit_upper      (STRICT >)
//
// `.shift(1)` makes the channel the extreme of the N closes STRICTLY BEFORE the
// bar being tested, so it can never peek at that bar. __fixtures__/donchian-
// channel.json pins this against real perp klines run through the Python.
//
// TWO PROPERTIES WORTH KNOWING
//  1. While a position stays open the level can only ratchet TOWARD price — for
//     a long it never falls. If closes[t] were below exit_lower_t the position
//     would already have closed, so exit_lower_{t+1} = min(closes[t-N+1..t]) is
//     bounded below by exit_lower_t. (Mirrored for a short: never rises.)
//  2. The channel is evaluated at BAR CLOSE only. The resting ATR stop triggers
//     INTRABAR on touch. So the stop stays the fast exit even once the channel
//     has ratcheted past it — a gap or flush hits the stop, not the level here.

import type { ChannelLadder, ChannelLadderRow } from '@consolidate/shared';

/**
 * Narrow a bot event's side to one the ladder can actually draw.
 *
 * bot_events accepts `side` as nullable on EVERY kind, entries included
 * (routes/bot-events.ts), and pairBotTrades does not filter on it — so a
 * null-side entry reaches the ladder. Defaulting that to 'long' would draw a
 * lower-channel ladder over a short: right shape, wrong direction, with
 * clearsSl/crossesEntry inverted and no error anywhere. Fail closed instead,
 * like every other guard on this path.
 *
 * The zod enum means a garbage STRING cannot get in; null/absent is the only
 * reachable bad value. Handled by structure rather than by trusting that.
 */
export function ladderSide(
  side: 'long' | 'short' | null | undefined,
): 'long' | 'short' | null {
  return side === 'long' || side === 'short' ? side : null;
}

export interface LadderCandle {
  closeTimeMs: number;
  close: number;
}

/**
 * Channel extreme over the `period` closes ending at `endIdx` inclusive — i.e.
 * the level that tests bar `endIdx + 1`. Returns null during warmup, matching
 * the Python's `min_periods=N` NaN.
 */
export function channelLevel(
  closes: number[],
  period: number,
  endIdx: number,
  side: 'long' | 'short',
): number | null {
  if (period <= 0) return null;
  const start = endIdx - period + 1;
  if (start < 0 || endIdx >= closes.length) return null;
  const win = closes.slice(start, endIdx + 1);
  if (win.length !== period || win.some((v) => !Number.isFinite(v))) return null;
  return side === 'long' ? Math.min(...win) : Math.max(...win);
}

/**
 * Reproduce the Python's shift(1) column: `levels[i]` is the level that bar `i`
 * was tested against, null through warmup. Exists so the fixture test can
 * compare column-for-column rather than only checking the newest value.
 */
export function channelLevelSeries(
  closes: number[],
  period: number,
  side: 'long' | 'short',
): (number | null)[] {
  return closes.map((_, i) => channelLevel(closes, period, i - 1, side));
}

/**
 * Build the ladder from CLOSED candles. The caller must have already dropped
 * Binance's still-forming last row — same contract the bot's
 * `_maybe_channel_exit` honours, and the same forming-bar trap that once cost
 * the live bot a month of trades.
 */
export function buildChannelLadder(args: {
  closedCandles: LadderCandle[];
  period: number;
  barMs: number;
  side: 'long' | 'short';
  markUsd: number;
  entryPriceUsd: number | null;
  slPriceUsd: number | null;
  /** Defaults to mark — "if price holds here". */
  assumedCloseUsd?: number;
  /** How many rungs to project. */
  rows?: number;
}): ChannelLadder | null {
  const { closedCandles, period, barMs, side, markUsd, entryPriceUsd, slPriceUsd } = args;
  const rowCount = args.rows ?? 10;
  const assumedCloseUsd = args.assumedCloseUsd ?? markUsd;

  if (closedCandles.length < period || period <= 0 || !Number.isFinite(markUsd) || markUsd <= 0) {
    return null;
  }

  const closes = closedCandles.map((c) => c.close);
  const lastClosedBarMs = closedCandles[closedCandles.length - 1].closeTimeMs;

  // Rung 0 tests the next bar to close, so its window ENDS at the last closed
  // bar — determined entirely by known closes. Later rungs roll `assumedClose`
  // into the window one bar at a time.
  const work = [...closes];
  const rows: ChannelLadderRow[] = [];
  for (let k = 0; k < rowCount; k++) {
    const lvl = channelLevel(work, period, work.length - 1, side);
    if (lvl == null) break;
    rows.push({
      barCloseMs: lastClosedBarMs + barMs * (k + 1),
      exitLevelUsd: round2(lvl),
      vsMarkPct: round2(((lvl - markUsd) / markUsd) * 100),
      clearsSl: slPriceUsd == null ? false : side === 'long' ? lvl > slPriceUsd : lvl < slPriceUsd,
      crossesEntry:
        entryPriceUsd == null ? false : side === 'long' ? lvl > entryPriceUsd : lvl < entryPriceUsd,
      projected: k > 0,
    });
    work.push(assumedCloseUsd);
  }
  if (rows.length === 0) return null;

  return {
    side,
    period,
    barMs,
    lastClosedBarMs,
    markUsd: round2(markUsd),
    entryPriceUsd,
    slPriceUsd,
    assumedCloseUsd: round2(assumedCloseUsd),
    nextLevelUsd: rows[0].exitLevelUsd,
    rows,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
