import Papa from 'papaparse';
import { z } from 'zod';
import { pool } from '../db/client.js';
import type { TradeSide, Platform } from '../db/types.js';

// DIME doesn't publish a canonical CSV schema. The importer accepts several
// header variants and maps them to a common shape. Unknown columns are
// ignored. The *critical* fields are symbol, side, qty, price, trade date,
// and FX rate — without FX the true-baht math fails.

const HEADER_MAP: Record<string, string> = {
  // symbol
  symbol: 'symbol',
  ticker: 'symbol',
  stock: 'symbol',
  // side
  side: 'side',
  action: 'side',
  type: 'side',
  'buy/sell': 'side',
  // quantity
  qty: 'qty',
  quantity: 'qty',
  shares: 'qty',
  units: 'qty',
  // price (USD)
  price: 'price_usd',
  'price usd': 'price_usd',
  'exec price': 'price_usd',
  'execution price': 'price_usd',
  // FX locked at trade
  fx: 'fx_at_trade',
  'fx rate': 'fx_at_trade',
  'exchange rate': 'fx_at_trade',
  'thb rate': 'fx_at_trade',
  usdthb: 'fx_at_trade',
  // commission
  commission: 'commission',
  fee: 'commission',
  fees: 'commission',
  // trade date
  date: 'ts',
  'trade date': 'ts',
  'transaction date': 'ts',
  timestamp: 'ts',
  // ids
  id: 'external_id',
  'order id': 'external_id',
  'trade id': 'external_id',
  reference: 'external_id',
};

const SIDE_MAP: Record<string, TradeSide> = {
  buy: 'BUY',
  b: 'BUY',
  purchase: 'BUY',
  sell: 'SELL',
  s: 'SELL',
  sale: 'SELL',
  div: 'DIV',
  dividend: 'DIV',
};

const Row = z
  .object({
    symbol: z.string().min(1),
    side: z.string().transform((s) => {
      const k = s.trim().toLowerCase();
      const mapped = SIDE_MAP[k];
      if (!mapped) throw new Error(`unknown side: ${s}`);
      return mapped;
    }),
    qty: z.coerce.number().nonnegative(),
    price_usd: z.coerce.number().positive(),
    fx_at_trade: z.coerce.number().positive(),
    commission: z.coerce.number().default(0),
    ts: z.string().transform((s) => {
      const n = Date.parse(s);
      if (Number.isNaN(n)) throw new Error(`unparseable date: ${s}`);
      return n;
    }),
    external_id: z.string().optional(),
  })
  .refine((r) => r.side === 'DIV' || r.qty > 0, {
    message: 'qty must be > 0 for BUY/SELL',
    path: ['qty'],
  });

function normalizeHeaders(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = HEADER_MAP[k.trim().toLowerCase()] ?? k.trim().toLowerCase();
    out[key] = v;
  }
  return out;
}

export interface ImportSummary {
  platform: Platform;
  total: number;
  imported: number;
  skipped: number;
  errors: { row: number; error: string }[];
}

export async function importTradesCsv(
  csvText: string,
  platform: Platform = 'DIME',
): Promise<ImportSummary> {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const summary: ImportSummary = {
    platform,
    total: parsed.data.length,
    imported: 0,
    skipped: 0,
    errors: [],
  };

  const valid: z.infer<typeof Row>[] = [];
  parsed.data.forEach((raw, i) => {
    try {
      valid.push(Row.parse(normalizeHeaders(raw)));
    } catch (e) {
      summary.errors.push({ row: i + 2, error: (e as Error).message });
    }
  });

  if (!valid.length) return summary;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of valid) {
      const externalId = r.external_id ?? `${platform}:${r.symbol}:${r.ts}:${r.qty}:${r.price_usd}`;
      const res = await client.query(
        `INSERT INTO trades(platform, symbol, side, qty, price_usd, fx_at_trade, commission, ts, external_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'csv')
         ON CONFLICT (platform, external_id) DO NOTHING`,
        [
          platform,
          r.symbol.toUpperCase(),
          r.side,
          r.qty,
          r.price_usd,
          r.fx_at_trade,
          r.commission,
          r.ts,
          externalId,
        ],
      );
      if ((res.rowCount ?? 0) > 0) summary.imported++;
      else summary.skipped++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return summary;
}
