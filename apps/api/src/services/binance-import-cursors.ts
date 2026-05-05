// Per-endpoint sync cursors for the incremental Binance importer.
//
// Each endpoint (myTrades:<symbol>, deposits, withdrawals, convert,
// earn-flexible, earn-locked, earn-staking, fiat-orders, fiat-payments)
// stores its own (last_id | last_ts) so reruns only fetch new records.

import { pool } from '../db/client.js';

export interface Cursor {
  last_id: number | null;
  last_ts: number | null;
}

export async function readCursor(endpoint: string): Promise<Cursor> {
  const { rows } = await pool.query<Cursor>(
    'SELECT last_id, last_ts FROM binance_sync_state WHERE endpoint = $1',
    [endpoint],
  );
  return rows[0] ?? { last_id: null, last_ts: null };
}

export async function writeCursor(endpoint: string, c: Partial<Cursor>): Promise<void> {
  const existing = await readCursor(endpoint);
  const next = {
    last_id: c.last_id ?? existing.last_id,
    last_ts: c.last_ts ?? existing.last_ts,
  };
  await pool.query(
    `INSERT INTO binance_sync_state(endpoint, last_id, last_ts, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET
       last_id = EXCLUDED.last_id,
       last_ts = EXCLUDED.last_ts,
       updated_at = EXCLUDED.updated_at`,
    [endpoint, next.last_id, next.last_ts, Date.now()],
  );
}

/** True if at least one cursor row exists (initial backfill was run). */
export async function isBinanceSyncSeeded(): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM binance_sync_state LIMIT 1');
  return rows.length > 0;
}

/** Latest updated_at across all cursors, or null if never synced. */
export async function getLastBinanceSyncTs(): Promise<number | null> {
  const { rows } = await pool.query<{ ts: number | null }>(
    'SELECT MAX(updated_at) AS ts FROM binance_sync_state',
  );
  return rows[0]?.ts ?? null;
}
