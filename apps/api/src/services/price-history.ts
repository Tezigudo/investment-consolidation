import { pool } from '../db/client.js';
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

  const { rows } = await pool.query<{ price_usd: number }>(
    `SELECT price_usd FROM prices_daily WHERE asset = $1 AND date = $2`,
    [asset, date],
  );
  if (rows[0]) return rows[0].price_usd;

  let price = await fetchKlinePriceAt(asset, ts, 'USDT');
  if (price == null) {
    // Fall back to BUSD for pre-2024 rows where {ASSET}USDT didn't
    // exist but {ASSET}BUSD did. BUSD ≈ 1 USD so it's a fine proxy.
    price = await fetchKlinePriceAt(asset, ts, 'BUSD');
  }
  if (price == null) return null;

  await pool.query(
    `INSERT INTO prices_daily(asset, date, price_usd, source)
     VALUES ($1, $2, $3, 'binance-klines')
     ON CONFLICT (asset, date) DO UPDATE SET price_usd = EXCLUDED.price_usd, source = EXCLUDED.source`,
    [asset, date, price],
  );
  return price;
}
