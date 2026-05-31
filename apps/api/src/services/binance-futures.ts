// Binance USDT-M Futures (fapi) typed read-only fetchers.
//
// ALL calls are signed GETs — this module can read the account but can NOT
// trade (no order endpoints exist here; binance-futures-http only exposes a
// signed GET). The consolidate dashboard is a viewer, never a trading runtime.
//
// Endpoints (verified against developers.binance.com, 2026-05):
//   GET /fapi/v3/account       — wallet/margin balances + positions (weight 5)
//   GET /fapi/v2/positionRisk  — per-position entry/mark/liq price, leverage
//   GET /fapi/v1/income        — realized PnL / funding / commission ledger
//
// account/balance moved to v3 (v2 deprecated); positionRisk v2 is current and
// carries entry/mark/liq price fields that /v3/account omits. income is v1.
//
// Permission detection: a spot key without "Enable Futures" returns -2015 /
// 401 on these. `futuresReadable()` probes once and caches, so the analytics
// endpoint can degrade to account.available=false without spamming Binance.

import { binanceFuturesSignedGet as fapiGet } from './binance-http.js';
import { config } from '../config.js';

// ── Raw fapi response shapes (only the fields we consume) ──────────────────
interface RawAccountV3 {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  positions: Array<{
    symbol: string;
    positionSide: string;
    positionAmt: string;
    unrealizedProfit: string;
  }>;
}

interface RawPositionRisk {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
}

interface RawIncome {
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  info: string;
  time: number;
  tranId: number;
  tradeId: string;
}

export interface FuturesAccountRaw {
  walletBalanceUsd: number;
  marginBalanceUsd: number;
  unrealizedPnlUsd: number;
  availableBalanceUsd: number;
}

export interface FuturesPositionRaw {
  symbol: string;
  positionSide: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnlUsd: number;
  liquidationPrice: number | null;
  leverage: number;
}

export interface FuturesIncomeRaw {
  // Synthetic dedup id. tranId is "unique per income type per user" (Binance
  // docs), so one trade's REALIZED_PNL and COMMISSION can share a tranId but
  // differ by incomeType. Composite key = tranId:incomeType:time guards both
  // that collision and any cross-symbol funding edge case.
  dedupId: string;
  symbol: string;
  incomeType: string;
  incomeUsd: number;   // signed exactly as Binance returns it
  asset: string;
  ts: number;
  tranId: number;
}

const num = (s: string | number | null | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

// ── Runtime permission probe (cached) ──────────────────────────────────────
let readableCache: { ok: boolean; ts: number } | null = null;
const READABLE_TTL_MS = 10 * 60 * 1000; // re-probe at most every 10 min

/** -2015 / -2014 / 401 → the key can't read futures. Anything else rethrows. */
function isPermissionError(e: unknown): boolean {
  const msg = (e as Error)?.message ?? '';
  return /(-2015|-2014|-1022|\b401\b|Invalid API-key|permission)/i.test(msg);
}

export async function futuresReadable(): Promise<boolean> {
  if (!config.binanceFuturesEnabled) return false;
  const now = Date.now();
  if (readableCache && now - readableCache.ts < READABLE_TTL_MS) {
    return readableCache.ok;
  }
  try {
    await fapiGet<RawAccountV3>('/fapi/v3/account');
    readableCache = { ok: true, ts: now };
    return true;
  } catch (e) {
    if (isPermissionError(e)) {
      console.warn(
        '[futures] key lacks futures read permission (or wrong account) — ' +
          'account-side analytics disabled, bot-side still works:',
        (e as Error).message,
      );
      readableCache = { ok: false, ts: now };
      return false;
    }
    // Transient (network / rate limit) — don't cache a false negative.
    throw e;
  }
}

export async function fetchFuturesAccount(): Promise<FuturesAccountRaw> {
  const a = await fapiGet<RawAccountV3>('/fapi/v3/account');
  return {
    walletBalanceUsd: num(a.totalWalletBalance),
    marginBalanceUsd: num(a.totalMarginBalance),
    unrealizedPnlUsd: num(a.totalUnrealizedProfit),
    availableBalanceUsd: num(a.availableBalance),
  };
}

export async function fetchFuturesPositions(): Promise<FuturesPositionRaw[]> {
  const rows = await fapiGet<RawPositionRisk[]>('/fapi/v2/positionRisk');
  return rows
    .map((r) => ({
      symbol: r.symbol,
      positionSide: r.positionSide,
      positionAmt: num(r.positionAmt),
      entryPrice: num(r.entryPrice),
      markPrice: num(r.markPrice),
      unrealizedPnlUsd: num(r.unRealizedProfit),
      // Binance returns "0" for liquidationPrice when flat — surface as null.
      liquidationPrice: num(r.liquidationPrice) > 0 ? num(r.liquidationPrice) : null,
      leverage: num(r.leverage),
    }))
    // Only positions actually open (positionAmt != 0).
    .filter((p) => Math.abs(p.positionAmt) > 0);
}

/**
 * Income history since `startTime` (ms), paginated. Binance caps `limit` at
 * 1000 and returns ascending by time; we page forward by bumping startTime
 * past the last row until a short page comes back. `maxRows` bounds a cold
 * first sync so we never loop unbounded.
 */
export async function fetchFuturesIncome(
  startTime: number,
  maxRows = 5000,
): Promise<FuturesIncomeRaw[]> {
  const out: FuturesIncomeRaw[] = [];
  let cursor = startTime;
  const LIMIT = 1000;
  // Hard page cap as a backstop against a pathological loop (maxRows also caps).
  for (let page = 0; page < 50 && out.length < maxRows; page++) {
    const rows = await fapiGet<RawIncome[]>('/fapi/v1/income', {
      startTime: cursor,
      limit: LIMIT,
    });
    if (!rows.length) break;
    for (const r of rows) {
      out.push({
        dedupId: `${r.tranId}:${r.incomeType}:${r.time}`,
        symbol: r.symbol || '',
        incomeType: r.incomeType,
        incomeUsd: num(r.income),
        asset: r.asset,
        ts: r.time,
        tranId: r.tranId,
      });
    }
    if (rows.length < LIMIT) break;
    // Advance past the last row's time. +1ms avoids re-pulling the boundary
    // row; the (dedupId) UNIQUE on insert catches any same-ms straddle anyway.
    cursor = rows[rows.length - 1].time + 1;
  }
  return out;
}
