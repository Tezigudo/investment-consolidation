import type { Pool } from 'pg';

// Postgres translation of src/db/migrations.ts. Same monotonic versions
// so a single _migrations table can host both histories during the cut-
// over window: the data port script copies sqlite's _migrations rows
// over verbatim, and this runner becomes a no-op for already-applied
// versions. New migrations should be appended here only.
//
// Translation rules:
//   INTEGER PRIMARY KEY AUTOINCREMENT  -> BIGSERIAL PRIMARY KEY
//   ms-epoch INTEGER                   -> BIGINT
//   REAL                               -> DOUBLE PRECISION
//   TEXT                               -> TEXT (unchanged)
//   INSERT OR IGNORE                   -> INSERT ... ON CONFLICT DO NOTHING
//   ?,?                                -> $1,$2 (call-site concern, not here)

type Migration = { version: number; name: string; up: string };

export const PG_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE IF NOT EXISTS _migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deposits (
        id           BIGSERIAL PRIMARY KEY,
        platform     TEXT NOT NULL,
        amount_thb   DOUBLE PRECISION NOT NULL,
        amount_usd   DOUBLE PRECISION NOT NULL,
        fx_locked    DOUBLE PRECISION NOT NULL,
        ts           BIGINT NOT NULL,
        note         TEXT,
        source       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deposits_ts ON deposits(ts);

      CREATE TABLE IF NOT EXISTS trades (
        id           BIGSERIAL PRIMARY KEY,
        platform     TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        side         TEXT NOT NULL CHECK (side IN ('BUY', 'SELL', 'DIV')),
        qty          DOUBLE PRECISION NOT NULL,
        price_usd    DOUBLE PRECISION NOT NULL,
        fx_at_trade  DOUBLE PRECISION NOT NULL,
        commission   DOUBLE PRECISION DEFAULT 0,
        ts           BIGINT NOT NULL,
        external_id  TEXT,
        source       TEXT,
        UNIQUE(platform, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts     ON trades(ts);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

      CREATE TABLE IF NOT EXISTS positions (
        platform       TEXT NOT NULL,
        symbol         TEXT NOT NULL,
        name           TEXT,
        qty            DOUBLE PRECISION NOT NULL,
        avg_cost_usd   DOUBLE PRECISION NOT NULL,
        cost_basis_thb DOUBLE PRECISION NOT NULL,
        sector         TEXT,
        updated_at     BIGINT NOT NULL,
        PRIMARY KEY (platform, symbol)
      );

      CREATE TABLE IF NOT EXISTS cash (
        platform   TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        amount_thb DOUBLE PRECISION NOT NULL DEFAULT 0,
        amount_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prices (
        symbol     TEXT PRIMARY KEY,
        price_usd  DOUBLE PRECISION NOT NULL,
        source     TEXT,
        ts         BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fx_rates (
        pair       TEXT PRIMARY KEY,
        rate       DOUBLE PRECISION NOT NULL,
        source     TEXT,
        ts         BIGINT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'history_import',
    up: `
      CREATE TABLE IF NOT EXISTS fx_daily (
        pair   TEXT NOT NULL,
        date   TEXT NOT NULL,
        rate   DOUBLE PRECISION NOT NULL,
        source TEXT,
        PRIMARY KEY (pair, date)
      );
      CREATE INDEX IF NOT EXISTS idx_fx_daily_pair_date ON fx_daily(pair, date);

      CREATE TABLE IF NOT EXISTS prices_daily (
        asset     TEXT NOT NULL,
        date      TEXT NOT NULL,
        price_usd DOUBLE PRECISION NOT NULL,
        source    TEXT,
        PRIMARY KEY (asset, date)
      );

      CREATE TABLE IF NOT EXISTS binance_sync_state (
        endpoint    TEXT PRIMARY KEY,
        last_id     BIGINT,
        last_ts     BIGINT,
        updated_at  BIGINT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'deposits_dedup',
    up: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_platform_source
        ON deposits(platform, source);
    `,
  },
  {
    version: 4,
    name: 'dime_mail_sync',
    up: `
      CREATE TABLE IF NOT EXISTS dime_sync_state (
        endpoint   TEXT PRIMARY KEY,
        last_ts    BIGINT,
        updated_at BIGINT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'prices_daily_fetch_state',
    up: `
      CREATE TABLE IF NOT EXISTS prices_daily_fetch (
        asset            TEXT PRIMARY KEY,
        last_fetched_at  BIGINT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: 'onchain_vault_state',
    up: `
      -- Per-(wallet, vault) cumulative deposit/withdrawal totals so we
      -- can derive vault yield as: (withdrawals + current) - deposits.
      -- Raw amounts kept as NUMERIC(78,0) to preserve uint256 precision —
      -- 18-decimal token quantities exceed BIGINT for some tokens.
      CREATE TABLE IF NOT EXISTS onchain_vault_state (
        symbol                TEXT NOT NULL,
        wallet                TEXT NOT NULL,
        vault                 TEXT NOT NULL,
        decimals              SMALLINT NOT NULL,
        total_deposits_raw    NUMERIC(78,0) NOT NULL DEFAULT 0,
        total_withdrawals_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
        current_assets_raw    NUMERIC(78,0) NOT NULL DEFAULT 0,
        last_scanned_block    BIGINT NOT NULL DEFAULT 0,
        updated_at            BIGINT NOT NULL,
        PRIMARY KEY (wallet, vault)
      );
      CREATE INDEX IF NOT EXISTS idx_onchain_vault_state_symbol
        ON onchain_vault_state(symbol);
    `,
  },
  {
    version: 7,
    name: 'onchain_vault_state_rescan',
    up: `
      -- Wipe so the next on-chain refresh re-walks Deposit/Withdraw
      -- events with the corrected filter (Withdraw now matches by
      -- indexed receiver, not owner — Morpho's bundler routes burn
      -- shares it owns on the user's behalf, so the prior owner-only
      -- filter missed ~95% of withdrawals).
      DELETE FROM onchain_vault_state;
    `,
  },
  {
    version: 8,
    name: 'onchain_airdrop_state',
    up: `
      -- Cumulative WLD (or other token) received by the wallet from a
      -- specific distributor contract — typically the Worldcoin weekly
      -- grant. Surfaced as a separate "Airdrop received" stat alongside
      -- vault yield so the user can compare each metric independently.
      CREATE TABLE IF NOT EXISTS onchain_airdrop_state (
        symbol               TEXT NOT NULL,
        wallet               TEXT NOT NULL,
        source               TEXT NOT NULL,
        decimals             SMALLINT NOT NULL,
        total_received_raw   NUMERIC(78,0) NOT NULL DEFAULT 0,
        event_count          INTEGER NOT NULL DEFAULT 0,
        first_ts             BIGINT NOT NULL DEFAULT 0,
        last_ts              BIGINT NOT NULL DEFAULT 0,
        last_scanned_block   BIGINT NOT NULL DEFAULT 0,
        updated_at           BIGINT NOT NULL,
        PRIMARY KEY (wallet, source)
      );
      CREATE INDEX IF NOT EXISTS idx_onchain_airdrop_state_symbol
        ON onchain_airdrop_state(symbol);
    `,
  },
  {
    version: 9,
    name: 'portfolio_snapshots',
    up: `
      -- One row per UTC day. End-of-day mark of total portfolio value,
      -- cost basis, and FX rate so the dashboard chart can render true
      -- historical net-worth instead of a synthesised line.
      --
      -- Bank cash + on-chain holdings are folded in at *today's* value
      -- across every historical day (constant baseline). That keeps the
      -- chart focused on what's actually moving — tradeable position
      -- performance plus FX — without trying to back-derive cash flows.
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        date         TEXT PRIMARY KEY,    -- YYYY-MM-DD UTC
        ts           BIGINT NOT NULL,     -- ms since epoch (capture time)
        market_usd   DOUBLE PRECISION NOT NULL,
        market_thb   DOUBLE PRECISION NOT NULL,
        cost_usd     DOUBLE PRECISION NOT NULL,
        cost_thb     DOUBLE PRECISION NOT NULL,
        pnl_usd      DOUBLE PRECISION NOT NULL,
        pnl_thb      DOUBLE PRECISION NOT NULL,
        fx_usdthb    DOUBLE PRECISION NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_ts
        ON portfolio_snapshots(ts);
    `,
  },
  {
    version: 10,
    name: 'binance_stables_as_cash',
    up: `
      -- Stop modelling Binance USDT/USDC/etc. as crypto positions. The
      -- live balance is now synthesized into a single Binance USDT-cash
      -- row by refreshBinance; legacy per-stable rows here would shadow
      -- it and inflate "By platform" Binance totals. Drop them.
      DELETE FROM positions
      WHERE platform = 'Binance'
        AND symbol IN ('USDT','USDC','BUSD','FDUSD','TUSD','DAI','USDP');

      -- Reset the withdrawals cursor so importWithdrawals re-walks the
      -- full history and books historical stable withdrawals as negative
      -- deposits (matching the BinanceTH→Binance USD-deposit treatment).
      -- Re-walks are idempotent because deposit rows dedupe on (platform,
      -- source) and the new source prefix is api-withdrawal:.
      DELETE FROM binance_sync_state WHERE endpoint = 'withdrawals';
    `,
  },
  {
    version: 11,
    name: 'fix_binance_commission_units',
    up: `
      -- Binance's /myTrades returns commission denominated in the
      -- commissionAsset (typically the base asset for BUYs). The old
      -- importer stored that raw number into trades.commission, but
      -- cost-basis.ts treats commission as USD — so BUYs paying 0.1% in
      -- the base asset booked phantom cost equal to ~0.1% of qty
      -- *interpreted as USD*. For LUNC that meant +$493 phantom cost on
      -- one trade, which the later SELLs realized as a -$1,093 loss.
      --
      -- Heuristic fix: if a Binance trade's stored commission would
      -- imply an absurd fee rate as USD (more than 5% of notional),
      -- it's definitely denominated in the base asset; recompute it as
      -- commQty × price_usd. Real fees are <=0.2% so this threshold is
      -- safe — it triggers ONLY on rows whose stored value is clearly
      -- in the wrong unit, and leaves rows already in USD untouched.
      -- BNB-paid fees (4e-05 BNB ≈ $0.03) fall below the threshold and
      -- stay tiny — a small under-count we accept; the importer fix
      -- (commissionToUSD) handles them correctly going forward.
      UPDATE trades
      SET commission = commission * price_usd
      WHERE platform = 'Binance'
        AND commission > 0
        AND price_usd > 0
        AND qty > 0
        AND commission > qty * price_usd * 0.05;
    `,
  },
  {
    version: 12,
    name: 'fix_binance_commission_units_moderate',
    up: `
      -- Migration 11 caught catastrophic cases (LUNC-style: stored
      -- commission > 5% of notional). But assets priced in the $0.2-$2
      -- range (DOGE, WLD, …) had base-denominated commissions that
      -- looked like ~0.5% fees as USD — too small to trip v11's
      -- threshold, too big to be real. Detect them by the per-qty rate
      -- instead: BUYs paying 0.1% in the base asset have commission/qty
      -- equal to exactly 0.001 (or 0.00075 for BNB-pay discount). USD-
      -- denominated commissions scale with price, so commission/qty
      -- depends on price and rarely sits exactly in [0.00075, 0.00125].
      --
      -- SELL filter: Binance's SELL default is quote-asset fee (USDT
      -- on /USDT pairs) which IS roughly USD, so SELLs aren't affected.
      -- Restricting to BUYs avoids false-corrections on quote-denom rows.
      --
      -- Notional > $1 guard: dust trades make the per-qty ratio noisy.
      --
      -- Idempotent: rows already in USD have commission/qty = 0.001 × price,
      -- which only falls inside [0.00075, 0.00125] when price ≈ $1, in
      -- which case multiplying by price is ~a no-op anyway.
      UPDATE trades
      SET commission = commission * price_usd
      WHERE platform = 'Binance'
        AND side = 'BUY'
        AND commission > 0
        AND price_usd > 0
        AND qty > 0
        AND qty * price_usd > 1
        AND commission / qty BETWEEN 0.00075 AND 0.00125;
    `,
  },
];

export async function runPgMigrations(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    );
  `);

  const { rows } = await pool.query<{ version: number }>('SELECT version FROM _migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));

  const client = await pool.connect();
  try {
    for (const m of PG_MIGRATIONS) {
      if (applied.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query(
          'INSERT INTO _migrations(version, name, applied_at) VALUES ($1, $2, $3)',
          [m.version, m.name, Date.now()],
        );
        await client.query('COMMIT');
        console.log(`[pg] applied migration ${m.version}: ${m.name}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    client.release();
  }
}
