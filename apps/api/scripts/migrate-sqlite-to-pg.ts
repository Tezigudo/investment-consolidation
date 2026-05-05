// One-time data port: copy every row from the legacy SQLite db at
// apps/api/data/consolidate.sqlite into the configured Postgres
// instance. Idempotent — re-runs upsert via ON CONFLICT DO NOTHING for
// natural-key tables and DO UPDATE for snapshot tables (positions, cash,
// prices, fx_rates, sync state).
//
// Order matters only for FK-bearing tables. Today nothing is FK'd, so
// the order below is just "smaller / immutable first."
//
// Run after `bun run --filter @consolidate/api migrate:pg`.
//   bun run --filter @consolidate/api migrate:port-sqlite

import Database from 'better-sqlite3';
import fs from 'node:fs';
import { config } from '../src/config.js';
import { pgPool } from '../src/db/pg.js';

if (!fs.existsSync(config.dbPath)) {
  console.error(`[port] sqlite file not found at ${config.dbPath} — nothing to copy.`);
  process.exit(1);
}

const sqlite = new Database(config.dbPath, { readonly: true });

function rowsOf<T>(table: string): T[] {
  return sqlite.prepare(`SELECT * FROM ${table}`).all() as T[];
}

async function copyTable<T extends Record<string, unknown>>(opts: {
  table: string;
  rows: T[];
  columns: (keyof T)[];
  conflict?: string; // ON CONFLICT (...)
  update?: (keyof T)[]; // DO UPDATE SET ... = EXCLUDED.... If absent → DO NOTHING.
}) {
  const { table, rows, columns, conflict, update } = opts;
  if (!rows.length) {
    console.log(`[port] ${table}: empty`);
    return;
  }
  const colList = columns.map((c) => `"${String(c)}"`).join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const onConflict = conflict
    ? update && update.length
      ? `ON CONFLICT ${conflict} DO UPDATE SET ${update.map((c) => `"${String(c)}" = EXCLUDED."${String(c)}"`).join(', ')}`
      : `ON CONFLICT ${conflict} DO NOTHING`
    : '';
  const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ${onConflict}`.trim();

  const client = await pgPool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const vals = columns.map((c) => (r[c] === undefined ? null : r[c]));
      await client.query(sql, vals);
      inserted++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(`[port] ${table}: ${inserted} rows`);
}

async function main() {
  // _migrations: copy versions over so the runner won't re-apply them.
  // The runner already created a (possibly fresh) _migrations row when
  // the schema was applied via pg-migrate; merge by version.
  await copyTable<{ version: number; name: string; applied_at: number }>({
    table: '_migrations',
    rows: rowsOf('_migrations'),
    columns: ['version', 'name', 'applied_at'],
    conflict: '(version)',
  });

  // deposits: id is BIGSERIAL on pg side. Preserve sqlite ids so any
  // external references keep working (none today, but cheap insurance).
  await copyTable({
    table: 'deposits',
    rows: rowsOf('deposits'),
    columns: ['id', 'platform', 'amount_thb', 'amount_usd', 'fx_locked', 'ts', 'note', 'source'],
    conflict: '(id)',
  });

  // trades: same — preserve ids, dedupe on (platform, external_id).
  // Two unique constraints: (id) PK and (platform, external_id). Conflict
  // on either should be a no-op. Postgres only allows one ON CONFLICT
  // target per insert, so we do it in two passes: first insert dropping
  // duplicates by external_id, then a second pass would also dedupe by
  // id — but since sqlite already enforced both, in practice every row
  // is unique on both keys. Use the natural-key conflict.
  await copyTable({
    table: 'trades',
    rows: rowsOf('trades'),
    columns: ['id', 'platform', 'symbol', 'side', 'qty', 'price_usd', 'fx_at_trade', 'commission', 'ts', 'external_id', 'source'],
    conflict: '(platform, external_id)',
  });

  await copyTable({
    table: 'positions',
    rows: rowsOf('positions'),
    columns: ['platform', 'symbol', 'name', 'qty', 'avg_cost_usd', 'cost_basis_thb', 'sector', 'updated_at'],
    conflict: '(platform, symbol)',
    update: ['name', 'qty', 'avg_cost_usd', 'cost_basis_thb', 'sector', 'updated_at'],
  });

  await copyTable({
    table: 'cash',
    rows: rowsOf('cash'),
    columns: ['platform', 'label', 'amount_thb', 'amount_usd', 'updated_at'],
    conflict: '(platform)',
    update: ['label', 'amount_thb', 'amount_usd', 'updated_at'],
  });

  await copyTable({
    table: 'prices',
    rows: rowsOf('prices'),
    columns: ['symbol', 'price_usd', 'source', 'ts'],
    conflict: '(symbol)',
    update: ['price_usd', 'source', 'ts'],
  });

  await copyTable({
    table: 'fx_rates',
    rows: rowsOf('fx_rates'),
    columns: ['pair', 'rate', 'source', 'ts'],
    conflict: '(pair)',
    update: ['rate', 'source', 'ts'],
  });

  await copyTable({
    table: 'fx_daily',
    rows: rowsOf('fx_daily'),
    columns: ['pair', 'date', 'rate', 'source'],
    conflict: '(pair, date)',
  });

  await copyTable({
    table: 'prices_daily',
    rows: rowsOf('prices_daily'),
    columns: ['asset', 'date', 'price_usd', 'source'],
    conflict: '(asset, date)',
  });

  await copyTable({
    table: 'binance_sync_state',
    rows: rowsOf('binance_sync_state'),
    columns: ['endpoint', 'last_id', 'last_ts', 'updated_at'],
    conflict: '(endpoint)',
    update: ['last_id', 'last_ts', 'updated_at'],
  });

  await copyTable({
    table: 'dime_sync_state',
    rows: rowsOf('dime_sync_state'),
    columns: ['endpoint', 'last_ts', 'updated_at'],
    conflict: '(endpoint)',
    update: ['last_ts', 'updated_at'],
  });

  // BIGSERIAL sequences: after manual-id inserts, pg's sequence is still
  // at 1. Bump each to MAX(id)+1 so subsequent INSERTs without explicit
  // id don't collide.
  for (const t of ['deposits', 'trades']) {
    await pgPool.query(
      `SELECT setval(pg_get_serial_sequence('${t}', 'id'),
                     COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`,
    );
  }

  await pgPool.end();
  sqlite.close();
  console.log('[port] done');
}

main().catch(async (e) => {
  console.error('[port] failed:', e);
  await pgPool.end().catch(() => {});
  process.exit(1);
});
