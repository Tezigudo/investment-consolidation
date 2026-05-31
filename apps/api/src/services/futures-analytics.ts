// Futures analytics: DB write path (cron) + read path (route).
//
// WRITE (cron, jobs/scheduler.ts):
//   refreshFuturesLive()  — fapi /v3/account + /v2/positionRisk → upsert
//                           futures_positions, throttled hourly snapshot.
//   syncFuturesIncome()   — incremental fapi /v1/income → futures_income.
//
// READ (route, routes/futures.ts):
//   buildFuturesAnalytics(rangeDays) — reads ONLY Postgres + bot_events and
//   assembles the FuturesAnalytics payload via the pure fns in futures-math.
//   It never calls Binance (hot-path discipline, per CLAUDE.md).

import type {
  FuturesAnalytics,
  FuturesAccountSummary,
  FuturesEquityPoint,
  FuturesPosition,
} from '@consolidate/shared';
import { pool } from '../db/client.js';
import { config } from '../config.js';
import {
  futuresReadable,
  fetchFuturesAccount,
  fetchFuturesPositions,
  fetchFuturesIncome,
} from './binance-futures.js';
import {
  summarizeIncome,
  pairBotTrades,
  deriveLegStats,
  reconcileEquity,
  type BotEventLite,
  type IncomeRow,
} from './futures-math.js';
import { botStatus } from './bot-events.js';

const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // persist equity ≤ 1×/hour
// Cold-start income reach-back: 365 days. After the first sync the cursor
// (max ts in futures_income) makes every later sync incremental.
const INCOME_COLD_START_MS = 365 * 24 * 60 * 60 * 1000;

// ── WRITE PATH ──────────────────────────────────────────────────────────────

/** Refresh live account balances + open positions. No-op if futures unreadable. */
export async function refreshFuturesLive(): Promise<{ skipped: boolean }> {
  if (!(await futuresReadable())) return { skipped: true };

  const [acct, positions] = await Promise.all([
    fetchFuturesAccount(),
    fetchFuturesPositions(),
  ]);
  const now = Date.now();

  // Hourly equity snapshot (append-only, throttled like heartbeat_snapshot).
  const { rows: last } = await pool.query<{ ts: string }>(
    'SELECT ts FROM futures_account_snapshot ORDER BY ts DESC LIMIT 1',
  );
  const lastTs = last.length ? Number(last[0].ts) : 0;
  if (now - lastTs >= SNAPSHOT_INTERVAL_MS) {
    await pool.query(
      `INSERT INTO futures_account_snapshot (ts, wallet_usd, margin_usd, unrealized_usd, available_usd)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (ts) DO NOTHING`,
      [now, acct.walletBalanceUsd, acct.marginBalanceUsd, acct.unrealizedPnlUsd, acct.availableBalanceUsd],
    );
  }

  // Mirror live positions: upsert the open set, delete anything now closed.
  const openSymbols = positions.map((p) => p.symbol);
  for (const p of positions) {
    await pool.query(
      `INSERT INTO futures_positions
         (symbol, position_side, position_amt, entry_price, mark_price, unrealized_usd, liq_price, leverage, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (symbol) DO UPDATE SET
         position_side=$2, position_amt=$3, entry_price=$4, mark_price=$5,
         unrealized_usd=$6, liq_price=$7, leverage=$8, updated_at=$9`,
      [p.symbol, p.positionSide, p.positionAmt, p.entryPrice, p.markPrice,
       p.unrealizedPnlUsd, p.liquidationPrice, p.leverage, now],
    );
  }
  if (openSymbols.length) {
    await pool.query(
      `DELETE FROM futures_positions WHERE symbol <> ALL($1::text[])`,
      [openSymbols],
    );
  } else {
    await pool.query('DELETE FROM futures_positions');
  }
  return { skipped: false };
}

