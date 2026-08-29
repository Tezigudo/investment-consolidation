import { describe, it, expect } from 'vitest';
import { buildDimeCashRow, buildFuturesEquityRow } from './portfolio.js';
import type { TradeRow } from '../db/types.js';

function trade(partial: Partial<TradeRow>): TradeRow {
  return {
    id: 0,
    platform: 'DIME',
    symbol: 'TEST',
    side: 'BUY',
    qty: 0,
    price_usd: 0,
    fx_at_trade: 35,
    commission: 0,
    ts: 0,
    external_id: null,
    source: null,
    ...partial,
  };
}

// A tradeMap whose net residue (sum SELL − sum BUY) = +$500 idle USD:
//   SELL 10 @ $100 = +1000, BUY 5 @ $100 = −500 → +500.
function netFiveHundred(): Map<string, TradeRow[]> {
  return new Map<string, TradeRow[]>([
    [
      'VOO',
      [
        trade({ symbol: 'VOO', side: 'BUY', qty: 5, price_usd: 100 }),
        trade({ symbol: 'VOO', side: 'SELL', qty: 10, price_usd: 100 }),
      ],
    ],
  ]);
}

const FX = 35;

describe('buildDimeCashRow — withdrawals', () => {
  it('withdrawnUSD = 0 → unchanged trades-only cash row', () => {
    const row = buildDimeCashRow(netFiveHundred(), FX, 0);
    expect(row).not.toBeNull();
    expect(row!.symbol).toBe('USD');
    expect(row!.platform).toBe('DIME');
    expect(row!.qty).toBeCloseTo(500, 6);
    expect(row!.marketUSD).toBeCloseTo(500, 6);
    expect(row!.marketTHB).toBeCloseTo(500 * FX, 6);
  });

  it('omitting the withdrawnUSD arg behaves identically to passing 0 (strict superset)', () => {
    const withDefault = buildDimeCashRow(netFiveHundred(), FX);
    const withZero = buildDimeCashRow(netFiveHundred(), FX, 0);
    expect(withDefault).toEqual(withZero);
    expect(withDefault!.qty).toBeCloseTo(500, 6);
  });

  it('withdrawal fully offsetting the net → null (no cash row)', () => {
    const row = buildDimeCashRow(netFiveHundred(), FX, 500);
    expect(row).toBeNull();
  });

  it('withdrawal exceeding the net → null (never a negative cash row)', () => {
    const row = buildDimeCashRow(netFiveHundred(), FX, 750);
    expect(row).toBeNull();
  });

  it('partial withdrawal → reduced cash row', () => {
    const row = buildDimeCashRow(netFiveHundred(), FX, 300);
    expect(row).not.toBeNull();
    expect(row!.qty).toBeCloseTo(200, 6); // 500 − 300
    expect(row!.marketUSD).toBeCloseTo(200, 6);
    expect(row!.marketTHB).toBeCloseTo(200 * FX, 6);
    expect(row!.costTHB).toBeCloseTo(200 * FX, 6);
  });

  it('residue within the 0.005 dust guard after withdrawal → null', () => {
    // 500 − 499.999 = 0.001 ≤ 0.005 → treated as no idle USD.
    const row = buildDimeCashRow(netFiveHundred(), FX, 499.999);
    expect(row).toBeNull();
  });
});

describe('buildFuturesEquityRow — bot equity bucket', () => {
  const TS = 1_750_000_000_000;

  // v1 has traded from its own Binance sub-account since 2026-07-12. Until
  // 2026-08-29 the reader took the latest snapshot row overall, so only one
  // account ever reached totals.all — ~$137 shown against a true ~$500.
  it('single account → name is unchanged, so nothing in the UI moves', () => {
    const row = buildFuturesEquityRow({ margin_usd: 137.59, ts: TS }, FX);
    expect(row!.name).toBe('Bot equity');
  });

  it('labelled account → name distinguishes the sub-account', () => {
    const row = buildFuturesEquityRow({ margin_usd: 100.42, ts: TS }, FX, 'v1');
    expect(row!.name).toBe('Bot equity · v1');
    expect(row!.marketUSD).toBeCloseTo(100.42, 6);
  });

  it('two accounts sum to the real total, not the larger of the two', () => {
    const main = buildFuturesEquityRow({ margin_usd: 137.59, ts: TS }, FX, 'main');
    const v1 = buildFuturesEquityRow({ margin_usd: 100.42, ts: TS }, FX, 'v1');
    const totalUSD = [main, v1].reduce((a, r) => a + (r?.marketUSD ?? 0), 0);
    expect(totalUSD).toBeCloseTo(238.01, 6);
    // The bug: the old reader returned exactly one of these rows.
    expect(totalUSD).toBeGreaterThan(main!.marketUSD);
  });

  it('a labelled account still honours the dust guard', () => {
    expect(buildFuturesEquityRow({ margin_usd: 0.004, ts: TS }, FX, 'v1')).toBeNull();
  });

  it('snapshot present → cash-like row equal to margin_usd (equity, PNL 0)', () => {
    const row = buildFuturesEquityRow({ margin_usd: 137.59, ts: TS }, FX);
    expect(row).not.toBeNull();
    expect(row!.platform).toBe('Futures');
    expect(row!.symbol).toBe('USDT');
    expect(row!.sector).toBe('Cash');
    // Bucket value == margin_usd, in both currencies.
    expect(row!.qty).toBeCloseTo(137.59, 6);
    expect(row!.marketUSD).toBeCloseTo(137.59, 6);
    expect(row!.marketTHB).toBeCloseTo(137.59 * FX, 6);
    // Cash-like: cost == market so it never drags PNL.
    expect(row!.costUSD).toBeCloseTo(137.59, 6);
    expect(row!.pnlUSD).toBe(0);
    expect(row!.pnlTHB).toBe(0);
    expect(row!.fxContribTHB).toBe(0);
    expect(row!.realizedUSD).toBe(0);
    // Snapshot ts is carried so the UI could show "as of Xh ago".
    expect(row!.asOf).toBe(TS);
  });

  it('no snapshot (null) → null (empty bucket, strict superset of live)', () => {
    expect(buildFuturesEquityRow(null, FX)).toBeNull();
  });

  it('zero / dust equity → null (no phantom row)', () => {
    expect(buildFuturesEquityRow({ margin_usd: 0, ts: TS }, FX)).toBeNull();
    expect(buildFuturesEquityRow({ margin_usd: 0.004, ts: TS }, FX)).toBeNull();
  });

  it('negative or NaN equity → null (never a negative/garbage bucket)', () => {
    expect(buildFuturesEquityRow({ margin_usd: -5, ts: TS }, FX)).toBeNull();
    expect(buildFuturesEquityRow({ margin_usd: NaN, ts: TS }, FX)).toBeNull();
  });

  it('the row is additive into `all` — its marketUSD is exactly the bucket that gets spread into the all-total', () => {
    // buildSnapshot does `all: sumTotals([...dime, ...binance, ...bank, ...onchain, ...futures])`.
    // sumTotals just adds each row's marketUSD, so a present futures row raises
    // `all.marketUSD` by exactly margin_usd, and an absent one (null → []) leaves it unchanged.
    const present = buildFuturesEquityRow({ margin_usd: 137.59, ts: TS }, FX);
    const absent = buildFuturesEquityRow(null, FX);
    const presentContribution = present ? present.marketUSD : 0;
    const absentContribution = absent ? absent.marketUSD : 0;
    expect(presentContribution).toBeCloseTo(137.59, 6);
    expect(absentContribution).toBe(0);
  });
});
