import { describe, it, expect } from 'vitest';
import { computeAvgFromTrades, aggregateTrades, aggregateTradesFIFO } from './cost-basis.js';
import type { TradeRow } from '@consolidate/shared';

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

describe('computeAvgFromTrades', () => {
  it('weighted-average of two BUYs', () => {
    const r = computeAvgFromTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'BUY', qty: 10, price_usd: 200, fx_at_trade: 36 }),
    ]);
    expect(r.qty).toBe(20);
    expect(r.avgUSD).toBe(150);                     // (1000 + 2000) / 20
    expect(r.costTHB).toBeCloseTo(10 * 100 * 35 + 10 * 200 * 36, 6); // 35000 + 72000 = 107000
  });

  it('partial SELL reduces qty and cost basis proportionally, avg unchanged', () => {
    const r = computeAvgFromTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'SELL', qty: 4, price_usd: 120, fx_at_trade: 36 }),
    ]);
    expect(r.qty).toBe(6);
    expect(r.avgUSD).toBe(100);                     // avg preserved across partial sell
    expect(r.costTHB).toBeCloseTo(10 * 100 * 35 * 0.6, 6); // 21000
  });

  it('full SELL then re-BUY resets avg to new price', () => {
    const r = computeAvgFromTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'SELL', qty: 10, price_usd: 120, fx_at_trade: 36 }),
      trade({ side: 'BUY', qty: 5, price_usd: 150, fx_at_trade: 37 }),
    ]);
    expect(r.qty).toBe(5);
    expect(r.avgUSD).toBe(150);
    expect(r.costTHB).toBeCloseTo(5 * 150 * 37, 6); // 27750
  });

  it('DIV rows do not affect cost basis or qty', () => {
    const r = computeAvgFromTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'DIV', qty: 0, price_usd: 3.5, fx_at_trade: 36 }),
      trade({ side: 'DIV', qty: 0, price_usd: 2.0, fx_at_trade: 36.5 }),
    ]);
    expect(r.qty).toBe(10);
    expect(r.avgUSD).toBe(100);
    expect(r.costTHB).toBeCloseTo(10 * 100 * 35, 6); // 35000
  });

  it('SELL before any BUY is ignored (no negative qty)', () => {
    const r = computeAvgFromTrades([
      trade({ side: 'SELL', qty: 5, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'BUY', qty: 10, price_usd: 50, fx_at_trade: 36 }),
    ]);
    expect(r.qty).toBe(10);
    expect(r.avgUSD).toBe(50);
    expect(r.costTHB).toBeCloseTo(10 * 50 * 36, 6); // 18000
  });
});

