import type { FastifyInstance } from 'fastify';
import { buildSnapshot } from '../services/portfolio.js';
import {
  readSnapshots,
  backfillSnapshots,
  snapshotCount,
  captureSnapshotNow,
} from '../services/portfolio-history.js';

interface DeltaPoint {
  thb: number;
  usd: number;
  pct: number;
}

function delta(latest: number, prior: number): DeltaPoint {
  const thb = latest - prior;
  return { thb, usd: 0, pct: prior > 0 ? (thb / prior) * 100 : 0 };
}

// Compute today/week/month/YTD reference points by walking the series
// backward from the latest snapshot and finding the closest date that
// satisfies each lookback. Series is sorted ASC by date.
function computeDeltas(series: { date: string; marketTHB: number; marketUSD: number }[]) {
  if (series.length === 0) {
    return { today: null, week: null, month: null, ytd: null };
  }
  const latest = series[series.length - 1];
  const latestDate = new Date(latest.date + 'T00:00:00Z');
  const findOnOrBefore = (cutoff: Date): typeof latest | null => {
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].date <= cutoffStr) return series[i];
    }
    return null;
  };

  const yesterday = new Date(latestDate);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const lastWeek = new Date(latestDate);
  lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
  const lastMonth = new Date(latestDate);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const yearStart = new Date(Date.UTC(latestDate.getUTCFullYear(), 0, 1));

  const dThb = (prev: typeof latest | null): DeltaPoint | null => {
    if (!prev) return null;
    return {
      thb: latest.marketTHB - prev.marketTHB,
      usd: latest.marketUSD - prev.marketUSD,
      pct: prev.marketTHB > 0 ? ((latest.marketTHB - prev.marketTHB) / prev.marketTHB) * 100 : 0,
    };
  };

  return {
    today: dThb(findOnOrBefore(yesterday)),
    week: dThb(findOnOrBefore(lastWeek)),
    month: dThb(findOnOrBefore(lastMonth)),
    ytd: dThb(findOnOrBefore(yearStart)),
  };
}

export async function portfolioRoutes(app: FastifyInstance) {
  app.get('/portfolio', async (req) => {
    const refresh = (req.query as { refresh?: string })?.refresh === '1';
    return buildSnapshot({ refresh });
  });

  app.get<{ Querystring: { days?: string; backfill?: string } }>(
    '/portfolio/history',
    async (req) => {
      const days = Math.min(Math.max(Number(req.query.days) || 365, 7), 3650);
      // Lazy backfill on first call so the chart shows real data the
      // first time someone opens the dashboard after deploy. Subsequent
      // calls are cheap (just read from the snapshot table).
      if (await snapshotCount() < 2) {
        try {
          const r = await backfillSnapshots();
          req.log.info(
            `[portfolio-history] lazy backfill: +${r.inserted} inserted, ${r.updated} updated, ${r.days} days`,
          );
        } catch (e) {
          req.log.warn({ err: e }, '[portfolio-history] lazy backfill failed');
        }
      }
      // Force-rebackfill on demand. `?backfill=1` is fast (uses whatever
      // prices_daily already has). `?backfill=deep` extends the price +
      // FX caches to cover the full window before recomputing — slower
      // but accurate for the entire history. Use after a fresh import or
      // when you've just expanded coverage of new stock symbols.
      if (req.query.backfill === '1' || req.query.backfill === 'deep') {
        const r = await backfillSnapshots({ deepWarmPrices: req.query.backfill === 'deep' });
        req.log.info(
          `[portfolio-history] forced backfill (${req.query.backfill}): +${r.inserted} inserted, ${r.updated} updated`,
        );
      }
      const series = await readSnapshots(days);
      const deltas = computeDeltas(
        series.map((s) => ({ date: s.date, marketTHB: s.marketTHB, marketUSD: s.marketUSD })),
      );
      return { series, deltas };
    },
  );

  // Manual snapshot capture (dev/testing). Cron does this nightly.
  app.post('/portfolio/snapshot', async () => {
    return captureSnapshotNow();
  });

  app.get('/health', async () => ({ ok: true, ts: Date.now() }));
}

void delta; // legacy helper retained for future per-series breakdowns
