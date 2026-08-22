// Parity + behaviour tests for the Donchian channel-exit ladder.
//
// The load-bearing test is PARITY: __fixtures__/donchian-channel.json holds real
// BTCUSDT PERP 4h closes together with the exit levels the LIVE Python
// (snapback-btc strategy/live_donchian_v3.py) computes for each bar. If this
// port drifts from the bot, the dashboard misreports a live position — so we
// check against the bot's own output, not against restated arithmetic.

import { describe, it, expect } from 'vitest';
import fixture from './__fixtures__/donchian-channel.json';
import { buildChannelLadder, channelLevel, channelLevelSeries, ladderSide } from './donchian-ladder.js';
import { PAIRING_KINDS, pairBotTrades, type BotEventLite } from './futures-math.js';

const BAR_MS = 4 * 60 * 60_000;
const closes: number[] = fixture.bars.map((b) => b.close);
const candles = fixture.bars.map((b) => ({ closeTimeMs: b.closeTimeMs, close: b.close }));

describe('parity with the live Python implementation', () => {
  it('reproduces exit_lower for every bar, warmup nulls included', () => {
    const got = channelLevelSeries(closes, fixture.period, 'long');
    expect(got).toEqual(fixture.bars.map((b) => b.exitLower));
  });

  it('reproduces exit_upper for every bar', () => {
    const got = channelLevelSeries(closes, fixture.period, 'short');
    expect(got).toEqual(fixture.bars.map((b) => b.exitUpper));
  });

  it('leaves exactly `period` leading nulls (min_periods=N + shift(1))', () => {
    const got = channelLevelSeries(closes, fixture.period, 'long');
    expect(got.slice(0, fixture.period).every((v) => v === null)).toBe(true);
    expect(got[fixture.period]).not.toBeNull();
  });
});

describe('channelLevel window', () => {
  it('uses the N closes ENDING at endIdx — not including the bar being tested', () => {
    const c = [10, 20, 30, 40, 5];
    // level testing index 4 is min(closes[1..3]) = 20, NOT min(...,5) = 5
    expect(channelLevel(c, 3, 3, 'long')).toBe(20);
    expect(channelLevel(c, 3, 3, 'short')).toBe(40);
  });

  it('returns null during warmup rather than a short-window extreme', () => {
    expect(channelLevel([10, 20], 5, 1, 'long')).toBeNull();
  });
});

describe('buildChannelLadder', () => {
  const base = {
    closedCandles: candles,
    period: fixture.period,
    barMs: BAR_MS,
    side: 'long' as const,
    markUsd: 78_000,
    entryPriceUsd: 72_645.5,
    slPriceUsd: 71_290.4,
  };

  it('rung 0 is determined by real closes and is not marked projected', () => {
    const l = buildChannelLadder(base)!;
    expect(l.rows[0].projected).toBe(false);
    expect(l.rows.slice(1).every((r) => r.projected)).toBe(true);
    // it equals the plain min of the last `period` real closes
    expect(l.nextLevelUsd).toBe(Math.min(...closes.slice(-fixture.period)));
  });

  it('rung 0 close-time is exactly one bar after the last closed bar', () => {
    const l = buildChannelLadder(base)!;
    expect(l.rows[0].barCloseMs).toBe(candles[candles.length - 1].closeTimeMs + BAR_MS);
  });

  it('ratchets monotonically upward for a long when price holds', () => {
    const l = buildChannelLadder(base)!;
    const lv = l.rows.map((r) => r.exitLevelUsd);
    for (let i = 1; i < lv.length; i++) expect(lv[i]).toBeGreaterThanOrEqual(lv[i - 1]);
  });

  it('ratchets monotonically DOWNWARD for a short', () => {
    const l = buildChannelLadder({ ...base, side: 'short', markUsd: 60_000 })!;
    const lv = l.rows.map((r) => r.exitLevelUsd);
    for (let i = 1; i < lv.length; i++) expect(lv[i]).toBeLessThanOrEqual(lv[i - 1]);
  });

  it('never projects past the assumed close — the level converges to it', () => {
    const l = buildChannelLadder({ ...base, rows: fixture.period + 2 })!;
    expect(l.rows[l.rows.length - 1].exitLevelUsd).toBe(78_000);
  });

  it('flags clearsSl / crossesEntry with the correct polarity per side', () => {
    const long = buildChannelLadder(base)!;
    const above = long.rows.find((r) => r.exitLevelUsd > base.entryPriceUsd);
    if (above) expect(above.crossesEntry).toBe(true);
    const below = long.rows.find((r) => r.exitLevelUsd < base.slPriceUsd);
    if (below) expect(below.clearsSl).toBe(false);

    // For a short the same numeric level means the opposite thing.
    const short = buildChannelLadder({ ...base, side: 'short', markUsd: 60_000 })!;
    for (const r of short.rows) {
      expect(r.clearsSl).toBe(r.exitLevelUsd < base.slPriceUsd);
      expect(r.crossesEntry).toBe(r.exitLevelUsd < base.entryPriceUsd);
    }
  });

  it('returns null rather than a half-warmed ladder when history is short', () => {
    expect(buildChannelLadder({ ...base, closedCandles: candles.slice(0, 3) })).toBeNull();
  });

  it('returns null on a nonsensical mark instead of emitting Infinity percentages', () => {
    expect(buildChannelLadder({ ...base, markUsd: 0 })).toBeNull();
  });

  it('uses assumedClose when given, so the caller can stress a drift scenario', () => {
    const l = buildChannelLadder({ ...base, assumedCloseUsd: 73_000, rows: fixture.period + 2 })!;
    expect(l.assumedCloseUsd).toBe(73_000);
    expect(l.rows[l.rows.length - 1].exitLevelUsd).toBe(73_000);
  });
});

