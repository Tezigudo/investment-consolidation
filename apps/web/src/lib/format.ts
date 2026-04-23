import type { Currency } from '@consolidate/shared';

type FmtOpts = { sign?: boolean; dp?: number };

export function fmtUSD(n: number, { sign = false, dp = 2 }: FmtOpts = {}): string {
  const abs = Math.abs(n);
  const s = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (sign) return (n >= 0 ? '+' : '−') + s;
  return n < 0 ? '−' + s : s;
}

export function fmtTHB(n: number, { sign = false, dp = 0 }: FmtOpts = {}): string {
  const abs = Math.abs(n);
  const s = '฿' + abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (sign) return (n >= 0 ? '+' : '−') + s;
  return n < 0 ? '−' + s : s;
}

export function fmtUSDT(n: number, { sign = false, dp = 2 }: FmtOpts = {}): string {
  const abs = Math.abs(n);
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + ' ₮';
  if (sign) return (n >= 0 ? '+' : '−') + s;
  return n < 0 ? '−' + s : s;
}

export function fmtPct(n: number, { sign = true, dp = 2 }: FmtOpts = {}): string {
  const abs = Math.abs(n);
  const s = abs.toFixed(dp) + '%';
  if (sign) return (n >= 0 ? '+' : '−') + s;
  return s;
}

export function fmtMoney(n: number, cur: Currency, opts?: FmtOpts): string {
  if (cur === 'THB') return fmtTHB(n, opts);
  if (cur === 'USDT') return fmtUSDT(n, opts);
  return fmtUSD(n, opts);
}
