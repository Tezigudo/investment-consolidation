import type { TradeRow } from '@consolidate/shared';

// Single-pass aggregator over a symbol's trade history. Returns both:
//  - the *current* weighted-average cost basis on what's still held
//  - *realized* PNL banked from past SELLs (USD, THB, FX contribution)
//
// SELL math:
//   sellFrac     = sellQty / qty                           (capped at 1)
//   costShareUSD = costUSD × sellFrac                      (cost of sold portion)
//   costShareTHB = costTHB × sellFrac                      (THB cost, FX-locked at original buys)
//   fxLockedAvg  = costShareTHB / costShareUSD             (avg FX of the sold portion)
//   proceedsUSD  = sellQty × sellPrice
//   proceedsTHB  = proceedsUSD × sellFX
//   realizedUSD += proceedsUSD − costShareUSD
//   realizedTHB += proceedsTHB − costShareTHB
//   fxContrib   += costShareUSD × (sellFX − fxLockedAvg)   (FX-only slice of realized THB)
//
// DIV rows don't affect cost basis or realized PNL (REW from DIME PDFs is
// emitted as DIV with qty>0 — treated as free shares; cost stays untouched).
export interface AggregatedTrades {
  qty: number;
  avgUSD: number;
  costTHB: number;
  realizedUSD: number;
  realizedTHB: number;
  realizedFxContribTHB: number;
}

export function aggregateTrades(trades: TradeRow[]): AggregatedTrades {
  let qty = 0;
  let costUSD = 0;
  let costTHB = 0;
  let realizedUSD = 0;
  let realizedTHB = 0;
  let realizedFxContribTHB = 0;
  for (const t of trades) {
    if (t.side === 'BUY') {
      qty += t.qty;
      costUSD += t.qty * t.price_usd;
      costTHB += t.qty * t.price_usd * t.fx_at_trade;
    } else if (t.side === 'SELL') {
      if (qty <= 0) continue;
      const sellQty = Math.min(t.qty, qty);
      const sellFrac = sellQty / qty;
      const costShareUSD = costUSD * sellFrac;
      const costShareTHB = costTHB * sellFrac;
      const fxLockedAvg = costShareUSD > 0 ? costShareTHB / costShareUSD : t.fx_at_trade;
      const proceedsUSD = sellQty * t.price_usd;
      const proceedsTHB = proceedsUSD * t.fx_at_trade;
      realizedUSD += proceedsUSD - costShareUSD;
      realizedTHB += proceedsTHB - costShareTHB;
      realizedFxContribTHB += costShareUSD * (t.fx_at_trade - fxLockedAvg);
      costUSD -= costShareUSD;
      costTHB -= costShareTHB;
      qty -= sellQty;
    }
  }
  return {
    qty,
    avgUSD: qty > 0 ? costUSD / qty : 0,
    costTHB,
    realizedUSD,
    realizedTHB,
    realizedFxContribTHB,
  };
}

// Backwards-compat thin wrapper used by existing callers and tests.
export function computeAvgFromTrades(
  trades: TradeRow[],
): { qty: number; avgUSD: number; costTHB: number } {
  const a = aggregateTrades(trades);
  return { qty: a.qty, avgUSD: a.avgUSD, costTHB: a.costTHB };
}
