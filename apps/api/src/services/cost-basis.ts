import type { TradeRow } from '@consolidate/shared';

// Weighted-average USD cost + THB cost basis (FX locked per fill).
// Sells reduce cost basis proportionally. DIV rows don't affect cost.
// Exported pure for unit tests.
export function computeAvgFromTrades(
  trades: TradeRow[],
): { qty: number; avgUSD: number; costTHB: number } {
  let qty = 0;
  let costUSD = 0;
  let costTHB = 0;
  for (const t of trades) {
    if (t.side === 'BUY') {
      qty += t.qty;
      costUSD += t.qty * t.price_usd;
      costTHB += t.qty * t.price_usd * t.fx_at_trade;
    } else if (t.side === 'SELL') {
      if (qty <= 0) continue;
      const sellFrac = Math.min(1, t.qty / qty);
      costUSD *= 1 - sellFrac;
      costTHB *= 1 - sellFrac;
      qty = Math.max(0, qty - t.qty);
    }
  }
  return { qty, avgUSD: qty > 0 ? costUSD / qty : 0, costTHB };
}
