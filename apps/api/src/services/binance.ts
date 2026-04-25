import {
  binancePublicGet as publicGet,
  binanceSignedGet as signedGet,
} from './binance-http.js';

interface BinanceBalance {
  asset: string;
  free: string;
  locked: string;
}

interface AccountResponse {
  balances: BinanceBalance[];
  accountType: string;
}

interface TickerPrice {
  symbol: string;
  price: string;
}

interface RawTrade {
  id: number;
  symbol: string;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
  isBestMatch: boolean;
}

interface ExchangeInfoSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed: boolean;
}

interface FlexibleEarnPositionRow {
  asset: string;
  totalAmount: string;
  productId: string;
}
interface LockedEarnPositionRow {
  asset: string;
  amount: string;
  positionId: string;
}
interface StakingPositionRow {
  asset: string;
  amount: string;
  positionId: string;
}

export async function fetchSpotAccount() {
  return signedGet<AccountResponse>('/api/v3/account');
}

// ──────────────────────────────────────────────────────────────
// exchangeInfo filter
// Binance batched ticker endpoint 400s the entire batch if *any*
// symbol is unlisted. We cache the full set of live Spot symbols and
// filter candidate {ASSET}USDT pairs against it before querying.
// ──────────────────────────────────────────────────────────────

let spotSymbolCache: { set: Set<string>; ts: number } | null = null;
const EXCHANGE_INFO_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export async function getLiveSpotSymbols(): Promise<Set<string>> {
  if (spotSymbolCache && Date.now() - spotSymbolCache.ts < EXCHANGE_INFO_TTL_MS) {
    return spotSymbolCache.set;
  }
  const res = await publicGet<{ symbols: ExchangeInfoSymbol[] }>('/api/v3/exchangeInfo');
  // Include every symbol that has ever been Spot-tradable, not just
  // currently TRADING ones. Delisted (BREAK) pairs still have
  // historical myTrades data we need; excluding them would cause
  // unfiltered candidate probing for those assets.
  const set = new Set(
    res.symbols.filter((s) => s.isSpotTradingAllowed).map((s) => s.symbol),
  );
  spotSymbolCache = { set, ts: Date.now() };
  return set;
}

// ──────────────────────────────────────────────────────────────
// Spot balances
// ──────────────────────────────────────────────────────────────

