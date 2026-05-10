import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';
import { getUSDTHB } from '../services/fx.js';
import { getCachedPrices } from '../services/prices.js';

// Aggregated passive income across every source the system tracks:
//   1. Binance Earn rewards  — trades.source = 'api-reward'  (qty × price_usd)
//   2. DIME dividends + REW  — trades.side  = 'DIV'           (qty × price OR price if qty=0)
//   3. On-chain vault yield  — onchain_vault_state            (cumulative tokens × today price)
//   4. On-chain airdrops     — onchain_airdrop_state          (cumulative tokens × today price)
//
// Earn + DIV have per-event timestamps so they bucket cleanly into months.
// Vault yield is purely cumulative (we have no event log) — it lands in the
// current month. Airdrops carry first/last_ts so we spread their lifetime
// USD value evenly across the months they were received in.

interface IncomeBucket {
  month: string;
  earnUSD: number;
  vaultUSD: number;
  airdropUSD: number;
  divUSD: number;
  totalUSD: number;
}

function monthRange(start: Date, end: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (d <= stop) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

export async function incomeRoutes(app: FastifyInstance) {
  app.get('/income', async () => {
    const fx = await getUSDTHB(false);
    const currentFX = fx.rate;

    const [earnRes, divRes, vaultRes, airdropRes, capRes] = await Promise.all([
      pool.query<{ ts: string; usd: string }>(
        `SELECT ts, qty * price_usd AS usd
         FROM trades WHERE source = 'api-reward' AND qty > 0 AND price_usd > 0`,
      ),
      pool.query<{ ts: string; usd: string }>(
        `SELECT ts, CASE WHEN qty > 0 THEN qty * price_usd ELSE price_usd END AS usd
         FROM trades WHERE side = 'DIV'`,
      ),
      pool.query<{ symbol: string; yield_qty: string }>(
        `SELECT symbol,
                SUM(GREATEST(total_withdrawals_raw + current_assets_raw - total_deposits_raw, 0))
                  / POWER(10::numeric, decimals) AS yield_qty
         FROM onchain_vault_state GROUP BY symbol, decimals`,
      ),
      pool.query<{ symbol: string; received_qty: string; first_ts: string; last_ts: string }>(
        `SELECT symbol,
                SUM(total_received_raw) / POWER(10::numeric, decimals) AS received_qty,
                MIN(NULLIF(first_ts, 0)) AS first_ts,
                MAX(NULLIF(last_ts, 0))  AS last_ts
         FROM onchain_airdrop_state GROUP BY symbol, decimals`,
      ),
      pool.query<{ total_usd: string }>(
        `SELECT COALESCE(SUM(amount_usd), 0) AS total_usd FROM deposits`,
      ),
    ]);

    // Convert on-chain token quantities to USD via cached prices.
    const onchainSymbols = Array.from(
      new Set([
        ...vaultRes.rows.map((r) => r.symbol),
        ...airdropRes.rows.map((r) => r.symbol),
      ]),
    );
    const priceMap = onchainSymbols.length ? await getCachedPrices(onchainSymbols) : new Map();

    let earnUSD = 0;
    let divUSD = 0;
    let vaultUSD = 0;
    let airdropUSD = 0;

    const months = new Map<string, IncomeBucket>();
    const ensureMonth = (m: string): IncomeBucket => {
      let b = months.get(m);
      if (!b) {
        b = { month: m, earnUSD: 0, vaultUSD: 0, airdropUSD: 0, divUSD: 0, totalUSD: 0 };
        months.set(m, b);
      }
      return b;
    };

    for (const r of earnRes.rows) {
      const usd = Number(r.usd);
      earnUSD += usd;
      const m = new Date(Number(r.ts)).toISOString().slice(0, 7);
      const b = ensureMonth(m);
      b.earnUSD += usd;
      b.totalUSD += usd;
    }
    for (const r of divRes.rows) {
      const usd = Number(r.usd);
      divUSD += usd;
      const m = new Date(Number(r.ts)).toISOString().slice(0, 7);
      const b = ensureMonth(m);
      b.divUSD += usd;
      b.totalUSD += usd;
    }

    for (const r of vaultRes.rows) {
      const px = priceMap.get(r.symbol)?.price_usd ?? 0;
      const usd = Number(r.yield_qty) * px;
      if (usd <= 0) continue;
      vaultUSD += usd;
      // No event log for vault yield — drop the cumulative number into the
      // current month so it shows up *somewhere* on the timeline.
      const m = new Date().toISOString().slice(0, 7);
      const b = ensureMonth(m);
      b.vaultUSD += usd;
      b.totalUSD += usd;
    }

    for (const r of airdropRes.rows) {
      const px = priceMap.get(r.symbol)?.price_usd ?? 0;
      const totalUSD = Number(r.received_qty) * px;
      if (totalUSD <= 0) continue;
      airdropUSD += totalUSD;
      const fts = r.first_ts ? Number(r.first_ts) : 0;
      const lts = r.last_ts ? Number(r.last_ts) : 0;
      if (fts > 0 && lts > 0) {
        // Spread cumulative USD across the months between first/last receipt.
        // Inaccurate per-month, but better than dumping it all into "now".
        const buckets = monthRange(new Date(fts), new Date(lts));
        const per = totalUSD / Math.max(buckets.length, 1);
        for (const m of buckets) {
          const b = ensureMonth(m);
          b.airdropUSD += per;
          b.totalUSD += per;
        }
      } else {
        const m = new Date().toISOString().slice(0, 7);
        const b = ensureMonth(m);
        b.airdropUSD += totalUSD;
        b.totalUSD += totalUSD;
      }
    }

    const byMonth = Array.from(months.values()).sort((a, b) => a.month.localeCompare(b.month));

    // YTD + trailing 12mo derived from the monthly buckets, so vault/airdrop
    // contributions stay consistent with what the user sees on the chart.
    const now = new Date();
    const yearStart = `${now.getUTCFullYear()}-01`;
    const trail = new Date(now);
    trail.setUTCMonth(trail.getUTCMonth() - 11);
    const trail12moStart = trail.toISOString().slice(0, 7);
    let ytdUSD = 0;
    let trailing12moUSD = 0;
    for (const b of byMonth) {
      if (b.month >= yearStart) ytdUSD += b.totalUSD;
      if (b.month >= trail12moStart) trailing12moUSD += b.totalUSD;
    }

    const totalUSD = earnUSD + divUSD + vaultUSD + airdropUSD;
    const capitalInvestedUSD = Number(capRes.rows[0]?.total_usd ?? 0);
    const yieldOnCapitalPct =
      capitalInvestedUSD > 0 ? (trailing12moUSD / capitalInvestedUSD) * 100 : 0;

    return {
      totalUSD,
      totalTHB: totalUSD * currentFX,
      ytdUSD,
      ytdTHB: ytdUSD * currentFX,
      trailing12moUSD,
      capitalInvestedUSD,
      yieldOnCapitalPct,
      byKind: { earnUSD, vaultUSD, airdropUSD, divUSD },
      byMonth,
      currentFX,
    };
  });
}
