import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type IncomeBucket } from '../api/client';
import { fmtTHB, fmtUSD } from '../lib/format';

const KIND_COLOR: Record<string, string> = {
  earn: 'var(--accent-2)',           // Binance Earn
  vault: 'oklch(0.78 0.15 145)',      // On-chain vault yield
  airdrop: 'oklch(0.75 0.16 80)',     // Airdrops
  div: 'var(--accent)',               // Dividends (DIME REW + cash divs)
};

// Consolidated passive-income view: Earn rewards + dividends + vault yield
// + airdrops, all in one card. Source data already in DB; this just rolls
// it up + draws a small monthly bar chart.
export function IncomeCenter() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['income'],
    queryFn: () => api.income(),
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

  if (data.totalUSD <= 0.005) {
    return (
      <Wrap>
        <Header />
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>
          No income tracked yet. Earn rewards, dividends, and on-chain yield will appear here.
        </div>
      </Wrap>
    );
  }

  const breakdown = [
    { key: 'earn', label: 'Binance Earn', usd: data.byKind.earnUSD },
    { key: 'vault', label: 'Vault yield', usd: data.byKind.vaultUSD },
    { key: 'airdrop', label: 'Airdrops', usd: data.byKind.airdropUSD },
    { key: 'div', label: 'Dividends', usd: data.byKind.divUSD },
  ]
    .filter((r) => r.usd > 0.005)
    .sort((a, b) => b.usd - a.usd);

  const max = Math.max(...breakdown.map((r) => r.usd), 1);

  return (
    <Wrap>
      <Header />

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          Lifetime
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 500, color: 'var(--up)' }}>
            {fmtTHB(data.totalTHB, { sign: true, dp: 0 })}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
            {fmtUSD(data.totalUSD, { dp: 0 })}
          </div>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          YTD {fmtTHB(data.ytdTHB, { sign: true, dp: 0 })}
          {data.yieldOnCapitalPct > 0 && (
            <>
              {' · '}
              <span style={{ color: 'var(--text)' }}>
                {data.yieldOnCapitalPct.toFixed(2)}%
              </span>
              {' yield on capital (TTM)'}
            </>
          )}
        </div>
      </div>

      <MiniBars buckets={data.byMonth} />

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {breakdown.map((row) => {
          const pct = (row.usd / max) * 100;
          const totalPct = (row.usd / data.totalUSD) * 100;
          return (
            <div key={row.key}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 2,
                      background: KIND_COLOR[row.key],
                    }}
                  />
                  {row.label}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontFamily: 'var(--mono)', fontSize: 11 }}>
                  <span>{fmtUSD(row.usd, { dp: 0 })}</span>
                  <span style={{ color: 'var(--muted)' }}>{totalPct.toFixed(0)}%</span>
                </div>
              </div>
              <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: KIND_COLOR[row.key],
                    opacity: 0.85,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Wrap>
  );
}

// Small monthly-income bar chart. Stacked by kind so the user can see
// the mix shifting over time (e.g. when on-chain yield kicked in).
function MiniBars({ buckets }: { buckets: IncomeBucket[] }) {
  // Tail to last 18 months — anything older is rarely interesting and
  // would compress recent activity into invisibility.
  const tail = useMemo(() => buckets.slice(-18), [buckets]);
  const max = useMemo(() => Math.max(...tail.map((b) => b.totalUSD), 0.01), [tail]);
  const HEIGHT = 64;

  if (tail.length === 0) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: HEIGHT }}>
        {tail.map((b) => {
          const segs = [
            { c: KIND_COLOR.earn, h: (b.earnUSD / max) * HEIGHT },
            { c: KIND_COLOR.vault, h: (b.vaultUSD / max) * HEIGHT },
            { c: KIND_COLOR.airdrop, h: (b.airdropUSD / max) * HEIGHT },
            { c: KIND_COLOR.div, h: (b.divUSD / max) * HEIGHT },
          ].filter((s) => s.h > 0);
          return (
            <div
              key={b.month}
              title={`${b.month} · ${fmtUSD(b.totalUSD, { dp: 0 })}`}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column-reverse',
                minWidth: 4,
                gap: 1,
              }}
            >
              {segs.map((s, i) => (
                <div key={i} style={{ height: s.h, background: s.c, opacity: 0.9, borderRadius: i === segs.length - 1 ? '2px 2px 0 0' : 0 }} />
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
        <span>{tail[0]?.month ?? ''}</span>
        <span>{tail[tail.length - 1]?.month ?? ''}</span>
      </div>
    </div>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="widget" style={{ padding: '20px 22px' }}>{children}</div>;
}

function Header() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Income earned</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          Earn · vault yield · airdrops · dividends
        </div>
      </div>
    </div>
  );
}