/** Incremental income sync. Pulls forward from the latest stored ts. */
export async function syncFuturesIncome(): Promise<{ inserted: number; skipped: boolean }> {
  if (!(await futuresReadable())) return { inserted: 0, skipped: true };

  const { rows } = await pool.query<{ max: string | null }>(
    'SELECT MAX(ts)::text AS max FROM futures_income',
  );
  const lastTs = rows[0]?.max ? Number(rows[0].max) : 0;
  // First sync reaches back 1y; later syncs resume from the last row's ts.
  const startTime = lastTs > 0 ? lastTs : Date.now() - INCOME_COLD_START_MS;

  const incomes = await fetchFuturesIncome(startTime);
  let inserted = 0;
  for (const r of incomes) {
    const res = await pool.query(
      `INSERT INTO futures_income (dedup_id, tran_id, symbol, income_type, income_usd, asset, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedup_id) DO NOTHING`,
      [r.dedupId, r.tranId, r.symbol, r.incomeType, r.incomeUsd, r.asset, r.ts],
    );
    inserted += res.rowCount ?? 0;
  }
  return { inserted, skipped: false };
}

// ── INGEST PATH (droplet relay → DB) ────────────────────────────────────────
// The droplet reads the bot's real futures account (its own key + static IP)
// and POSTs here. These write the SAME tables refreshFuturesLive/syncFuturesIncome
// would, so the read path is identical regardless of source. Bearer-authed via
// the global hook. Input is already zod-validated by routes/futures.ts.

export interface IngestAccount {
  walletBalanceUsd: number;
  marginBalanceUsd: number;
  unrealizedPnlUsd: number;
  availableBalanceUsd: number;
}
export interface IngestPosition {
  symbol: string;
  positionSide: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnlUsd: number;
  liquidationPrice: number | null;
  leverage: number;
}
export interface IngestIncome {
  tranId: number;
  symbol: string;
  incomeType: string;
  incomeUsd: number;
  asset: string;
  ts: number;
}

/** Append one equity snapshot. Server-side throttle (≤1 row / ~hour) guards the
 *  table against a misconfigured droplet cron pushing far more often — the
 *  curve only needs hourly granularity, matching the heartbeat_snapshot pattern. */
export async function ingestFuturesAccountSnapshot(a: IngestAccount): Promise<{ stored: boolean }> {
  const now = Date.now();
  const { rows } = await pool.query<{ ts: string }>(
    'SELECT ts::text FROM futures_account_snapshot ORDER BY ts DESC LIMIT 1',
  );
  const lastTs = rows.length ? Number(rows[0].ts) : 0;
  // 50min floor (not a strict 60) so an on-the-hour cron never skips its own
  // tick due to a few seconds of drift.
  if (now - lastTs < 50 * 60 * 1000) return { stored: false };
  // Server clock for the curve's x-axis (consistent across droplet/Fly clocks).
  await pool.query(
    `INSERT INTO futures_account_snapshot (ts, wallet_usd, margin_usd, unrealized_usd, available_usd)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (ts) DO NOTHING`,
    [now, a.walletBalanceUsd, a.marginBalanceUsd, a.unrealizedPnlUsd, a.availableBalanceUsd],
  );
  return { stored: true };
}

/** Mirror the live open-position set (upsert open, delete closed). Wrapped in a
 *  transaction so a reader (or a concurrent push) never sees a half-applied set
 *  — e.g. positions deleted but not yet re-inserted. */
