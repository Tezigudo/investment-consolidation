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

// Symbols held on-chain that need a USDT price even though we never
// trade them through Binance. Keeps the crypto price refresh aware of
// off-exchange holdings so the dashboard always has a fresh quote.
const ONCHAIN_PRICED_SYMBOLS = ['WLD'];

// 180d matches the chart endpoint's default. Warmer windows == longer
// upstream calls; 180 keeps each backfill under ~1.5s for crypto.
// 365 days so the mobile PositionSheet's 1Y range stays cache-hot.
// Boot-warm is fire-and-forget — adding extra days only costs cron time
// (~2s per held symbol on Binance klines, sequential), not memory or
// machine size. Storage in prices_daily is trivial (a few KB per asset).
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
      if (!(await isBinanceSyncSeeded())) return;
      try {
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

  // Prices every 5 min (stocks) + crypto
  cron.schedule('*/5 * * * *', async () => {
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

  // Binance holdings every 5 min
  cron.schedule('*/5 * * * *', async () => {
    if (!config.binanceEnabled) return;
    try {
      const fx = await getUSDTHB();
      await refreshBinance(fx.rate);
      console.log('[jobs] binance holdings refreshed');
    } catch (e) {
      console.warn('[jobs] binance failed:', (e as Error).message);
    }
  });

  // On-chain WLD balance every 5 min — cheap (2-3 RPC reads), no key needed
  cron.schedule('*/5 * * * *', async () => {
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

  cron.schedule('30 2 * * *', () => {
    void warmDailyChartCache();
  });

  // Capture today's portfolio snapshot every 6 hours so the chart's
  // last point stays current within the day. Daily UTC snapshot row is
  // upserted (not appended), so over-frequent runs are fine.
  cron.schedule('0 */6 * * *', async () => {
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
  cron.schedule('0 * * * *', async () => {
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
  cron.schedule('15 * * * *', async () => {
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
}
