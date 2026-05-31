import { describe, it, expect } from 'vitest';
import {
  utcDay,
  summarizeIncome,
  pairBotTrades,
  deriveLegStats,
  reconcileEquity,
  type IncomeRow,
  type BotEventLite,
} from './futures-math.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00Z

describe('utcDay', () => {
  it('returns the UTC calendar day', () => {
    expect(utcDay(T0)).toBe('2026-01-01');
    // 2026-01-01T23:30Z + 1h → still same UTC day even though Bangkok rolled over
    expect(utcDay(Date.UTC(2026, 0, 1, 23, 30))).toBe('2026-01-01');
  });
});

describe('summarizeIncome', () => {
  it('splits funding into paid (negative) vs received (positive)', () => {
    const rows: IncomeRow[] = [
      { incomeType: 'FUNDING_FEE', incomeUsd: -1.5, ts: T0 }, // paid
      { incomeType: 'FUNDING_FEE', incomeUsd: 0.4, ts: T0 },  // received
      { incomeType: 'FUNDING_FEE', incomeUsd: -0.6, ts: T0 }, // paid
    ];
    const s = summarizeIncome(rows);
    expect(s.fundingPaidUsd).toBe(2.1);
    expect(s.fundingReceivedUsd).toBe(0.4);
    expect(s.fundingNetUsd).toBe(-1.7); // received − paid
  });

  it('commission is reported as positive paid; realized passes through signed', () => {
    const rows: IncomeRow[] = [
      { incomeType: 'REALIZED_PNL', incomeUsd: 12.0, ts: T0 },
      { incomeType: 'REALIZED_PNL', incomeUsd: -4.0, ts: T0 },
      { incomeType: 'COMMISSION', incomeUsd: -0.8, ts: T0 }, // Binance returns commission negative
    ];
    const s = summarizeIncome(rows);
    expect(s.realizedPnlUsd).toBe(8.0);
    expect(s.commissionUsd).toBe(0.8);
    // net = realized(8) + fundingNet(0) − commission(0.8) = 7.2
    expect(s.netIncomeUsd).toBe(7.2);
  });

  it('buckets by UTC day and ignores non-trading income (TRANSFER)', () => {
    const rows: IncomeRow[] = [
      { incomeType: 'REALIZED_PNL', incomeUsd: 5, ts: T0 },
      { incomeType: 'FUNDING_FEE', incomeUsd: -1, ts: T0 },
      { incomeType: 'REALIZED_PNL', incomeUsd: 3, ts: T0 + DAY },
      { incomeType: 'TRANSFER', incomeUsd: 1000, ts: T0 }, // wallet move, excluded
    ];
    const s = summarizeIncome(rows);
    expect(s.byDay).toHaveLength(2);
    const d1 = s.byDay[0];
    expect(d1.day).toBe('2026-01-01');
    expect(d1.realizedPnlUsd).toBe(5);
    expect(d1.fundingUsd).toBe(-1);
    expect(d1.netUsd).toBe(4); // 5 − 1, transfer excluded
    expect(s.byDay[1].day).toBe('2026-01-02');
    expect(s.byDay[1].netUsd).toBe(3);
    expect(s.realizedPnlUsd).toBe(8); // transfer not counted
  });

  it('empty ledger → all zeros, no buckets', () => {
    const s = summarizeIncome([]);
    expect(s).toMatchObject({
      realizedPnlUsd: 0, fundingNetUsd: 0, commissionUsd: 0, netIncomeUsd: 0,
    });
    expect(s.byDay).toEqual([]);
  });
});

function ev(p: Partial<BotEventLite>): BotEventLite {
  return { source: 'snapback-btc', kind: 'entry', bot_ts_ms: 0, ...p };
}

