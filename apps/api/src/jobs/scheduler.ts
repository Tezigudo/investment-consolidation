import cron from 'node-cron';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { refreshPrices } from '../services/prices.js';
import { getUSDTHB } from '../services/fx.js';
import { refreshBinance } from '../services/portfolio.js';
import { importBinanceHistory, isBinanceSyncSeeded } from '../services/binance-import.js';
import { refreshDailyUSDTHB } from '../services/fx-history.js';
import { refreshOnChainWLD } from '../services/onchain.js';
import { warmDailyHistoryBatch } from '../services/price-history.js';
import { captureSnapshotNow, snapshotCount, backfillSnapshots } from '../services/portfolio-history.js';
import { refreshFuturesLive, syncFuturesIncome } from '../services/futures-analytics.js';
import { importDimeMail } from '../services/dime-mail.js';
import { isGmailConfigured, isGmailAuthed } from '../services/gmail-client.js';

// Symbols held on-chain that need a USDT price even though we never
// trade them through Binance. Keeps the crypto price refresh aware of
// off-exchange holdings so the dashboard always has a fresh quote.
const ONCHAIN_PRICED_SYMBOLS = ['WLD'];

// 365 days so the mobile PositionSheet's 1Y range stays cache-hot.
// Boot-warm is fire-and-forget — sequential klines calls cost ~2s per
// held symbol; storage in prices_daily is a few KB per asset.
const CHART_HISTORY_DAYS = 365;

let started = false;

async function distinctSymbols(platform: 'DIME' | 'Binance'): Promise<string[]> {
  const { rows } = await pool.query<{ symbol: string }>(
    'SELECT DISTINCT symbol FROM trades WHERE platform = $1',
    [platform],
  );
  return rows.map((r) => r.symbol);
}

function withOnChainCrypto(crypto: string[]): string[] {
  if (!config.onchainEnabled) return crypto;
  const set = new Set(crypto);
  for (const s of ONCHAIN_PRICED_SYMBOLS) set.add(s);
  return Array.from(set);
}

async function warmDailyChartCache() {
  try {
    const [stocks, crypto] = await Promise.all([
      distinctSymbols('DIME'),
      distinctSymbols('Binance'),
    ]);
    const entries = [
      ...stocks.map((symbol) => ({ symbol, kind: 'stock' as const })),
      ...withOnChainCrypto(crypto).map((symbol) => ({ symbol, kind: 'crypto' as const })),
    ];
    const r = await warmDailyHistoryBatch(entries, CHART_HISTORY_DAYS);
    console.log(`[jobs] chart cache warm: ${r.warmed} fetched, ${r.skipped} already warm`);
  } catch (e) {
    console.warn('[jobs] chart cache warm failed:', (e as Error).message);
  }
}

async function warmOnce() {
  try {
    const [stocks, crypto] = await Promise.all([
      distinctSymbols('DIME'),
      distinctSymbols('Binance'),
    ]);
    await refreshPrices({ stocks, crypto: withOnChainCrypto(crypto) });
    if (config.binanceEnabled) {
      const fx = await getUSDTHB();
      await refreshBinance(fx.rate);
    }
    if (config.onchainEnabled) {
      try {
        const snap = await refreshOnChainWLD();
        console.log(
          `[jobs] onchain WLD warmed: ${snap.totalQty.toFixed(6)} (wallet ${snap.walletQty.toFixed(6)} + ${snap.vaults.length} vault(s))`,
        );
      } catch (e) {
        console.warn('[jobs] onchain warm-up failed:', (e as Error).message);
      }
    }
    console.log('[jobs] initial warm-up complete');
  } catch (e) {
    console.warn('[jobs] warm-up failed:', (e as Error).message);
  }
}

