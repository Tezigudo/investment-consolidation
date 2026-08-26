import { describe, it, expect } from 'vitest';
import {
  utcDay,
  summarizeIncome,
  pairBotTrades,
  tradesClosedWithin,
  deriveLegStats,
  deriveManualStats,
  reconcileEquity,
  type IncomeRow,
  type BotEventLite,
} from './futures-math.js';
import { splitRealizedBySymbol, isBotSymbol, type FuturesPosition } from '@consolidate/shared';

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
    expect(s.realizedBySymbol).toEqual({});
  });

  it('accumulates realized PnL per symbol (only REALIZED_PNL rows)', () => {
    const rows: IncomeRow[] = [
      { incomeType: 'REALIZED_PNL', incomeUsd: 5.46, ts: T0, symbol: 'BTCUSDT' },
      { incomeType: 'REALIZED_PNL', incomeUsd: -4.96, ts: T0 + DAY, symbol: 'BTCUSDT' },
      { incomeType: 'REALIZED_PNL', incomeUsd: -7.03, ts: T0, symbol: 'VELVETUSDT' },
      { incomeType: 'COMMISSION', incomeUsd: -0.5, ts: T0, symbol: 'BTCUSDT' }, // not realized
      { incomeType: 'TRANSFER', incomeUsd: 40, ts: T0, symbol: '' },            // not realized
    ];
    const s = summarizeIncome(rows);
    expect(s.realizedBySymbol).toEqual({ BTCUSDT: 0.5, VELVETUSDT: -7.03 });
    expect(s.realizedPnlUsd).toBe(-6.53); // 5.46 − 4.96 − 7.03
  });
});

describe('isBotSymbol', () => {
  it('BTC is a bot symbol; alts are manual', () => {
    expect(isBotSymbol('BTCUSDT')).toBe(true);
    expect(isBotSymbol('VELVETUSDT')).toBe(false);
    expect(isBotSymbol('TACUSDT')).toBe(false);
  });
});

describe('splitRealizedBySymbol', () => {
  it('splits BTC (bot) from every other symbol (manual)', () => {
    const s = splitRealizedBySymbol({ BTCUSDT: 6.17, VELVETUSDT: -7.03, TACUSDT: -2.69 });
    expect(s.botUsd).toBe(6.17);
    expect(s.manualUsd).toBe(-9.72);
    expect(s.manualSymbols).toEqual(['TACUSDT', 'VELVETUSDT']); // sorted
    expect(s.hasManual).toBe(true);
  });

  it('BTC-only account → no manual split flagged', () => {
    const s = splitRealizedBySymbol({ BTCUSDT: 6.17 });
    expect(s.botUsd).toBe(6.17);
    expect(s.manualUsd).toBe(0);
    expect(s.manualSymbols).toEqual([]);
    expect(s.hasManual).toBe(false);
  });

  it('empty map → all zero, no manual', () => {
    expect(splitRealizedBySymbol({})).toEqual({
      botUsd: 0, manualUsd: 0, manualSymbols: [], hasManual: false,
    });
  });
});

function mkPos(p: Partial<FuturesPosition> & { symbol: string }): FuturesPosition {
  return {
    positionSide: 'BOTH', positionAmt: 1, entryPrice: 100, markPrice: 100,
    unrealizedPnlUsd: 0, leverage: 5, marginUsd: null, liquidationPrice: null,
    notionalUsd: 100, updatedAt: 0, slPriceUsd: null, tpPriceUsd: null,
    ...p,
  };
}