describe('pairBotTrades', () => {
  it('pairs entry→exit and prefers equity delta for PnL', () => {
    const trades = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 100, qty: 1, equity_usd: 100 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + DAY, price_usd: 110, equity_usd: 109, payload: { exit_reason: 'take_profit' } }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].pnlUsd).toBe(9); // equity delta 109−100, not price move (10)
    expect(trades[0].exitReason).toBe('take_profit');
    expect(trades[0].exitTs).toBe(T0 + DAY);
  });

  it('falls back to price×qty×direction when equity is absent (short)', () => {
    const trades = pairBotTrades([
      ev({ kind: 'entry', side: 'short', bot_ts_ms: T0, price_usd: 100, qty: 2 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + 100, price_usd: 90 }),
    ]);
    // short profits when price falls: (90−100)*2*(-1) = +20
    expect(trades[0].pnlUsd).toBe(20);
  });

  it('a trailing entry with no exit is an open trade (pnl null)', () => {
    const trades = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 100, qty: 1, equity_usd: 100 }),
    ]);
    expect(trades[0].exitTs).toBeNull();
    expect(trades[0].pnlUsd).toBeNull();
  });

  it('kill_switch and halt close an open trade', () => {
    const trades = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, equity_usd: 100 }),
      ev({ kind: 'kill_switch', bot_ts_ms: T0 + 10, equity_usd: 65 }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].pnlUsd).toBe(-35);
    expect(trades[0].exitReason).toBe('kill_switch');
  });

  it('separates trades per source and sorts by entry time', () => {
    const trades = pairBotTrades([
      ev({ source: 'A', kind: 'entry', bot_ts_ms: T0 + DAY, equity_usd: 50 }),
      ev({ source: 'A', kind: 'exit', bot_ts_ms: T0 + DAY + 5, equity_usd: 55 }),
      ev({ source: 'B', kind: 'entry', bot_ts_ms: T0, equity_usd: 200 }),
      ev({ source: 'B', kind: 'exit', bot_ts_ms: T0 + 5, equity_usd: 190 }),
    ]);
    expect(trades.map((t) => t.source)).toEqual(['B', 'A']); // sorted by entryTs
    expect(trades[0].pnlUsd).toBe(-10);
    expect(trades[1].pnlUsd).toBe(5);
  });
});

describe('deriveLegStats', () => {
  it('computes win rate, net pnl, and merges live equity/halt', () => {
    const trades = pairBotTrades([
      ev({ source: 'X', strategy: 'cnh', kind: 'entry', bot_ts_ms: T0, equity_usd: 100 }),
      ev({ source: 'X', kind: 'exit', bot_ts_ms: T0 + 1, equity_usd: 110 }),     // +10 win
      ev({ source: 'X', kind: 'entry', bot_ts_ms: T0 + 2, equity_usd: 110 }),
      ev({ source: 'X', kind: 'exit', bot_ts_ms: T0 + 3, equity_usd: 105 }),     // −5 loss
      ev({ source: 'X', kind: 'entry', bot_ts_ms: T0 + 4, equity_usd: 105 }),    // open
    ]);
    const live = new Map([['X', { currentEquityUsd: 105, isHalted: true }]]);
    const [leg] = deriveLegStats(trades, live);
    expect(leg.trades).toBe(2); // closed only
    expect(leg.wins).toBe(1);
    expect(leg.losses).toBe(1);
    expect(leg.winRatePct).toBe(50);
    expect(leg.netPnlUsd).toBe(5); // +10 − 5
    expect(leg.openTrade).toBe(true);
    expect(leg.currentEquityUsd).toBe(105);
    expect(leg.isHalted).toBe(true);
    expect(leg.strategy).toBe('cnh');
  });
});

describe('reconcileEquity', () => {
  it('flags likely-same-account when bot equity is close to the wallet', () => {
    const r = reconcileEquity(105, [100]);
    expect(r.botEquityTotalUsd).toBe(100);
    expect(r.deltaUsd).toBe(5);
    expect(r.likelySameAccount).toBe(true);
  });

  it('flags a DIFFERENT account on a material gap (never asserts equality)', () => {
    const r = reconcileEquity(5000, [102]); // big spot/manual account vs tiny bot
    expect(r.likelySameAccount).toBe(false);
    expect(r.deltaUsd).toBe(4898);
    expect(r.note).toMatch(/DIFFERENT account/);
  });

  it('sums multiple legs and skips null equities', () => {
    const r = reconcileEquity(210, [100, null, 105]);
    expect(r.botEquityTotalUsd).toBe(205);
    expect(r.likelySameAccount).toBe(true);
  });

  it('degrades when the futures account is unavailable', () => {
    const r = reconcileEquity(null, [100]);
    expect(r.deltaUsd).toBeNull();
    expect(r.likelySameAccount).toBeNull();
    expect(r.note).toMatch(/futures-enabled key/);
  });

  it('degrades when no bot equity is reported', () => {
    const r = reconcileEquity(100, [null, null]);
    expect(r.botEquityTotalUsd).toBeNull();
    expect(r.likelySameAccount).toBeNull();
  });
});
