import type { Database } from 'better-sqlite3';

type Migration = { version: number; name: string; up: string };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

      -- Deposits / withdrawals of fiat. fx_locked is the critical column:
      -- it freezes the USDTHB rate at the moment cash crossed into the
      -- investable asset, which is how true-baht PNL is computed.
      CREATE TABLE IF NOT EXISTS deposits (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        platform     TEXT NOT NULL,                 -- 'DIME' | 'Binance' | 'Bank'
        amount_thb   REAL NOT NULL,
        amount_usd   REAL NOT NULL,
        fx_locked    REAL NOT NULL,                 -- USDTHB at deposit
        ts           INTEGER NOT NULL,              -- ms epoch
        note         TEXT,
        source       TEXT                           -- 'csv' | 'manual' | 'api'
      );
      CREATE INDEX IF NOT EXISTS idx_deposits_ts ON deposits(ts);

      -- Per-fill trade history. fx_at_trade makes per-trade THB cost
      -- reconstruction possible.
      CREATE TABLE IF NOT EXISTS trades (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        platform     TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        side         TEXT NOT NULL CHECK (side IN ('BUY', 'SELL', 'DIV')),
        qty          REAL NOT NULL,
        price_usd    REAL NOT NULL,
        fx_at_trade  REAL NOT NULL,
        commission   REAL DEFAULT 0,
        ts           INTEGER NOT NULL,
        external_id  TEXT,                          -- dedupe key from source
        source       TEXT,
        UNIQUE(platform, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts     ON trades(ts);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

      -- Current holdings snapshot (refreshed from Binance / CSV).
      -- avg_cost_usd + cost_basis_thb are carried forward across runs
      -- so we don't lose history when quantities change.
      CREATE TABLE IF NOT EXISTS positions (
        platform       TEXT NOT NULL,
        symbol         TEXT NOT NULL,
        name           TEXT,
        qty            REAL NOT NULL,
        avg_cost_usd   REAL NOT NULL,               -- weighted avg across fills
        cost_basis_thb REAL NOT NULL,               -- sum of (qty_fill * price_fill * fx_at_fill)
        sector         TEXT,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (platform, symbol)
      );

      -- Cash balances per platform (THB for bank, stablecoin balances, etc).
      CREATE TABLE IF NOT EXISTS cash (
        platform   TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        amount_thb REAL NOT NULL DEFAULT 0,
        amount_usd REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      -- Price cache. Short TTL; source chooses the freshness.
      CREATE TABLE IF NOT EXISTS prices (
        symbol     TEXT PRIMARY KEY,
        price_usd  REAL NOT NULL,
        source     TEXT,
        ts         INTEGER NOT NULL
      );

      -- FX rate cache.
      CREATE TABLE IF NOT EXISTS fx_rates (
        pair       TEXT PRIMARY KEY,                -- e.g. 'USDTHB'
        rate       REAL NOT NULL,
        source     TEXT,
        ts         INTEGER NOT NULL
      );

      -- Dividends are modeled as trades with side='DIV' — querying
      -- trades WHERE side='DIV' is the single source of truth.
    `,
  },
];

export function runMigrations(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    tx();
    console.log(`[db] applied migration ${m.version}: ${m.name}`);
  }
}
