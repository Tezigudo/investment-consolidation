import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { fmtTHB, fmtUSD } from '../lib/format';

const PLAT_COLOR: Record<string, string> = {
  DIME: 'var(--accent)',
  Binance: 'var(--accent-2)',
  OnChain: 'oklch(0.78 0.15 145)',
  Bank: 'var(--muted-2)',
};

// "Capital invested" card. Surfaces the FX-locked deposits that
// underpin the entire true-baht PNL model. Three things matter:
//   1. how much THB the user actually committed (the baseline)
//   2. weighted-avg deposit FX vs today (FX-baseline drift)
//   3. per-platform split + a recent deposits list
export function DepositsLedger() {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['deposits'],
    queryFn: () => api.deposits(200),
    staleTime: 60_000,
  });

  if (isLoading || !data) {
    return (
      <Wrap>
        <Header />
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>
          {error ? `Failed: ${(error as Error).message}` : 'Loading…'}
        </div>
      </Wrap>
    );
  }
  const { rows, summary } = data;
  if (summary.count === 0) {
    return (
      <Wrap>
        <Header />
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>
          No deposits recorded. Sync DIME mail or Binance to populate.
        </div>
      </Wrap>
    );
  }

  const fxDriftPct = summary.weightedFX > 0
    ? ((summary.currentFX - summary.weightedFX) / summary.weightedFX) * 100
    : 0;
  const driftFavourable = fxDriftPct < 0; // current FX < locked → THB strengthened → user benefited
  const platforms = Object.entries(summary.byPlatform).sort((a, b) => b[1].totalTHB - a[1].totalTHB);
  const visibleRows = expanded ? rows : rows.slice(0, 6);

  return (
    <Wrap>
      <Header />

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr', gap: 14, marginBottom: 16 }}>
        <Stat
          label="Total committed"
          primary={fmtTHB(summary.totalTHB, { dp: 0 })}
          sub={`${fmtUSD(summary.totalUSD, { dp: 0 })} at lock-time FX`}
        />
        <Stat
          label="Weighted-avg FX"
          primary={summary.weightedFX.toFixed(2)}
          sub={
            <>
              now <span style={{ color: 'var(--muted)' }}>{summary.currentFX.toFixed(2)}</span>
              {' '}
              <span style={{ color: driftFavourable ? 'var(--up)' : 'var(--down)' }}>
                {fxDriftPct >= 0 ? '+' : '−'}
                {Math.abs(fxDriftPct).toFixed(1)}%
              </span>
            </>
          }
        />
        <Stat
          label="If un-converted today"
          primary={fmtUSD(summary.totalTHB / summary.currentFX, { dp: 0 })}
          sub={
            <span style={{ color: summary.fxBaselineDeltaUSD >= 0 ? 'var(--up)' : 'var(--down)' }}>
              {summary.fxBaselineDeltaUSD >= 0 ? '+' : '−'}
              {fmtUSD(Math.abs(summary.fxBaselineDeltaUSD), { dp: 0 })} vs lock
            </span>
          }
        />
      </div>

      {platforms.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden' }}>
            {platforms.map(([plat, p]) => {
              const pct = (p.totalTHB / summary.totalTHB) * 100;
              return (
                <div
                  key={plat}
                  title={`${plat}: ${fmtTHB(p.totalTHB, { dp: 0 })} · ${p.count} deposits`}
                  style={{
                    width: `${pct}%`,
                    background: PLAT_COLOR[plat] ?? 'var(--muted-2)',
                    opacity: 0.9,
                  }}
                />
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', fontSize: 11 }}>
            {platforms.map(([plat, p]) => (
              <div key={plat} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: PLAT_COLOR[plat] ?? 'var(--muted-2)' }} />
                <span>{plat}</span>
                <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                  {((p.totalTHB / summary.totalTHB) * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              <th style={{ textAlign: 'left', padding: '10px 0 8px' }}>Date</th>
              <th style={{ textAlign: 'left', padding: '10px 0 8px' }}>Platform</th>
              <th style={{ textAlign: 'right', padding: '10px 0 8px' }}>Amount THB</th>
              <th style={{ textAlign: 'right', padding: '10px 0 8px' }}>FX locked</th>
              <th style={{ textAlign: 'right', padding: '10px 0 8px' }}>Δ vs now</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const drift = ((summary.currentFX - r.fx_locked) / r.fx_locked) * 100;
              const date = new Date(Number(r.ts)).toISOString().slice(0, 10);
              return (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 0', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{date}</td>
                  <td style={{ padding: '8px 0' }}>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 600,
                        background: 'color-mix(in oklab, ' + (PLAT_COLOR[r.platform] ?? 'var(--muted-2)') + ' 16%, transparent)',
                        color: PLAT_COLOR[r.platform] ?? 'var(--muted-2)',
                      }}
                    >
                      {r.platform}
                    </span>
                  </td>
                  <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                    {fmtTHB(r.amount_thb, { dp: 0 })}
                  </td>
                  <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                    {r.fx_locked.toFixed(2)}
                  </td>
                  <td
                    style={{
                      padding: '8px 0',
                      textAlign: 'right',
                      fontFamily: 'var(--mono)',
                      color: drift < 0 ? 'var(--up)' : drift > 0 ? 'var(--down)' : 'var(--muted)',
                    }}
                  >
                    {drift >= 0 ? '+' : '−'}
                    {Math.abs(drift).toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > 6 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              marginTop: 8,
              padding: '6px 10px',
              fontSize: 11,
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--muted)',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
            }}
          >
            {expanded ? `Show recent 6` : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="widget" style={{ padding: '20px 22px' }}>{children}</div>;
}

function Header() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Capital invested</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          The FX-locked baseline behind every PNL number
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  primary,
  sub,
}: {
  label: string;
  primary: string;
  sub: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 19, fontWeight: 500 }}>{primary}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
        {sub}
      </div>
    </div>
  );
}