describe('deriveManualStats', () => {
  it('rolls up non-bot symbols; excludes BTC (bot) and symbol-less transfers', () => {
    const income: IncomeRow[] = [
      { incomeType: 'REALIZED_PNL', incomeUsd: 6.17, ts: T0, symbol: 'BTCUSDT' },      // bot → excluded
      { incomeType: 'REALIZED_PNL', incomeUsd: -7.03, ts: T0, symbol: 'VELVETUSDT' },
      { incomeType: 'REALIZED_PNL', incomeUsd: -1.73, ts: T0, symbol: 'TACUSDT' },
      { incomeType: 'REALIZED_PNL', incomeUsd: -0.97, ts: T0 + DAY, symbol: 'TACUSDT' },
      { incomeType: 'FUNDING_FEE', incomeUsd: -0.2, ts: T0, symbol: 'TACUSDT' },
      { incomeType: 'COMMISSION', incomeUsd: -0.1, ts: T0, symbol: 'TACUSDT' },
      { incomeType: 'TRANSFER', incomeUsd: 1000, ts: T0 },                             // no symbol → excluded
    ];
    const rows = deriveManualStats(income, []);
    // most-recent activity first: TAC (T0+DAY) before VELVET (T0); BTC absent.
    expect(rows.map((r) => r.symbol)).toEqual(['TACUSDT', 'VELVETUSDT']);
    const tac = rows.find((r) => r.symbol === 'TACUSDT')!;
    expect(tac.realizedPnlUsd).toBe(-2.7);   // -1.73 + -0.97
    expect(tac.realizedEvents).toBe(2);
    expect(tac.fundingNetUsd).toBe(-0.2);
    expect(tac.commissionUsd).toBe(0.1);     // reported positive (paid)
    expect(tac.netUsd).toBe(-3);             // -2.7 + -0.2 − 0.1
    expect(tac.lastActivityTs).toBe(T0 + DAY);
    expect(tac.open).toBeNull();
  });

  it('joins the live open position and sorts open symbols first', () => {
    const income: IncomeRow[] = [
      { incomeType: 'REALIZED_PNL', incomeUsd: -7.03, ts: T0 + 5 * DAY, symbol: 'VELVETUSDT' }, // most recent, but flat
      { incomeType: 'REALIZED_PNL', incomeUsd: -1.0, ts: T0, symbol: 'TACUSDT' },
    ];
    const positions: FuturesPosition[] = [
      mkPos({ symbol: 'TACUSDT', positionAmt: -50, entryPrice: 0.5, markPrice: 0.48, unrealizedPnlUsd: 1.0, slPriceUsd: 0.55, tpPriceUsd: 0.4 }),
      mkPos({ symbol: 'BTCUSDT', positionAmt: 0.01 }), // bot symbol → not manual
    ];
    const rows = deriveManualStats(income, positions);
    // TAC is open → sorts first even though VELVET has more recent income.
    expect(rows.map((r) => r.symbol)).toEqual(['TACUSDT', 'VELVETUSDT']);
    expect(rows[0].open).not.toBeNull();
    expect(rows[0].open!.positionAmt).toBe(-50);
    expect(rows[0].open!.slPriceUsd).toBe(0.55);
    expect(rows.find((r) => r.symbol === 'BTCUSDT')).toBeUndefined();
  });

  it('a symbol with only an open position (no income) still appears', () => {
    const rows = deriveManualStats([], [mkPos({ symbol: 'PEPEUSDT', positionAmt: 1000 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('PEPEUSDT');
    expect(rows[0].realizedPnlUsd).toBe(0);
    expect(rows[0].realizedEvents).toBe(0);
    expect(rows[0].open).not.toBeNull();
  });

  it('empty inputs → empty', () => {
    expect(deriveManualStats([], [])).toEqual([]);
  });
});

function ev(p: Partial<BotEventLite>): BotEventLite {
  return { source: 'snapback-btc', kind: 'entry', bot_ts_ms: 0, ...p };
}

describe('pairBotTrades', () => {
  it('pairs entry→exit and prefers equity delta for PnL', () => {
    const trades = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 100, qty: 1, equity_usd: 100 }),
      // `reason` is the key the bot actually writes — see exitReasonOf().
      ev({ kind: 'exit', bot_ts_ms: T0 + DAY, price_usd: 110, equity_usd: 109, payload: { reason: 'take_profit' } }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].pnlUsd).toBe(9); // equity delta 109−100, not price move (10)
    expect(trades[0].exitReason).toBe('take_profit');
    expect(trades[0].exitTs).toBe(T0 + DAY);
  });

  // Regression: the bot emits payload={"reason": ...}; reading only
  // `exit_reason` made every real trade's exit reason render as "exit".
  it.each([
    ['bracket_exit'],
    ['time_stop'],
    ['channel_exit'],
    ['stale_position_at_boot'],
  ])('reads the bot\'s own `reason` key (%s)', (reason) => {
    const [t] = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 100, qty: 1 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + 100, price_usd: 110, payload: { reason } }),
    ]);
    expect(t.exitReason).toBe(reason);
  });

  it('still honours the legacy exit_reason key', () => {
    const [t] = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 100, qty: 1 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + 100, price_usd: 110, payload: { exit_reason: 'take_profit' } }),
    ]);
    expect(t.exitReason).toBe('take_profit');
  });

  it('falls back to kind when the payload carries no reason', () => {
    const [t] = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 100, qty: 1 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + 100, price_usd: 110, payload: {} }),
    ]);
    expect(t.exitReason).toBe('exit');
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
    expect(trades[0].unresolved).toBe(false);
  });

  // Regression (live, 2026-08-22): v1's bracket SL filled at 08-23 05:14:30 and
  // the bot re-entered at 05:14:31 — inside one 5s poll, so its open→flat edge
  // detector never saw flat and pushed no exit. The dangling entry then read as
  // an open position, complete with SL/TP and a bars-left countdown, for days
  // after the leg had gone flat.
  it('an entry superseded by a later entry is unresolved, not open', () => {
    const trades = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 77310.9, qty: 0.004, strategy: 'multifactor-v1', equity_usd: 147.32 }),
      // no exit here — the SL filled on the exchange and the bot never pushed it
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0 + DAY, price_usd: 76122.8, qty: 0.004, strategy: 'multifactor-v1', equity_usd: 141.87 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + DAY + 41_000, price_usd: 76003.1, equity_usd: 140.83, payload: { reason: 'trend_exit' } }),
    ]);
    expect(trades).toHaveLength(2);

    const [orphan, closed] = trades;
    expect(orphan.unresolved).toBe(true);
    expect(orphan.exitTs).toBeNull();
    expect(orphan.pnlUsd).toBeNull();
    // The phantom the dashboard rendered: an SL/TP and a countdown for a
    // position that no longer existed.
    expect(orphan.exitPlan).toBeNull();

    expect(closed.unresolved).toBe(false);
    expect(closed.exitReason).toBe('trend_exit');
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
    expect(leg.unresolvedTrades).toBe(0);
  });

  // The live v1 symptom: leg flat on the exchange, dashboard showing an open
  // trade with a live SL/TP and a 431-bar countdown, sourced from a dangling
  // 08-22 entry whose exit was never pushed.
  it('an unresolved entry is NOT an open trade', () => {
    const trades = pairBotTrades([
      ev({ source: 'v1', strategy: 'multifactor-v1', kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 77310.9, qty: 0.004, equity_usd: 147.32 }),
      // exit never arrived; the next entry proves it closed
      ev({ source: 'v1', strategy: 'multifactor-v1', kind: 'entry', side: 'long', bot_ts_ms: T0 + DAY, price_usd: 76122.8, qty: 0.004, equity_usd: 141.87 }),
      ev({ source: 'v1', kind: 'exit', bot_ts_ms: T0 + DAY + 41_000, price_usd: 76003.1, equity_usd: 140.83, payload: { reason: 'trend_exit' } }),
    ]);
    const [leg] = deriveLegStats(trades, new Map([['v1', { currentEquityUsd: 137.68, isHalted: false }]]));
    expect(leg.openTrade).toBe(false);
    expect(leg.openExit).toBeNull();
    expect(leg.unresolvedTrades).toBe(1);
    expect(leg.trades).toBe(1);   // only the one that actually resolved
  });

  // `.find()` returned the OLDEST no-exit trade, so a stale dangler outranked a
  // genuinely open position and handed the leg the wrong exit plan.
  it('openExit comes from the latest open trade, not an older dangler', () => {
    const trades = pairBotTrades([
      // superseded, no exit
      ev({ source: 'v1', strategy: 'multifactor-v1', kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 77310.9, qty: 0.004, payload: { sl_price: 76151.24 } }),
      ev({ source: 'v1', strategy: 'multifactor-v1', kind: 'entry', side: 'long', bot_ts_ms: T0 + DAY, price_usd: 60000, qty: 0.004, payload: { sl_price: 59100 } }),
    ]);
    const [leg] = deriveLegStats(trades, new Map());
    expect(leg.openTrade).toBe(true);
    expect(leg.unresolvedTrades).toBe(1);
    // The plan must come from the live entry, not the stale one .find() used to hit.
    expect(leg.openExit?.slPriceUsd).toBe(59100);
  });

  it('a break-even ($0) trade is neither a win nor a loss', () => {
    const trades = pairBotTrades([
      ev({ source: 'Y', kind: 'entry', bot_ts_ms: T0, equity_usd: 100 }),
      ev({ source: 'Y', kind: 'exit', bot_ts_ms: T0 + 1, equity_usd: 100 }), // pnl 0
      ev({ source: 'Y', kind: 'entry', bot_ts_ms: T0 + 2, equity_usd: 100 }),
      ev({ source: 'Y', kind: 'exit', bot_ts_ms: T0 + 3, equity_usd: 108 }), // +8 win
    ]);
    const [leg] = deriveLegStats(trades, new Map());
    expect(leg.trades).toBe(2);
    expect(leg.wins).toBe(1);
    expect(leg.losses).toBe(0);       // $0 is NOT a loss
    expect(leg.winRatePct).toBe(100); // 1 win / 1 decided (break-even excluded)
  });
});

