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
  {
    version: 13,
    name: 'bot_events',
    up: `
      -- External trading bots (currently snapback-btc on a DO droplet)
      -- POST events to /bot-event as they happen — boots, heartbeats,
      -- dry-run signals, live entries/exits, kill-switch fires. We log
      -- the full event payload here so the dashboard can show "is my
      -- bot alive?" without polling the bot directly. The bot is the
      -- source of truth; this is a rolling read-only log.
      --
      -- (source, external_id) is the dedup key: the bots outbox uses
      -- a monotonic id so retries from a queued outbox do not double-
      -- write. Multiple bots can coexist by varying the source column.
      CREATE TABLE IF NOT EXISTS bot_events (
        id            BIGSERIAL PRIMARY KEY,
        source        TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        bot_ts        BIGINT NOT NULL,            -- ms epoch from the bots clock
        received_at   BIGINT NOT NULL,            -- ms epoch when API ingested it
        kind          TEXT NOT NULL CHECK (kind IN (
          'boot', 'heartbeat', 'dry_run_signal',
          'entry', 'exit',
          'kill_switch', 'halt', 'boot_flatten',
          'order_failed', 'signal_skipped'
        )),
        signal_id     TEXT,                       -- snap-v1-<root> for tradeable events; NULL otherwise
        strategy      TEXT,                       -- multifactor-v1 etc.
        side          TEXT CHECK (side IN ('long','short') OR side IS NULL),
        qty           DOUBLE PRECISION CHECK (qty IS NULL OR qty >= 0),
        price_usd     DOUBLE PRECISION CHECK (price_usd IS NULL OR price_usd > 0),
        notional_usd  DOUBLE PRECISION CHECK (notional_usd IS NULL OR notional_usd >= 0),
        equity_usd    DOUBLE PRECISION CHECK (equity_usd IS NULL OR equity_usd >= 0),
        payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (source, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_events_bot_ts     ON bot_events(bot_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_events_signal_id  ON bot_events(signal_id);
      CREATE INDEX IF NOT EXISTS idx_bot_events_kind       ON bot_events(kind);
      CREATE INDEX IF NOT EXISTS idx_bot_events_source_ts  ON bot_events(source, bot_ts DESC);
    `,
  },
  {
    version: 14,
    name: 'bot_events_kind_add_heartbeat_snapshot',
    up: `
      -- Extend the kind CHECK constraint to allow 'heartbeat_snapshot'.
      -- This kind is API-internal — the bot still POSTs kind='heartbeat',
      -- and bot-events.ts rewrites it to 'heartbeat_snapshot' on the hourly
      -- persistence path so the cleanup script can safely target legacy
      -- rows (kind='heartbeat') without nuking the new equity-history rows.
      --
      -- Postgres' default name for an unnamed column CHECK is
      -- <table>_<column>_check, so the DROP is deterministic. The IF EXISTS
      -- keeps this idempotent if a re-run ever hits the new state.
      ALTER TABLE bot_events DROP CONSTRAINT IF EXISTS bot_events_kind_check;
      ALTER TABLE bot_events ADD CONSTRAINT bot_events_kind_check CHECK (kind IN (
        'boot', 'heartbeat', 'heartbeat_snapshot', 'dry_run_signal',
        'entry', 'exit',
        'kill_switch', 'halt', 'boot_flatten',
        'order_failed', 'signal_skipped'
      ));
    `,
  },
  {
    version: 15,
    name: 'futures_analytics',
    up: `
      -- USDT-M Futures account analytics. Written by the futures cron in
      -- jobs/scheduler.ts from fapi (fapi /v3/account, /v2/positionRisk,
      -- /v1/income). The /futures/analytics read endpoint reads ONLY these
      -- tables (hot-path discipline) — it never calls Binance.

      -- Append-only equity history. One row per hourly snapshot (the cron
      -- throttles inserts to ~1/hr, mirroring the heartbeat_snapshot pattern,
      -- so this stays small on Neon's free tier).
      CREATE TABLE IF NOT EXISTS futures_account_snapshot (
        ts              BIGINT PRIMARY KEY,        -- ms since epoch
        wallet_usd      DOUBLE PRECISION NOT NULL, -- totalWalletBalance
        margin_usd      DOUBLE PRECISION NOT NULL, -- totalMarginBalance (wallet + uPnL)
        unrealized_usd  DOUBLE PRECISION NOT NULL, -- totalUnrealizedProfit
        available_usd   DOUBLE PRECISION NOT NULL  -- availableBalance
      );

      -- Current open positions. Upserted by symbol each cron tick; rows for
      -- positions that have closed are deleted so the table mirrors live state.
      CREATE TABLE IF NOT EXISTS futures_positions (
        symbol          TEXT PRIMARY KEY,
        position_side   TEXT NOT NULL,
        position_amt    DOUBLE PRECISION NOT NULL, -- signed; < 0 short
        entry_price     DOUBLE PRECISION NOT NULL,
        mark_price      DOUBLE PRECISION NOT NULL,
        unrealized_usd  DOUBLE PRECISION NOT NULL,
        liq_price       DOUBLE PRECISION,          -- null when flat / not applicable
        leverage        DOUBLE PRECISION NOT NULL,
        updated_at      BIGINT NOT NULL            -- ms
      );

      -- Income ledger (realized PnL, funding, commission, transfers, …).
      -- dedup_id = tranId:incomeType:time (tranId is unique per income type per
      -- user; the composite also guards same-ms cross-symbol funding). income
      -- is stored signed exactly as Binance returns it (funding < 0 = paid).
      CREATE TABLE IF NOT EXISTS futures_income (
        dedup_id     TEXT PRIMARY KEY,
        tran_id      BIGINT NOT NULL,
        symbol       TEXT NOT NULL DEFAULT '',
        income_type  TEXT NOT NULL,
        income_usd   DOUBLE PRECISION NOT NULL,
        asset        TEXT NOT NULL,
        ts           BIGINT NOT NULL              -- ms (event time)
      );
      CREATE INDEX IF NOT EXISTS idx_futures_income_ts ON futures_income(ts);
      CREATE INDEX IF NOT EXISTS idx_futures_income_type ON futures_income(income_type);
    `,
  },
  {
    version: 16,
    name: 'bot_events_kind_add_daily_loss_breaker',
    up: `
      -- Extend the kind CHECK constraint to allow 'daily_loss_breaker'.
      -- This kind is emitted by snapback-btc's daily-loss circuit breaker
      -- (risk.check_daily_loss): when intraday drawdown hits MAX_DAILY_LOSS_PCT
      -- (2%) the bot enqueues this event to notify the dashboard that new
      -- entries are blocked until the next UTC midnight.
      --
      -- Pattern mirrors migration 14 (heartbeat_snapshot): drop the existing
      -- named constraint, recreate with the expanded set. IF EXISTS makes this
      -- idempotent on re-run.
      ALTER TABLE bot_events DROP CONSTRAINT IF EXISTS bot_events_kind_check;
      ALTER TABLE bot_events ADD CONSTRAINT bot_events_kind_check CHECK (kind IN (
        'boot', 'heartbeat', 'heartbeat_snapshot', 'dry_run_signal',
        'entry', 'exit',
        'kill_switch', 'halt', 'boot_flatten',
        'order_failed', 'signal_skipped',
        'daily_loss_breaker'
      ));
    `,
  },
  {
    version: 17,
    name: 'dime_usd_withdrawals',
    up: `
      -- Cash withdrawn OUT of the DIME settlement wallet (proceeds that
      -- left the investment world entirely — e.g. moved to a bank to pay
      -- a bill). buildDimeCashRow synthesises idle DIME USD purely from
      -- trades as sum(SELL) − sum(BUY); it has no way to know the user
      -- later pulled that USD out, so it kept showing phantom idle cash.
      -- This ledger lets the cash-row calc subtract withdrawals:
      --   usd = sum(SELL) − sum(BUY) − sum(withdrawals).
      --
      -- Deliberately its OWN table, NOT a negative row in deposits:
      -- income.ts sums SUM(amount_usd) FROM deposits for the income stat,
      -- deposits.ts lists them, and portfolio-history reads MIN(ts) — a
      -- withdrawal booked there would corrupt all three. Zero blast radius.
      --
      -- UNIQUE(source) makes hand-entered inserts idempotent (ON CONFLICT
      -- (source) DO NOTHING). Schema only — no data seeded here.
      CREATE TABLE IF NOT EXISTS dime_usd_withdrawals (
        id          BIGSERIAL PRIMARY KEY,
        amount_usd  NUMERIC NOT NULL,
        ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
        note        TEXT,
        source      TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dime_usd_withdrawals_source
        ON dime_usd_withdrawals(source);
    `,
  },
  {
    // v18, not 17: prod already had v17 = dime_usd_withdrawals (the migration
    // above — deployed from a worktree before this branch merged) when the
    // futures-brackets work landed, so it took the next free number. Both now
    // sit in the array in version order; on prod both are already applied, on a
    // fresh DB both run in sequence. (Origin of the divergence: the dime v37/v38
    // work was deployed but unmerged — see project_dime_sync_gap.)
    version: 18,
    name: 'futures_positions_resting_brackets',
    up: `
      -- Ground-truth resting reduce-only bracket orders (SL/TP) for each open
      -- position. The droplet relay (tools/consolidate_futures_push.py) fetches
      -- /fapi/v1/openOrders and matches STOP_MARKET → sl_price,
      -- TAKE_PROFIT_MARKET → tp_price by symbol. Nullable: donchian legs place
      -- SL only (tp_price stays NULL), and old relays that don't push these
      -- leave both NULL. Additive + idempotent so prod applies cleanly.
      ALTER TABLE futures_positions ADD COLUMN IF NOT EXISTS sl_price DOUBLE PRECISION;
      ALTER TABLE futures_positions ADD COLUMN IF NOT EXISTS tp_price DOUBLE PRECISION;
    `,
  },
  {
    version: 19,
    name: 'futures_positions_margin_usd',
    up: `
      -- Margin actually tied up by each open position (isolatedWallet when
      -- isolated, positionInitialMargin in cross mode). Pushed by the droplet
      -- relay alongside the leverage fix: Binance's /fapi/v3 position payload
      -- dropped the leverage field, so the relay now reads /fapi/v1/symbolConfig
      -- and sends real leverage + margin. Nullable: old relays don't push it.
      ALTER TABLE futures_positions ADD COLUMN IF NOT EXISTS margin_usd DOUBLE PRECISION;
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

  // Fast path: if the head migration AND all earlier migrations are applied,
  // every Fly cold-start is just the two cheap queries above — no dedicated
  // `pool.connect()`, no BEGIN/COMMIT pair, no transaction overhead. Saves a
  // connect round-trip per redeploy and lets the Neon compute stay parked
  // sooner. The full-coverage check guards against a sparse `applied` set
  // (e.g. partial manual application, leftovers from the historical sqlite→pg
  // cutover the file header describes) where head=true but earlier=missing.
  const head = PG_MIGRATIONS[PG_MIGRATIONS.length - 1];
  if (head && applied.has(head.version)) {
    const missingEarlier = PG_MIGRATIONS.some(
      (m) => m.version < head.version && !applied.has(m.version),
    );
    if (!missingEarlier) return;
  }

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