async function fetchSpotBalances(): Promise<Record<string, number>> {
  const acc = await fetchSpotAccount();
  const out: Record<string, number> = {};
  for (const b of acc.balances) {
    const total = Number(b.free) + Number(b.locked);
    if (total > 0) out[b.asset] = total;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Earn / Staking balances
// These live under /sapi/v1/simple-earn/* and /sapi/v1/staking/*.
// Errors are swallowed per-endpoint — the user may not have any
// locked or staking positions, and a 404/403 on one path shouldn't
// wipe out the others.
// ──────────────────────────────────────────────────────────────

async function fetchFlexibleEarnBalances(): Promise<Record<string, number>> {
  try {
    const res = await signedGet<{ rows: FlexibleEarnPositionRow[] }>(
      '/sapi/v1/simple-earn/flexible/position',
      { size: 100 },
    );
    const out: Record<string, number> = {};
    for (const r of res.rows ?? []) {
      const qty = Number(r.totalAmount);
      if (qty > 0) out[r.asset] = (out[r.asset] ?? 0) + qty;
    }
    return out;
  } catch (e) {
    console.warn('[binance] flexible-earn failed:', (e as Error).message);
    return {};
  }
}

async function fetchLockedEarnBalances(): Promise<Record<string, number>> {
  try {
    const res = await signedGet<{ rows: LockedEarnPositionRow[] }>(
      '/sapi/v1/simple-earn/locked/position',
      { size: 100 },
    );
    const out: Record<string, number> = {};
    for (const r of res.rows ?? []) {
      const qty = Number(r.amount);
      if (qty > 0) out[r.asset] = (out[r.asset] ?? 0) + qty;
    }
    return out;
  } catch (e) {
    console.warn('[binance] locked-earn failed:', (e as Error).message);
    return {};
  }
}

async function fetchStakingBalances(): Promise<Record<string, number>> {
  const products = ['STAKING', 'F_DEFI', 'L_DEFI'] as const;
  const out: Record<string, number> = {};
  for (const product of products) {
    try {
      const res = await signedGet<StakingPositionRow[]>('/sapi/v1/staking/position', {
        product,
        size: 100,
      });
      for (const r of res ?? []) {
        const qty = Number(r.amount);
        if (qty > 0) out[r.asset] = (out[r.asset] ?? 0) + qty;
      }
    } catch (e) {
      // Non-fatal; some products return 400 for accounts without them.
      if (process.env.DEBUG_BINANCE) {
        console.warn(`[binance] staking(${product}) failed:`, (e as Error).message);
      }
    }
  }
  return out;
}

export interface WalletBreakdown {
  asset: string;
  spot: number;
  flexible: number;
  locked: number;
  staking: number;
  total: number;
}

// Aggregate Spot + Flexible Earn + Locked Earn + Staking into a single
// per-asset view. This is what the dashboard should treat as "your
// Binance holdings" — sub/redeem between these wallets is a non-event
// for cost basis.
export async function fetchAllBinanceBalances(): Promise<WalletBreakdown[]> {
  const [spot, flexible, locked, staking] = await Promise.all([
    fetchSpotBalances(),
    fetchFlexibleEarnBalances(),
    fetchLockedEarnBalances(),
    fetchStakingBalances(),
  ]);
  const assets = new Set([
    ...Object.keys(spot),
    ...Object.keys(flexible),
    ...Object.keys(locked),
    ...Object.keys(staking),
  ]);
  const out: WalletBreakdown[] = [];
  for (const asset of assets) {
    const s = spot[asset] ?? 0;
    const f = flexible[asset] ?? 0;
    const l = locked[asset] ?? 0;
    const st = staking[asset] ?? 0;
    const total = s + f + l + st;
    if (total > 0) out.push({ asset, spot: s, flexible: f, locked: l, staking: st, total });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Pricing
// ──────────────────────────────────────────────────────────────

const STABLES = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP']);

// Fetch current USD(T) quote for a list of crypto symbols. Binance
// quotes are in USDT which is ≈1 USD — good enough for a personal
// dashboard. Unlisted-on-Spot assets are filtered out via exchangeInfo
// so the batched request doesn't 400.
export async function fetchPricesUSDT(assets: string[]): Promise<Record<string, number>> {
  if (assets.length === 0) return {};
  const stables: Record<string, number> = {};
  const nonStable: string[] = [];
  for (const a of assets) {
    if (STABLES.has(a)) stables[a] = 1;
    else nonStable.push(a);
  }
  if (nonStable.length === 0) return stables;

  const live = await getLiveSpotSymbols();
  const tradable = nonStable.filter((a) => live.has(`${a}USDT`));
  if (tradable.length === 0) return stables;

  const symbols = tradable.map((a) => `"${a}USDT"`);
  const res = await publicGet<TickerPrice[]>('/api/v3/ticker/price', {
    symbols: `[${symbols.join(',')}]`,
  });
  const out: Record<string, number> = { ...stables };
  for (const row of res) {
    const asset = row.symbol.replace(/USDT$/, '');
    out[asset] = Number(row.price);
  }
  return out;
}

// Historical kline (daily) price for an asset in USDT at a given
// millisecond timestamp. Used by the history importer to mark Earn
// rewards to market at the moment of payout. Returns null when Binance
// has no kline data (unlisted asset on that date).
export async function fetchKlinePriceAt(
  asset: string,
  ts: number,
  quote: 'USDT' | 'BUSD' = 'USDT',
): Promise<number | null> {
  if (STABLES.has(asset)) return 1;
  const symbol = `${asset}${quote}`;
  const dayStart = Math.floor(ts / 86_400_000) * 86_400_000;
  const dayEnd = dayStart + 86_400_000 - 1;
  try {
    const rows = await publicGet<unknown[][]>('/api/v3/klines', {
      symbol,
      interval: '1d',
      startTime: dayStart,
      endTime: dayEnd,
      limit: 1,
    });
    if (!rows.length) return null;
    // kline tuple: [openTime, open, high, low, close, volume, ...]
    const close = Number(rows[0][4]);
    return Number.isFinite(close) && close > 0 ? close : null;
  } catch (e) {
    // Only swallow "pair not listed" style errors. Rate-limit / ban
    // exceptions must propagate so the importer can stop cleanly
    // instead of silently marking every reward with no price.
    const msg = (e as Error).message;
    if (/Invalid symbol|-1121/.test(msg)) return null;
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────
// Trade history
// myTrades paginates by fromId, not startTime (startTime caps at 24h).
// Caller walks the pages until an empty result. limit max is 1000.
// ──────────────────────────────────────────────────────────────

export async function fetchMyTrades(
  symbol: string,
  opts: { fromId?: number; limit?: number } = {},
): Promise<RawTrade[]> {
  const params: Record<string, string | number> = {
    symbol,
    limit: opts.limit ?? 1000,
  };
  if (opts.fromId !== undefined) params.fromId = opts.fromId;
  return signedGet<RawTrade[]>('/api/v3/myTrades', params);
}

// ──────────────────────────────────────────────────────────────
// Positions — merged Spot + Earn + Staking
// ──────────────────────────────────────────────────────────────

export interface BinancePosition {
  asset: string;
  qty: number;
  priceUSD: number;
}

export async function fetchBinancePositions(): Promise<BinancePosition[]> {
  const wallets = await fetchAllBinanceBalances();
  const prices = await fetchPricesUSDT(wallets.map((w) => w.asset));
  return wallets.map((w) => ({
    asset: w.asset,
    qty: w.total,
    priceUSD: prices[w.asset] ?? 0,
  }));
}
