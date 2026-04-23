import crypto from 'node:crypto';
import { config } from '../config.js';

const BASE = 'https://api.binance.com';

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

function sign(queryString: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function signedGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  if (!config.binanceEnabled) {
    throw new Error('Binance is not configured. Set BINANCE_API_KEY and BINANCE_API_SECRET in .env');
  }
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Date.now()),
    recvWindow: '10000',
  });
  const signature = sign(qs.toString(), config.BINANCE_API_SECRET);
  qs.append('signature', signature);

  const res = await fetch(`${BASE}${path}?${qs.toString()}`, {
    headers: { 'X-MBX-APIKEY': config.BINANCE_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Binance ${path} ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function publicGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  );
  const url = qs.toString() ? `${BASE}${path}?${qs.toString()}` : `${BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function fetchSpotAccount() {
  return signedGet<AccountResponse>('/api/v3/account');
}

export async function fetchNonZeroBalances() {
  const acc = await fetchSpotAccount();
  return acc.balances
    .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked), total: Number(b.free) + Number(b.locked) }))
    .filter((b) => b.total > 0);
}

// Fetch current USD(T) quote for a list of crypto symbols. Binance quotes are
// in USDT which is ≈1 USD — good enough for a personal dashboard.
export async function fetchPricesUSDT(assets: string[]): Promise<Record<string, number>> {
  if (assets.length === 0) return {};
  // Binance accepts ["BTCUSDT", "ETHUSDT", ...] in a single request
  const symbols = assets
    .filter((a) => a !== 'USDT' && a !== 'USDC' && a !== 'BUSD' && a !== 'FDUSD')
    .map((a) => `"${a}USDT"`);
  if (symbols.length === 0) return { USDT: 1 };
  const res = await publicGet<TickerPrice[]>('/api/v3/ticker/price', {
    symbols: `[${symbols.join(',')}]`,
  });
  const out: Record<string, number> = { USDT: 1, USDC: 1, BUSD: 1, FDUSD: 1 };
  for (const row of res) {
    const asset = row.symbol.replace(/USDT$/, '');
    out[asset] = Number(row.price);
  }
  return out;
}

// Trade history for a single trading pair. Binance doesn't offer a
// single-call "all my trades" endpoint — you have to ask per-symbol.
// We only call this for symbols the user actually holds.
export async function fetchMyTrades(symbol: string, limit = 500) {
  return signedGet<RawTrade[]>('/api/v3/myTrades', { symbol, limit });
}

// Normalize a BinanceBalance-derived list into positions we can upsert.
export interface BinancePosition {
  asset: string;
  qty: number;
  priceUSD: number;
}
export async function fetchBinancePositions(): Promise<BinancePosition[]> {
  const balances = await fetchNonZeroBalances();
  const prices = await fetchPricesUSDT(balances.map((b) => b.asset));
  return balances.map((b) => ({
    asset: b.asset,
    qty: b.total,
    priceUSD: prices[b.asset] ?? 0,
  }));
}