export function startJobs() {
  if (started) return;
  started = true;

  void warmOnce();
  void warmDailyChartCache();

  // Incremental Binance history sync on server start (if already seeded).
  if (config.binanceEnabled) {
    void (async () => {
      try {
        // isBinanceSyncSeeded() must be INSIDE the try: it queries the DB, so
        // when the DB is down (e.g. Neon quota) it throws — and an uncaught
        // throw here is an unhandled rejection that CRASHES the whole process
        // (this crash-looped prod during the May 2026 Neon outage). Keep every
        // DB-touching boot await guarded so a down DB only degrades, never kills.
        if (!(await isBinanceSyncSeeded())) return;
        console.log('[jobs] binance history: incremental sync on startup…');
        const r = await importBinanceHistory();
        console.log(
          `[jobs] binance history startup sync done: +${r.counts.trades} trades, +${r.counts.deposits} deposits, +${r.counts.rewards} rewards (${(r.durationMs / 1000).toFixed(1)}s)`,
        );
      } catch (e) {
        console.warn('[jobs] binance history startup sync failed:', (e as Error).message);
      }
    })();
  }

  // Futures: one-shot warm on boot — lands the first equity snapshot and runs
  // the cold-start income backfill (reaches back 1y on an empty table).
  if (config.binanceFuturesEnabled) {
    void (async () => {
      try {
        await refreshFuturesLive();
        const r = await syncFuturesIncome();
        if (!r.skipped) console.log(`[jobs] futures warm-up: income +${r.inserted}`);
      } catch (e) {
        console.warn('[jobs] futures warm-up failed:', (e as Error).message);
      }
    })();
  }

  // Prices every 30 min (stocks + crypto). Batched with the binance + onchain
  // (+ futures) crons below on the same minute marks (`:07, :37`) so the Neon
  // compute wakes ONCE per cycle and can auto-suspend between bursts instead of
  // being pinned by separate jobs. Off the `:00` planet-wide spike per
  // CronCreate guidance — pick non-round minutes.
  // Cadence dropped 15 → 30 min (2026-05-31) to trim Neon free-tier compute:
  // halves the 24/7 cron wakes. Tradeoff: prices/holdings up to ~30 min stale,
  // fine for a passive monitoring dashboard. Pair with the lengthened web poll
  // intervals (usePortfolio/BotStatusCard) so the compute can actually suspend.
  // EVERY scheduled wake in this file lands on minute :07 (and :37 for the
  // twice-hourly one). That is not cosmetic — it is the whole compute budget.
  //
  // Neon suspends a compute after 5 minutes idle, so each DISTINCT minute-mark
  // costs ~5 minutes of active time whether the job takes 200 ms or 4 minutes.
  // Until 2026-09 these crons were spread over :00, :07, :15, :17 and :37 —
  // five wakes an hour, ~22 min/h of compute, ≈270 h/month. Collapsing them
  // onto one mark makes every job share a single wake: ~10 min/h, ≈120 h/month.
  // August 2026 burned 427 h, exhausted the free-tier quota, and every
  // DB-backed route returned 500 (Postgres 53000) for days.
  //
  // ⚠️ If you add a cron here, give it one of these marks. A new job on its own
  // minute costs 5 minutes of compute an hour no matter how small it is.
  const FAST_CRON = '7,37 * * * *';   // twice hourly, on the marks
  const HOURLY_CRON = '7 * * * *';    // hourly, same mark
  const SIX_HOURLY_CRON = '7 */6 * * *';

  cron.schedule(FAST_CRON, async () => {
    try {
      const [stocks, crypto] = await Promise.all([
        distinctSymbols('DIME'),
        distinctSymbols('Binance'),
      ]);
      await refreshPrices({ stocks, crypto: withOnChainCrypto(crypto) });
      console.log('[jobs] prices refreshed');
    } catch (e) {
      console.warn('[jobs] prices failed:', (e as Error).message);
    }
  });

  // Binance holdings — batched with prices on FAST_CRON for compute-suspend.
  cron.schedule(FAST_CRON, async () => {
    if (!config.binanceEnabled) return;
    try {
      const fx = await getUSDTHB();
      await refreshBinance(fx.rate);
      console.log('[jobs] binance holdings refreshed');
    } catch (e) {
      console.warn('[jobs] binance failed:', (e as Error).message);
    }
  });

  // Binance Futures account + positions — same FAST_CRON. The hourly equity
  // snapshot is throttled inside refreshFuturesLive (≤1 insert/hr) so this
  // doesn't bloat Neon. No-ops cleanly if the key lacks futures permission.
  cron.schedule(FAST_CRON, async () => {
    if (!config.binanceFuturesEnabled) return;
    try {
      const r = await refreshFuturesLive();
      if (!r.skipped) console.log('[jobs] futures live refreshed');
    } catch (e) {
      console.warn('[jobs] futures live failed:', (e as Error).message);
    }
  });

  // Futures income ledger (realized PnL / funding / commission) — incremental,
  // hourly. Cheap after the cold-start backfill (cursor = last stored ts).
  cron.schedule(HOURLY_CRON, async () => {
    if (!config.binanceFuturesEnabled) return;
    try {
      const r = await syncFuturesIncome();
      if (!r.skipped && r.inserted) console.log(`[jobs] futures income: +${r.inserted}`);
    } catch (e) {
      console.warn('[jobs] futures income failed:', (e as Error).message);
    }
  });

  // On-chain WLD balance — cheap RPC reads, also on FAST_CRON.
  cron.schedule(FAST_CRON, async () => {
    if (!config.onchainEnabled) return;
    try {
      const snap = await refreshOnChainWLD();
      console.log(
        `[jobs] onchain WLD: ${snap.totalQty.toFixed(6)} (wallet ${snap.walletQty.toFixed(6)} + ${snap.vaults.length} vault(s))`,
      );
    } catch (e) {
      console.warn('[jobs] onchain failed:', (e as Error).message);
    }
  });

  cron.schedule('7 2 * * *', () => {
    void warmDailyChartCache();
  });

  // Capture today's portfolio snapshot every 6 hours so the chart's
  // last point stays current within the day. Daily UTC snapshot row is
  // upserted (not appended), so over-frequent runs are fine.
  cron.schedule(SIX_HOURLY_CRON, async () => {
    try {
      const s = await captureSnapshotNow();
      console.log(`[jobs] portfolio snapshot ${s.date}: ${s.marketTHB.toFixed(0)} THB`);
    } catch (e) {
      console.warn('[jobs] portfolio snapshot failed:', (e as Error).message);
    }
  });

  // Lazy backfill on boot if the snapshots table is empty. After this,
  // the daily cron carries it forward; the API's /portfolio/history
  // endpoint also self-heals on cold cache.
  void (async () => {
    try {
      if ((await snapshotCount()) < 2) {
        console.log('[jobs] portfolio snapshots empty — running backfill with deep price warm (one-time)…');
        const r = await backfillSnapshots({ deepWarmPrices: true });
        console.log(
          `[jobs] portfolio snapshot backfill: +${r.inserted} inserted, ${r.updated} updated, ${r.days} days`,
        );
      } else {
        // Always capture *today* on boot so the latest point is fresh
        // even if the 6h cron hasn't fired in this process yet.
        await captureSnapshotNow();
      }
    } catch (e) {
      console.warn('[jobs] snapshot warm-up failed:', (e as Error).message);
    }
  })();

  // FX every hour (live + daily series tail)
  cron.schedule(HOURLY_CRON, async () => {
    try {
      await getUSDTHB(true);
      await refreshDailyUSDTHB();
      console.log('[jobs] fx refreshed');
    } catch (e) {
      console.warn('[jobs] fx failed:', (e as Error).message);
    }
  });

  // Incremental Binance history pull every hour. Uses persisted
  // cursors in binance_sync_state so after the initial backfill each
  // run only picks up what's new since the last cursor ts.
  //
  // Gated on `binance_sync_state` containing at least one row — the
  // 5-year first-ever backfill can take 20-40 min and shouldn't happen
  // inside an unattended cron tick. User must run
  // `bun run import:binance` once manually; afterwards this runs incrementally.
  cron.schedule(HOURLY_CRON, async () => {
    if (!config.binanceEnabled) return;
    if (!(await isBinanceSyncSeeded())) {
      console.log(
        '[jobs] binance history: no cursors yet — run `bun run import:binance` once before cron takes over',
      );
      return;
    }
    try {
      const r = await importBinanceHistory();
      console.log(
        `[jobs] binance history synced: +${r.counts.trades} trades, +${r.counts.deposits} deposits, +${r.counts.rewards} rewards`,
      );
    } catch (e) {
      console.warn('[jobs] binance history failed:', (e as Error).message);
    }
  });

  // DIME mail (Gmail) — parse broker statement emails every 6 hours.
  // Dime sends a few times/week; 6h gives prompt freshness without
  // spamming Gmail. Gated on Gmail credentials + cached OAuth token so
  // the cron no-ops cleanly when auth is missing or expired.
  cron.schedule(SIX_HOURLY_CRON, async () => {
    if (!isGmailConfigured()) {
      console.log('[jobs] dime mail: Gmail credentials not configured — skipping');
      return;
    }
    if (!isGmailAuthed()) {
      console.log(
        '[jobs] dime mail: Gmail not authorized — run `bun run import:dime-mail -- --auth` first',
      );
      return;
    }
    try {
      const r = await importDimeMail({ interactive: false });
      console.log(
        `[jobs] dime mail synced: +${r.counts.trades} trades, +${r.counts.deposits} deposits`,
      );
    } catch (e) {
      console.warn('[jobs] dime mail failed:', (e as Error).message);
    }
  });
}