// The ladder route narrows its SQL to PAIRING_KINDS to avoid loading every
// heartbeat. That filter is only safe while it covers everything pairBotTrades
// closes a trade on — drop 'halt' from it and a halted leg's entry would look
// open forever, and the card would draw a ladder for a position that is gone.
describe('PAIRING_KINDS covers everything pairBotTrades acts on', () => {
  const ev = (kind: string, ms: number, extra: Partial<BotEventLite> = {}): BotEventLite => ({
    source: 'snapback-btc-donchian',
    kind,
    side: 'long',
    qty: 0.003,
    price_usd: 72_645.5,
    notional_usd: 217.95,
    equity_usd: 150.53,
    bot_ts_ms: ms,
    strategy: 'donchian-v3',
    payload: null,
    ...extra,
  });

  it('includes entry', () => {
    expect(PAIRING_KINDS).toContain('entry');
  });

  it('every non-entry kind in the list actually CLOSES an open trade', () => {
    for (const kind of PAIRING_KINDS.filter((k) => k !== 'entry')) {
      const trades = pairBotTrades([ev('entry', 1_000), ev(kind, 2_000)], 3_000);
      expect(trades).toHaveLength(1);
      expect(trades[0].exitTs, `${kind} should close the trade`).not.toBeNull();
    }
  });

  it('an entry with no closing event stays open — what the ladder keys off', () => {
    const trades = pairBotTrades([ev('entry', 1_000)], 3_000);
    expect(trades).toHaveLength(1);
    expect(trades[0].exitTs).toBeNull();
  });
});

// Sourcery caught this on PR #42: the route narrowed side with
// `trade.side === 'short' ? 'short' : 'long'`, so a null side drew a LONG
// ladder. bot_events accepts a nullable side on entries and pairBotTrades
// doesn't filter it, so that was reachable — and a lower-channel ladder over a
// short is wrong in direction with clearsSl/crossesEntry inverted, silently.
describe('ladderSide fails closed', () => {
  it('passes through the two real sides', () => {
    expect(ladderSide('long')).toBe('long');
    expect(ladderSide('short')).toBe('short');
  });

  it('returns null for absent/unknown rather than defaulting to long', () => {
    expect(ladderSide(null)).toBeNull();
    expect(ladderSide(undefined)).toBeNull();
    expect(ladderSide('LONG' as 'long')).toBeNull();
  });
});
