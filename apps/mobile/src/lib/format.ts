// Formatters used everywhere. Intl.NumberFormat is supported on iOS via
// the JSC/Hermes intl plugin in Expo SDK 54 — no extra polyfill needed.
const thb = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const thbDetail = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const pct = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const qtyFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 6,
});

export const fmtTHB = (n: number) => (Number.isFinite(n) ? thb.format(n) : '—');
export const fmtTHBDetail = (n: number) =>
  Number.isFinite(n) ? thbDetail.format(n) : '—';
export const fmtUSD = (n: number) => (Number.isFinite(n) ? usd.format(n) : '—');
export const fmtPct = (n: number) => (Number.isFinite(n) ? pct.format(n) : '—');
export const fmtQty = (n: number) => (Number.isFinite(n) ? qtyFmt.format(n) : '—');
export const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
export const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
export const fmtAge = (ts: number | null | undefined) => {
  if (!ts) return '—';
  const ms = Date.now() - ts;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};

// Smart % display:
//   - returns null when the % is meaningless (no cost basis, divide by 0,
//     position fully closed). Caller decides whether to show "—" or hide.
//   - clamps display at ±999% so partial-sell distortion doesn't take
//     over the row. Real gain is still shown via fmtTHB(pnl) next to it.
//
// `costTHB` here means the TOTAL meaningful base — typically the cost
// basis of currently held shares + realized PNL. For pure cost-basis
// %, pass costTHB alone; for total-return %, pass costTHB + realizedTHB.
export function safePctDisplay(pnl: number, base: number): string | null {
  if (!Number.isFinite(pnl) || !Number.isFinite(base)) return null;
  if (Math.abs(base) < 1) return null; // < 1 baht of cost basis = noise
  const ratio = pnl / base;
  if (!Number.isFinite(ratio)) return null;
  const clamped = Math.max(-9.99, Math.min(9.99, ratio));
  const prefix = ratio !== clamped ? (ratio > 0 ? '>' : '<') : '';
  return prefix + fmtPct(clamped);
}
