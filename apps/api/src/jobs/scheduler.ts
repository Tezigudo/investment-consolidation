import cron from 'node-cron';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { refreshPrices } from '../services/prices.js';
import { getUSDTHB } from '../services/fx.js';
import { refreshBinance } from '../services/portfolio.js';
import { importBinanceHistory } from '../services/binance-import.js';
import { refreshDailyUSDTHB } from '../services/fx-history.js';

let started = false;

async function warmOnce() {
  try {
    const dime = db.prepare("SELECT DISTINCT symbol FROM trades WHERE platform = 'DIME'").all() as {
      symbol: string;
    }[];
    const binance = db
      .prepare("SELECT DISTINCT symbol FROM trades WHERE platform = 'Binance'")
      .all() as { symbol: string }[];
    await refreshPrices({
      stocks: dime.map((r) => r.symbol),
      crypto: binance.map((r) => r.symbol),
    });
    if (config.binanceEnabled) {
      const fx = await getUSDTHB();
      await refreshBinance(fx.rate);
    }
    console.log('[jobs] initial warm-up complete');
  } catch (e) {
    console.warn('[jobs] warm-up failed:', (e as Error).message);
  }
}

export function startJobs() {
  if (started) return;
  started = true;

  // Fire-and-forget warm-up so the first dashboard load isn't empty.
  void warmOnce();

  // Prices every 5 min (stocks) + crypto
  cron.schedule('*/5 * * * *', async () => {
    try {
      const dime = db.prepare("SELECT DISTINCT symbol FROM trades WHERE platform = 'DIME'").all() as {
        symbol: string;
      }[];
      const binance = db
        .prepare("SELECT DISTINCT symbol FROM trades WHERE platform = 'Binance'")
        .all() as { symbol: string }[];
      await refreshPrices({
        stocks: dime.map((r) => r.symbol),
        crypto: binance.map((r) => r.symbol),
      });
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
    const seeded = db.prepare('SELECT 1 FROM binance_sync_state LIMIT 1').get();
    if (!seeded) {
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