export async function ingestFuturesPositions(positions: IngestPosition[]): Promise<void> {
  const now = Date.now();
  const open = positions.map((p) => p.symbol);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of positions) {
      await client.query(
        `INSERT INTO futures_positions
           (symbol, position_side, position_amt, entry_price, mark_price, unrealized_usd, liq_price, leverage, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (symbol) DO UPDATE SET
           position_side=$2, position_amt=$3, entry_price=$4, mark_price=$5,
           unrealized_usd=$6, liq_price=$7, leverage=$8, updated_at=$9`,
        [p.symbol, p.positionSide, p.positionAmt, p.entryPrice, p.markPrice,
         p.unrealizedPnlUsd, p.liquidationPrice, p.leverage, now],
      );
    }
    if (open.length) {
      await client.query('DELETE FROM futures_positions WHERE symbol <> ALL($1::text[])', [open]);
    } else {
      await client.query('DELETE FROM futures_positions');
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Batch-insert income rows, deduped on the canonical tranId:incomeType:time key. */
export async function ingestFuturesIncome(rows: IngestIncome[]): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const r of rows) {
    const dedupId = `${r.tranId}:${r.incomeType}:${r.ts}`;
    const res = await pool.query(
      `INSERT INTO futures_income (dedup_id, tran_id, symbol, income_type, income_usd, asset, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedup_id) DO NOTHING`,
      [dedupId, r.tranId, r.symbol, r.incomeType, r.incomeUsd, r.asset, r.ts],
    );
    inserted += res.rowCount ?? 0;
  }
  return { inserted };
}

// ── READ PATH ─────────────────────────────────────────────────────────────

