import { db } from '../db/client.js';
import { fetchKlinePriceAt } from './binance.js';
import { dateKey } from './fx-history.js';
import { isStable } from './binance-stables.js';

// Historical crypto-in-USDT price lookup, cached per (asset, date) in
// prices_daily. Used by the Binance history importer to mark-to-market
// Earn rewards at the moment of payout without re-calling /klines for
// every reward row.

export async function getPriceUSDTForTs(asset: string, ts: number): Promise<number | null> {
  if (isStable(asset)) return 1;
  const date = dateKey(ts);

  const cached = db
    .prepare(`SELECT price_usd FROM prices_daily WHERE asset = ? AND date = ?`)
    .get(asset, date) as { price_usd: number } | undefined;
  if (cached) return cached.price_usd;

  let price = await fetchKlinePriceAt(asset, ts, 'USDT');
  if (price == null) {
    // Fall back to BUSD for pre-2024 rows where {ASSET}USDT didn't
    // exist but {ASSET}BUSD did. BUSD ≈ 1 USD so it's a fine proxy.
    price = await fetchKlinePriceAt(asset, ts, 'BUSD');
  }
  if (price == null) return null;

  db.prepare(
    `INSERT INTO prices_daily(asset, date, price_usd, source)
     VALUES (?, ?, ?, 'binance-klines')
     ON CONFLICT(asset, date) DO UPDATE SET price_usd = excluded.price_usd, source = excluded.source`,
  ).run(asset, date, price);
  return price;
}
