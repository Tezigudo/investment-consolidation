// RSI divergence detection — a TypeScript port of TradingView's built-in
// Divergence Indicator.
//
// WHY THIS IS CONTEXT, NOT A SIGNAL
// This was measured on BTC over 2019-2026 (see snapback-btc
// tools/tv_divergence.py) and has NO tradable edge: best z = +1.80 on n=6,
// against a 1.96 threshold, and every timeframe shows hit-rate marginally above
// the base rate while AVERAGE RETURN IS NEGATIVE. It is surfaced here purely as
// situational awareness — "BTC is stretched on the daily" — and nothing in the
// bot or this API may key an order off it. Label it as context in the UI.
//
// ALGORITHM (matches the Pine built-in, do not "simplify")
//   plFound  = not na(ta.pivotlow(osc, lbL, lbR))
//   priceLL  = low[lbR]  < valuewhen(plFound, low[lbR], 1)
//   oscHL    = osc[lbR]  > valuewhen(plFound, osc[lbR], 1)
//   bullCond = priceLL and oscHL and plFound
// Two details are load-bearing:
//   1. pivots are found on the OSCILLATOR, not on price. (The snapback repo's
//      find_divergence() pivots on price — a different detector entirely, which
//      is why verdicts must name which one they used.)
//   2. a pivot is unknowable until lbR bars later, so the signal fires at
//      pivot+lbR. Firing at the pivot bar itself would be lookahead.

export const LB_L = 5;
export const LB_R = 5;
export const RANGE_LOWER = 5;
export const RANGE_UPPER = 60;

export type Candle = {
  openTime: number;
  high: number;
  low: number;
  close: number;
};

/**
 * A raw detector output. Deliberately NOT the shared `DivergenceHit`, which
 * additionally carries `barsAgo` — that is a function of where the newest
 * candle sits and is computed by the route, not by the detector. Keeping the
 * names distinct stops the two shapes being "unified" into one type that would
 * then have to lie about barsAgo here.
 */
export type DivergenceSignal = {
  kind: 'bull' | 'bear';
  /** ms epoch of the bar the label prints on (pivot + LB_R) */
  at: number;
  /** RSI at the pivot that formed the divergence */
  rsi: number;
};

/** Wilder RSI. */
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let avgUp = 0;
  let avgDn = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    avgUp += Math.max(d, 0);
    avgDn += Math.max(-d, 0);
  }
  avgUp /= period;
  avgDn /= period;
  out[period] = avgDn === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDn);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgUp = (avgUp * (period - 1) + Math.max(d, 0)) / period;
    avgDn = (avgDn * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgDn === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDn);
  }
  return out;
}

/** True where bar i is a pivot of `series`; needs lbR future bars to confirm. */
function pivots(series: number[], low: boolean): boolean[] {
  const n = series.length;
  const out = new Array<boolean>(n).fill(false);
  for (let i = LB_L; i < n - LB_R; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    let ok = true;
    for (let j = i - LB_L; j <= i + LB_R; j++) {
      const w = series[j];
      if (!Number.isFinite(w)) { ok = false; break; }
      if (low ? w < v : w > v) { ok = false; break; }
    }
    out[i] = ok;
  }
  return out;
}

export function findDivergences(candles: Candle[]): DivergenceSignal[] {
  const closes = candles.map((c) => c.close);
  const osc = rsi(closes, 14);
  const hits: DivergenceSignal[] = [];

  for (const isLow of [true, false]) {
    const piv = pivots(osc, isLow);
    let prev: number | null = null;
    for (let i = 0; i < candles.length; i++) {
      if (!piv[i]) continue;
      if (prev !== null) {
        const gap = i - prev;
        const inRange = gap >= RANGE_LOWER && gap <= RANGE_UPPER;
        const oscDiv = isLow ? osc[i] > osc[prev] : osc[i] < osc[prev];
        const priceDiv = isLow
          ? candles[i].low < candles[prev].low
          : candles[i].high > candles[prev].high;
        if (inRange && oscDiv && priceDiv) {
          const fire = i + LB_R;
          if (fire < candles.length) {
            hits.push({
              kind: isLow ? 'bull' : 'bear',
              at: candles[fire].openTime,
              rsi: Number(osc[i].toFixed(1)),
            });
          }
        }
      }
      prev = i;
    }
  }

  return hits.sort((a, b) => a.at - b.at);
}
