import { describe, it, expect } from 'vitest';
import { computeAvgFromTrades } from './cost-basis.js';
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