export async function buildFuturesAnalytics(rangeDays: number): Promise<FuturesAnalytics> {
  const now = Date.now();
  const since = now - rangeDays * 24 * 60 * 60 * 1000;

  // ── Account side (all from Postgres) ──
  const [latestSnap, snaps, incomeRows, posRows] = await Promise.all([
    pool.query<{ ts: string; wallet_usd: number; margin_usd: number; unrealized_usd: number; available_usd: number }>(
      'SELECT ts::text, wallet_usd, margin_usd, unrealized_usd, available_usd FROM futures_account_snapshot ORDER BY ts DESC LIMIT 1',
    ),
    pool.query<{ ts: string; wallet_usd: number; margin_usd: number }>(
      'SELECT ts::text, wallet_usd, margin_usd FROM futures_account_snapshot WHERE ts >= $1 ORDER BY ts ASC',
      [since],
    ),
    pool.query<{ income_type: string; income_usd: number; ts: string }>(
      'SELECT income_type, income_usd, ts::text FROM futures_income WHERE ts >= $1 ORDER BY ts ASC',
      [since],
    ),
    pool.query<{ symbol: string; position_side: string; position_amt: number; entry_price: number; mark_price: number; unrealized_usd: number; liq_price: number | null; leverage: number; updated_at: string }>(
      'SELECT * FROM futures_positions ORDER BY ABS(position_amt * mark_price) DESC',
    ),
  ]);

  const incomeLite: IncomeRow[] = incomeRows.rows.map((r) => ({
    incomeType: r.income_type,
    incomeUsd: Number(r.income_usd),
    ts: Number(r.ts),
  }));
  const inc = summarizeIncome(incomeLite);

  const snap = latestSnap.rows[0] ?? null;
  const account: FuturesAccountSummary = {
    available: snap != null,
    asOf: snap ? Number(snap.ts) : null,
    walletBalanceUsd: snap ? Number(snap.wallet_usd) : null,
    marginBalanceUsd: snap ? Number(snap.margin_usd) : null,
    unrealizedPnlUsd: snap ? Number(snap.unrealized_usd) : null,
    availableBalanceUsd: snap ? Number(snap.available_usd) : null,
    realizedPnlUsd: inc.realizedPnlUsd,
    fundingPaidUsd: inc.fundingPaidUsd,
    fundingReceivedUsd: inc.fundingReceivedUsd,
    fundingNetUsd: inc.fundingNetUsd,
    commissionUsd: inc.commissionUsd,
    netIncomeUsd: inc.netIncomeUsd,
  };

  const equityCurve: FuturesEquityPoint[] = snaps.rows.map((r) => ({
    ts: Number(r.ts),
    walletBalanceUsd: Number(r.wallet_usd),
    marginBalanceUsd: Number(r.margin_usd),
  }));

  const positions: FuturesPosition[] = posRows.rows.map((r) => ({
    symbol: r.symbol,
    positionSide: r.position_side,
    positionAmt: Number(r.position_amt),
    entryPrice: Number(r.entry_price),
    markPrice: Number(r.mark_price),
    unrealizedPnlUsd: Number(r.unrealized_usd),
    leverage: Number(r.leverage),
    liquidationPrice: r.liq_price != null ? Number(r.liq_price) : null,
    notionalUsd: Math.abs(Number(r.position_amt)) * Number(r.mark_price),
    updatedAt: Number(r.updated_at),
  }));

  // ── Bot side (from bot_events; always available) ──
  const evRows = await pool.query<{
    source: string; kind: string; side: 'long' | 'short' | null;
    qty: number | null; price_usd: number | null; notional_usd: number | null;
    equity_usd: number | null; bot_ts: string; strategy: string | null;
    payload: Record<string, unknown> | null;
  }>(
    `SELECT source, kind, side, qty, price_usd, notional_usd, equity_usd,
            bot_ts::text, strategy, payload
       FROM bot_events
      WHERE kind IN ('entry','exit','kill_switch','halt','boot_flatten')
        AND bot_ts >= $1
      ORDER BY bot_ts ASC`,
    [since],
  );
  const events: BotEventLite[] = evRows.rows.map((r) => ({
    source: r.source,
    kind: r.kind,
    side: r.side,
    qty: r.qty != null ? Number(r.qty) : null,
    price_usd: r.price_usd != null ? Number(r.price_usd) : null,
    notional_usd: r.notional_usd != null ? Number(r.notional_usd) : null,
    equity_usd: r.equity_usd != null ? Number(r.equity_usd) : null,
    bot_ts_ms: Number(r.bot_ts),
    strategy: r.strategy,
    payload: r.payload,
  }));
  const botTrades = pairBotTrades(events);

  // Live per-leg state (equity + halted) from bot-status, keyed by source.
  const { rows: srcRows } = await pool.query<{ source: string }>(
    'SELECT DISTINCT source FROM bot_events',
  );
  const live = new Map<string, { currentEquityUsd: number | null; isHalted: boolean }>();
  await Promise.all(
    srcRows.map(async ({ source }) => {
      try {
        const s = await botStatus(source);
        live.set(source, { currentEquityUsd: s.currentEquityUsd, isHalted: s.isHalted });
      } catch {
        live.set(source, { currentEquityUsd: null, isHalted: false });
      }
    }),
  );
  const botLegs = deriveLegStats(botTrades, live);

  // Bot equity curve from hourly heartbeat snapshots within range.
  const hbRows = await pool.query<{ source: string; bot_ts: string; equity_usd: number | null }>(
    `SELECT source, bot_ts::text, equity_usd
       FROM bot_events
      WHERE kind = 'heartbeat_snapshot' AND bot_ts >= $1 AND equity_usd IS NOT NULL
      ORDER BY bot_ts ASC`,
    [since],
  );
  const botEquityCurve = hbRows.rows.map((r) => ({
    ts: Number(r.bot_ts),
    equityUsd: Number(r.equity_usd),
    source: r.source,
  }));

  // Reconcile the Binance account value (margin balance ≈ wallet + uPnL)
  // against the sum of the bot legs' reported equity. Tolerates disjoint
  // accounts — see reconcileEquity. Compared at the account level because a
  // bot leg's equity already includes its open position's mark-to-market.
  const reconciliation = reconcileEquity(
    account.marginBalanceUsd,
    botLegs.map((l) => l.currentEquityUsd),
  );

  return {
    generatedAt: now,
    rangeDays,
    account,
    equityCurve,
    incomeByDay: inc.byDay,
    positions,
    botLegs,
    botTrades,
    botEquityCurve,
    reconciliation,
  };
}

/** Cheap flag for the route / boot log. */
export function futuresConfigured(): boolean {
  return config.binanceFuturesEnabled;
}
