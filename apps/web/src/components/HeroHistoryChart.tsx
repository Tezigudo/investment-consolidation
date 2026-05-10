import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type PortfolioHistoryPoint, type PortfolioHistoryResponse } from '../api/client';
import { AreaChart } from './charts';
import { fmtMoney } from '../lib/format';
import type { Currency } from '@consolidate/shared';

type Range = '1M' | '3M' | '6M' | '1Y' | 'ALL';
const RANGE_DAYS: Record<Range, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, ALL: Infinity };

interface ChartProps {
  currency: Currency;
  fallbackToday: { marketTHB: number; marketUSD: number; ts: number };
  pnlSign: number;
  history: PortfolioHistoryResponse | undefined;
}

// Real portfolio-history chart. Replaces the synthetic sine-wave the
// dashboard used to render. Series comes from /portfolio/history (which
// lazy-backfills from trades on first hit, then is fed by a 6-hourly
// snapshot cron). Range selection slices the series client-side so the
// chart and the delta strip share a single fetch.
export function HeroHistoryChart({ currency, fallbackToday, pnlSign, history }: ChartProps) {
  const [range, setRange] = useState<Range>('6M');

  const series = useMemo<PortfolioHistoryPoint[]>(() => {
    const all = history?.series ?? [];
    if (all.length === 0) {
      // Empty-series fallback: a single point at today so the chart
      // doesn't disappear before the first snapshot is written.
      return [
        {
          date: new Date(fallbackToday.ts).toISOString().slice(0, 10),
          ts: fallbackToday.ts,
          marketUSD: fallbackToday.marketUSD,
          marketTHB: fallbackToday.marketTHB,
          costUSD: 0,
          costTHB: 0,
          pnlUSD: 0,
          pnlTHB: 0,
          fxUSDTHB: 0,
        },
      ];
    }
    const days = RANGE_DAYS[range];
    if (days === Infinity) return all;
    return all.slice(-days);
  }, [history, range, fallbackToday.ts, fallbackToday.marketTHB, fallbackToday.marketUSD]);

  const pickY = (d: PortfolioHistoryPoint) => (currency === 'THB' ? d.marketTHB : d.marketUSD);
  const formatY = (d: PortfolioHistoryPoint) =>
    fmtMoney(pickY(d), currency, { dp: currency === 'THB' ? 0 : 2 });

  return (
    <div>
      <AreaChart
        data={series}
        pickY={pickY}
        color={pnlSign >= 0 ? 'var(--up)' : 'var(--down)'}
        gradId="hero-grad"
        height={110}
        formatY={formatY}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <MethodologyTip />
        <div style={{ display: 'flex', gap: 4 }}>
          {(Object.keys(RANGE_DAYS) as Range[]).map((r) => (
            <button
              key={r}
              className="pill"
              data-active={range === r}
              onClick={() => setRange(r)}
              style={{ fontSize: 10, padding: '3px 8px' }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface DeltaStripProps {
  currency: Currency;
  history: PortfolioHistoryResponse | undefined;
}

const DELTA_DEFS = [
  { key: 'today' as const, label: 'Today' },
  { key: 'week' as const, label: 'This week' },
  { key: 'month' as const, label: 'This month' },
  { key: 'ytd' as const, label: 'Year to date' },
];

// Today / week / month / YTD deltas. Computed server-side so on every
// fetch we get a coherent set of reference points (server picks the
// closest snapshot to each lookback date). When fewer than two snapshots
// exist — fresh install before the first cron tick — deltas are null and
// we render "—" rather than fake zeros.
export function DeltaStrip({ currency, history }: DeltaStripProps) {
  return (
    <div className="widget" style={{ padding: '14px 20px', marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
      {DELTA_DEFS.map((d) => {
        const v = history?.deltas?.[d.key];
        const value = v ? (currency === 'THB' ? v.thb : v.usd) : null;
        const tone = value == null ? 'neutral' : value >= 0 ? 'up' : 'down';
        const color = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : 'var(--muted)';
        return (
          <div key={d.key} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 3 }}>
              {d.label}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, color, lineHeight: 1.1 }}>
              {value == null ? '—' : fmtMoney(value, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })}
            </div>
            {v && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                {v.pct >= 0 ? '+' : '−'}
                {Math.abs(v.pct).toFixed(2)}%
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Single shared fetch — Dashboard calls this once and passes the response
// to both HeroHistoryChart and DeltaStrip. Pulls "ALL" so chart range
// selection is purely client-side and deltas always have enough history.
export function usePortfolioHistory() {
  return useQuery({
    queryKey: ['portfolio-history'],
    queryFn: () => api.portfolioHistory(3650),
    staleTime: 5 * 60_000,
  });
}

// Hover tooltip explaining the three classes of historical accuracy. The
// static-Binance approximation in particular is load-bearing — without
// this note a user looking at a flat USDT line for 5 years would
// reasonably read it as fact, when really their Earn balance grew over
// time from a smaller starting amount.
function MethodologyTip() {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <span style={{ fontSize: 10, color: 'var(--muted)', cursor: 'help' }}>
        ⓘ How is this computed?
      </span>
      {open && (
        <span
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px',
            width: 360,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            fontSize: 11,
            lineHeight: 1.55,
            color: 'var(--text)',
            textAlign: 'left',
            whiteSpace: 'normal',
          }}
        >
          Each daily point is computed from <b>real historical prices and FX</b>:
          <br />
          • <b>DIME stocks</b> — full trade replay; cost basis evolves with each BUY/SELL.
          <br />
          • <b>Binance + on-chain</b> — today's qty held, priced at each day's historical price. Cost is rescaled to current qty (the cron does this) so trade replay can't reproduce it; flat USDT lines mean "today's USDT balance × $1," not "you held this much USDT all along."
          <br />
          • <b>Bank cash</b> — today's THB amount; USD equivalent moves with each day's USDTHB.
          <br />
          <br />
          Days before a symbol's price cache exists fall back to its avg cost (PNL ≈ 0 for that window) rather than extrapolating with today's price.
        </span>
      )}
    </span>
  );
}
