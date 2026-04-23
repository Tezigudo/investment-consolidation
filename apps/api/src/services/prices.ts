import { db } from '../db/client.js';
import { config } from '../config.js';
import { fetchPricesUSDT } from './binance.js';
import type { PriceRow } from '../db/types.js';

const PRICE_TTL_MS = 30 * 1000; // 30s

type Source = 'finnhub' | 'yahoo' | 'binance';

async function fetchStockPriceFinnhub(symbol: string): Promise<number> {
  if (!config.FINNHUB_API_KEY) throw new Error('no finnhub key');
  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${config.FINNHUB_API_KEY}`,
  );
  if (!res.ok) throw new Error(`finnhub ${res.status}`);
  const data = (await res.json()) as { c?: number };
  if (!data.c || data.c <= 0) throw new Error('finnhub returned no price');
  return data.c;
}

async function fetchStockPriceYahoo(symbol: string): Promise<number> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (consolidate-dashboard)' } },
  );
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const data = (await res.json()) as {
    quoteResponse?: { result?: { regularMarketPrice?: number }[] };
  };
  const price = data.quoteResponse?.result?.[0]?.regularMarketPrice;
  if (!price || price <= 0) throw new Error('yahoo returned no price');
  return price;
}

export async function fetchStockPrice(symbol: string): Promise<{ price: number; source: Source }> {
  try {
    return { price: await fetchStockPriceFinnhub(symbol), source: 'finnhub' };
  } catch {
    return { price: await fetchStockPriceYahoo(symbol), source: 'yahoo' };
  }
}

export function getCachedPrice(symbol: string): PriceRow | undefined {
  return db.prepare('SELECT * FROM prices WHERE symbol = ?').get(symbol) as PriceRow | undefined;
}

function writePrice(symbol: string, price: number, source: Source) {
  db.prepare(
    'INSERT INTO prices(symbol, price_usd, source, ts) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET price_usd = excluded.price_usd, source = excluded.source, ts = excluded.ts',
  ).run(symbol, price, source, Date.now());
}

export async function refreshPrices(opts: { stocks: string[]; crypto: string[] }) {
  // Stocks one at a time — free tiers don't love bulk requests
  for (const sym of opts.stocks) {
    try {
      const { price, source } = await fetchStockPrice(sym);
      writePrice(sym, price, source);
    } catch (e) {
      console.warn(`[prices] ${sym} failed:`, (e as Error).message);
    }
  }
  // Crypto in a single batched call
  if (opts.crypto.length) {
    try {
      const prices = await fetchPricesUSDT(opts.crypto);
      for (const [asset, price] of Object.entries(prices)) writePrice(asset, price, 'binance');
    } catch (e) {
      console.warn('[prices] crypto batch failed:', (e as Error).message);
    }
  }
}

// Used by aggregator: price for a single symbol, using cache if fresh.
export async function getPrice(symbol: string, kind: 'stock' | 'crypto'): Promise<number> {
  const cached = getCachedPrice(symbol);
  if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.price_usd;

  try {
    if (kind === 'stock') {
      const { price, source } = await fetchStockPrice(symbol);
      writePrice(symbol, price, source);
      return price;
    }
    const prices = await fetchPricesUSDT([symbol]);
    const price = prices[symbol];
    if (price) writePrice(symbol, price, 'binance');
    return price ?? cached?.price_usd ?? 0;
  } catch {
    return cached?.price_usd ?? 0;
  }
}
