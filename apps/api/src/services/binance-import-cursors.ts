// Per-endpoint sync cursors for the incremental Binance importer.
//
// Each endpoint (myTrades:<symbol>, deposits, withdrawals, convert,
// earn-flexible, earn-locked, earn-staking, fiat-orders, fiat-payments)
// stores its own (last_id | last_ts) so reruns only fetch new records.

import { db } from '../db/client.js';

export interface Cursor {
  last_id: number | null;
  last_ts: number | null;
}

export function readCursor(endpoint: string): Cursor {
  const row = db
    .prepare('SELECT last_id, last_ts FROM binance_sync_state WHERE endpoint = ?')
    .get(endpoint) as Cursor | undefined;
  return row ?? { last_id: null, last_ts: null };
}

export function writeCursor(endpoint: string, c: Partial<Cursor>): void {
  const existing = readCursor(endpoint);
  const next = {
    last_id: c.last_id ?? existing.last_id,
    last_ts: c.last_ts ?? existing.last_ts,
  };
  db.prepare(
    `INSERT INTO binance_sync_state(endpoint, last_id, last_ts, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       last_id = excluded.last_id,
       last_ts = excluded.last_ts,
       updated_at = excluded.updated_at`,
  ).run(endpoint, next.last_id, next.last_ts, Date.now());
}

/** True if at least one cursor row exists (initial backfill was run). */
export function isBinanceSyncSeeded(): boolean {
  return !!db.prepare('SELECT 1 FROM binance_sync_state LIMIT 1').get();
}

/** Latest updated_at across all cursors, or null if never synced. */
export function getLastBinanceSyncTs(): number | null {
  const row = db
    .prepare('SELECT MAX(updated_at) AS ts FROM binance_sync_state')
    .get() as { ts: number | null } | undefined;
  return row?.ts ?? null;
}