describe('tradesClosedWithin', () => {
  // The whole point: pair over full history, THEN window. Filtering the raw
  // events instead dropped any exit whose entry fell outside the window.
  const straddler = pairBotTrades([
    ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, equity_usd: 100 }),
    ev({ kind: 'exit', bot_ts_ms: T0 + 3 * DAY, equity_usd: 94.61 }),  // −5.39
  ]);

  it('keeps a trade that entered before the window but closed inside it', () => {
    const since = T0 + DAY; // window opens AFTER the entry, BEFORE the exit
    const kept = tradesClosedWithin(straddler, since);
    expect(kept).toHaveLength(1);
    expect(kept[0].entryTs).toBeLessThan(since);
    expect(kept[0].pnlUsd).toBe(-5.39);
  });

  it('drops a trade that closed before the window opened', () => {
    expect(tradesClosedWithin(straddler, T0 + 10 * DAY)).toHaveLength(0);
  });

  it('always keeps open trades, however old the entry', () => {
    const open = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, equity_usd: 100 }),
    ]);
    expect(tradesClosedWithin(open, T0 + 365 * DAY)).toHaveLength(1);
  });

  it('includes a trade closing exactly on the boundary', () => {
    expect(tradesClosedWithin(straddler, T0 + 3 * DAY)).toHaveLength(1);
  });

  // An unresolved entry has no exit to window by and is not current state, so
  // the blanket "always keep exitTs==null" rule pinned it into every window
  // forever. It windows by ENTRY time instead — the only timestamp it has.
  it('windows an unresolved entry by its entry time, not forever', () => {
    const withOrphan = pairBotTrades([
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0, equity_usd: 100 }),        // orphaned
      ev({ kind: 'entry', side: 'long', bot_ts_ms: T0 + DAY, equity_usd: 94 }),   // still open
    ]);
    expect(withOrphan.map((t) => t.unresolved)).toEqual([true, false]);

    // Window opens before the orphan's entry → both present.
    expect(tradesClosedWithin(withOrphan, T0 - DAY)).toHaveLength(2);
    // Window opens after it → only the genuinely open trade survives.
    const later = tradesClosedWithin(withOrphan, T0 + 12 * 60 * 60 * 1000);
    expect(later).toHaveLength(1);
    expect(later[0].unresolved).toBe(false);
  });

  // The live 2026-08-22 shape: v1's 07-22→07-23 loss closed inside the 30d
  // window but was invisible, lifting the displayed win rate from 25% to 33.3%.
  it('window win rate counts the straddling loss (the reported bug)', () => {
    const all = pairBotTrades([
      ev({ kind: 'entry', bot_ts_ms: T0, equity_usd: 100 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + 2 * DAY, equity_usd: 94.61 }),   // −5.39, straddles
      ev({ kind: 'entry', bot_ts_ms: T0 + 3 * DAY, equity_usd: 94.61 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + 4 * DAY, equity_usd: 89.61 }),   // −5.00
      ev({ kind: 'entry', bot_ts_ms: T0 + 5 * DAY, equity_usd: 89.61 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + 6 * DAY, equity_usd: 84.27 }),   // −5.34
      ev({ kind: 'entry', bot_ts_ms: T0 + 7 * DAY, equity_usd: 84.27 }),
      ev({ kind: 'exit', bot_ts_ms: T0 + 8 * DAY, equity_usd: 84.48 }),   // +0.21
    ]);
    const [windowed] = deriveLegStats(tradesClosedWithin(all, T0 + DAY), new Map());
    expect(windowed.trades).toBe(4);       // was 3 — the straddler was lost
    expect(windowed.winRatePct).toBe(25);  // was 33.3 — flattered by the drop
    expect(windowed.netPnlUsd).toBe(-15.52);

    const [life] = deriveLegStats(all, new Map());
    expect(life.trades).toBe(4);
    expect(life.winRatePct).toBe(25);
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

describe('exit plan (open trades)', () => {
  const H4 = 4 * 60 * 60 * 1000;
  const M15 = 15 * 60 * 1000;
  const NOW = T0 + 12 * H4; // 12 4h-bars after entry

  it('reconstructs donchian SL from sl_distance, suppresses phantom TP, counts bars', () => {
    const [t] = pairBotTrades([
      ev({ strategy: 'donchian-v3', kind: 'entry', side: 'long', bot_ts_ms: T0,
        price_usd: 108000, payload: { filled_as: 'limit', sl_distance: 1600, tp_distance: 3000 } }),
    ], NOW);
    const p = t.exitPlan!;
    expect(p.slPriceUsd).toBe(106400);      // 108000 − 1600 (long SL below)
    expect(p.tpPriceUsd).toBeNull();        // donchian places NO TP — phantom tp_distance ignored
    expect(p.exitCondition).toMatch(/Donchian/);
    expect(p.maxHoldBars).toBe(48);
    expect(p.barsHeld).toBe(12);
    expect(p.barsLeft).toBe(36);
    expect(p.barMs).toBe(H4);
  });

  it('shorts put SL above / TP below the fill; unknown strategy has no hold window', () => {
    const [t] = pairBotTrades([
      ev({ strategy: 'cnh-hybrid-short-v1', kind: 'entry', side: 'short', bot_ts_ms: T0,
        price_usd: 100, payload: { sl_distance: 5, tp_distance: 8 } }),
    ], NOW);
    const p = t.exitPlan!;
    expect(p.slPriceUsd).toBe(105);
    expect(p.tpPriceUsd).toBe(92);
    expect(p.maxHoldBars).toBeNull();
    expect(p.barsLeft).toBeNull();
    expect(p.exitCondition).toBeNull();
  });

  it('uses absolute sl_price/tp_price for market entries (multifactor-v1)', () => {
    const [t] = pairBotTrades([
      ev({ strategy: 'multifactor-v1', kind: 'entry', side: 'long', bot_ts_ms: T0,
        price_usd: 100000, payload: { filled_as: 'market', sl_price: 98500, tp_price: 103000 } }),
    ], T0 + 100 * M15);
    const p = t.exitPlan!;
    expect(p.slPriceUsd).toBe(98500);
    expect(p.tpPriceUsd).toBe(103000);
    expect(p.exitCondition).toMatch(/bracket/);
    expect(p.maxHoldBars).toBe(1344);
    expect(p.barsHeld).toBe(100);
    expect(p.barsLeft).toBe(1244);
  });

  it('closed trades carry no exit plan', () => {
    const [t] = pairBotTrades([
      ev({ strategy: 'donchian-v3', kind: 'entry', side: 'long', bot_ts_ms: T0, price_usd: 108000,
        payload: { sl_distance: 1600 } }),
      ev({ kind: 'exit', bot_ts_ms: T0 + H4, price_usd: 110000, payload: { reason: 'channel_exit' } }),
    ], NOW);
    expect(t.exitPlan).toBeNull();
  });

  it('deriveLegStats surfaces the open trade’s exit plan; a flat leg has none', () => {
    const openTrades = pairBotTrades([
      ev({ source: 'L', strategy: 'donchian-v3', kind: 'entry', side: 'long', bot_ts_ms: T0,
        price_usd: 108000, equity_usd: 130, payload: { sl_distance: 1600 } }),
    ], NOW);
    const [openLeg] = deriveLegStats(openTrades, new Map());
    expect(openLeg.openTrade).toBe(true);
    expect(openLeg.openExit?.slPriceUsd).toBe(106400);
    expect(openLeg.openExit?.barsLeft).toBe(36);

    const flatTrades = pairBotTrades([
      ev({ source: 'L', strategy: 'donchian-v3', kind: 'entry', bot_ts_ms: T0, equity_usd: 130,
        payload: { sl_distance: 1600 } }),
      ev({ source: 'L', kind: 'exit', bot_ts_ms: T0 + 5, equity_usd: 140 }),
    ], NOW);
    expect(deriveLegStats(flatTrades, new Map())[0].openExit).toBeNull();
  });
});