describe('aggregateTrades — realized PNL', () => {
  it('partial SELL banks proceeds − cost of sold portion', () => {
    // BUY 10 @ 100 (FX 35) → costUSD=1000, costTHB=35000.
    // SELL 4 @ 120 (FX 36): sold 40% → costShareUSD=400, costShareTHB=14000,
    // proceedsUSD=480, proceedsTHB=17280.
    const r = aggregateTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'SELL', qty: 4, price_usd: 120, fx_at_trade: 36 }),
    ]);
    expect(r.qty).toBe(6);
    expect(r.avgUSD).toBe(100); // weighted avg unchanged
    expect(r.costTHB).toBeCloseTo(35000 * 0.6, 6);
    expect(r.realizedUSD).toBeCloseTo(480 - 400, 6);          // +80
    expect(r.realizedTHB).toBeCloseTo(17280 - 14000, 6);      // +3280
    // FX-only contribution: 400 × (36 − 35) = 400
    expect(r.realizedFxContribTHB).toBeCloseTo(400, 6);
  });

  it('full SELL clears qty and books full realized', () => {
    const r = aggregateTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'SELL', qty: 10, price_usd: 120, fx_at_trade: 36 }),
    ]);
    expect(r.qty).toBe(0);
    expect(r.costTHB).toBeCloseTo(0, 6);
    expect(r.realizedUSD).toBeCloseTo(1200 - 1000, 6);        // +200
    expect(r.realizedTHB).toBeCloseTo(1200 * 36 - 35000, 6);  // 43200 − 35000 = 8200
    expect(r.realizedFxContribTHB).toBeCloseTo(1000 * (36 - 35), 6); // 1000
  });

  it('SELL at a loss yields negative realized', () => {
    const r = aggregateTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'SELL', qty: 5, price_usd: 80, fx_at_trade: 35 }),
    ]);
    expect(r.realizedUSD).toBeCloseTo(400 - 500, 6);           // −100
    expect(r.realizedTHB).toBeCloseTo(400 * 35 - 17500, 6);    // 14000 − 17500 = −3500
    expect(r.realizedFxContribTHB).toBeCloseTo(0, 6);          // FX unchanged
  });

  it('commission folds into cost on BUY and reduces proceeds on SELL', () => {
    // BUY 10 @ 100 fee 5 (FX 35) → costUSD = 1000+5 = 1005, costTHB = 1005×35 = 35175
    // SELL 4 @ 120 fee 2 (FX 36): sellFrac=0.4 → costShareUSD=402, costShareTHB=14070
    //   proceedsUSD = 4×120 − 2 = 478, proceedsTHB = 478×36 = 17208
    //   realizedUSD = 478 − 402 = 76; realizedTHB = 17208 − 14070 = 3138
    const r = aggregateTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35, commission: 5 }),
      trade({ side: 'SELL', qty: 4, price_usd: 120, fx_at_trade: 36, commission: 2 }),
    ]);
    expect(r.qty).toBe(6);
    expect(r.avgUSD).toBeCloseTo(100.5, 6);                       // 1005 / 10 unchanged on partial sell
    expect(r.costTHB).toBeCloseTo(35175 * 0.6, 6);                // 21105
    expect(r.realizedUSD).toBeCloseTo(76, 6);
    expect(r.realizedTHB).toBeCloseTo(3138, 6);
  });

  it('multi-buy then partial sell uses weighted avg cost', () => {
    // BUY 10 @ 100 FX35 + BUY 10 @ 200 FX36 → qty=20, costUSD=3000, costTHB=107000
    // SELL 5 @ 180 FX37: sellFrac=0.25 → costShareUSD=750, costShareTHB=26750,
    // proceedsUSD=900, proceedsTHB=33300.
    const r = aggregateTrades([
      trade({ side: 'BUY', qty: 10, price_usd: 100, fx_at_trade: 35 }),
      trade({ side: 'BUY', qty: 10, price_usd: 200, fx_at_trade: 36 }),
      trade({ side: 'SELL', qty: 5, price_usd: 180, fx_at_trade: 37 }),
    ]);
    expect(r.qty).toBe(15);
    expect(r.avgUSD).toBeCloseTo(150, 6); // avg preserved
    expect(r.realizedUSD).toBeCloseTo(900 - 750, 6);          // +150
    expect(r.realizedTHB).toBeCloseTo(33300 - 26750, 6);      // +6550
    // fxLockedAvg = 26750 / 750 = 35.6667; FX contrib = 750 × (37 − 35.6667) = 1000
    expect(r.realizedFxContribTHB).toBeCloseTo(750 * (37 - 26750 / 750), 6);
  });
});

describe('aggregateTradesFIFO', () => {
  it('SELL eats oldest lots first; surviving lot keeps its cost', () => {
    // BUY1 10 @ $10, BUY2 10 @ $20, SELL 12 @ $30 → FIFO eats all of BUY1
    // and 2 shares of BUY2. Held: 8 shares of BUY2 @ $20 → fifoCost=$160.
    // Standard weighted-avg would say cost=$120 (8×$15) — different.
    const r = aggregateTradesFIFO([
      trade({ side: 'BUY', qty: 10, price_usd: 10, fx_at_trade: 35 }),
      trade({ side: 'BUY', qty: 10, price_usd: 20, fx_at_trade: 36 }),
      trade({ side: 'SELL', qty: 12, price_usd: 30, fx_at_trade: 37 }),
    ]);
    expect(r.qty).toBeCloseTo(8, 6);
    expect(r.fifoCostUSD).toBeCloseTo(160, 6);
    expect(r.fifoCostTHB).toBeCloseTo(160 * 36, 6);
  });

  it('post-SELL BUY is appended to the FIFO queue, not consumed by past SELLs', () => {
    // BUY 5 @ $100, SELL 5 @ $200, BUY 5 @ $300.
    // FIFO: SELL eats the BUY @ $100 entirely → 0 held. Then BUY @ $300
    // adds a fresh lot of 5. Held: 5 @ $300 → fifoCost=$1500.
    const r = aggregateTradesFIFO([
      trade({ side: 'BUY', qty: 5, price_usd: 100 }),
      trade({ side: 'SELL', qty: 5, price_usd: 200 }),
      trade({ side: 'BUY', qty: 5, price_usd: 300 }),
    ]);
    expect(r.qty).toBeCloseTo(5, 6);
    expect(r.fifoCostUSD).toBeCloseTo(1500, 6);
  });

  it('BUY commission rolls into the lot cost-per-share', () => {
    // BUY 10 @ $100 + $5 commission → lot cost-per-share = $100.50.
    const r = aggregateTradesFIFO([
      trade({ side: 'BUY', qty: 10, price_usd: 100, commission: 5 }),
    ]);
    expect(r.qty).toBe(10);
    expect(r.fifoCostUSD).toBeCloseTo(1005, 6);
  });
});
