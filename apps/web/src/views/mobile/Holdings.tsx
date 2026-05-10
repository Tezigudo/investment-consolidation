import { useMemo, useState } from 'react';
import { fmtMoney, fmtPct, fmtUSD } from '../../lib/format';
import { M } from './styles';
import type { CostView } from '../MobileShell';
import type { Currency, EnrichedPosition, PortfolioSnapshot, Platform } from '@consolidate/shared';

type Filter = 'All' | 'DIME' | 'Binance' | 'OnChain';

interface Props {
  data: PortfolioSnapshot;
  currency: Currency;
  privacy: boolean;
  costView: CostView;
  setCostView: (v: CostView) => void;
  onSelect: (p: EnrichedPosition) => void;
}

export function Holdings({ data, currency, privacy, costView, setCostView, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('All');

  const filtered = useMemo(() => {
    const out: EnrichedPosition[] = [];
    if (filter === 'All' || filter === 'DIME') out.push(...data.positions.dime);
    if (filter === 'All' || filter === 'Binance') out.push(...data.positions.binance);
    if (filter === 'All' || filter === 'OnChain') out.push(...data.positions.onchain);
    return out.sort((a, b) => b.marketUSD - a.marketUSD);
  }, [data.positions, filter]);

  const veil = (s: string) => (privacy ? '••••' : s);

  return (
    <>
      <header style={{ ...M.header, flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={M.title}>Holdings</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              {data.positions.dime.length + data.positions.binance.length + data.positions.onchain.length} positions
            </div>
          </div>
          <div style={M.segGroup}>
            {(['standard', 'dime'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setCostView(v)}
                style={{
                  ...M.segBtn,
                  ...(costView === v ? M.segBtnActive : {}),
                }}
                title={
                  v === 'standard'
                    ? 'Weighted-avg cost basis (preserved across sells).'
                    : 'FIFO. Matches the DIME app.'
                }
              >
                {v === 'standard' ? 'Standard' : 'DIME'}
              </button>
            ))}
          </div>
        </div>
        <div style={M.pillRow}>
          {(['All', 'DIME', 'Binance', 'OnChain'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                ...M.pillBtn,
                ...(filter === f ? M.pillBtnActive : {}),
              }}
            >
              {f === 'OnChain' ? 'On-chain' : f}
            </button>
          ))}
        </div>
      </header>

      <div style={M.scroll}>
        {filtered.length === 0 ? (
          <div style={{ ...M.card, ...M.empty, marginTop: 12 }}>
            No positions yet. Import a CSV from Activity, or set Binance keys in <code>.env</code>.
          </div>
        ) : (
          <div style={{ ...M.card, padding: 0, overflow: 'hidden' }}>
            {filtered.map((p, i) => (
              <Row
                key={`${p.platform}:${p.symbol}`}
                p={p}
                currency={currency}
                costView={costView}
                last={i === filtered.length - 1}
                onClick={() => onSelect(p)}
                veil={veil}
              />
            ))}
          </div>
        )}

        <div style={{ height: 24 }} />
      </div>
    </>
  );
}

function Row({
  p,
  currency,
  costView,
  last,
  onClick,
  veil,
}: {
  p: EnrichedPosition;
  currency: Currency;
  costView: CostView;
  last: boolean;
  onClick: () => void;
  veil: (s: string) => string;
}) {
  const isDimeView = costView === 'dime';
  const dimeAvgUSD = p.qty > 0 ? p.fifoCostUSD / p.qty : p.avgUSD;
  const avgShown = isDimeView ? dimeAvgUSD : p.avgUSD;
  const dimePnlUSD = p.marketUSD - p.fifoCostUSD;
  const dimePnlTHB = p.marketTHB - p.fifoCostTHB;
  const pnl = isDimeView
    ? currency === 'THB' ? dimePnlTHB : dimePnlUSD
    : currency === 'THB' ? p.pnlTHB : p.pnlUSD;
  const pnlPctShown = isDimeView
    ? p.fifoCostUSD > 0
      ? ((currency === 'THB' ? dimePnlTHB : dimePnlUSD) /
          (currency === 'THB' ? p.fifoCostTHB : p.fifoCostUSD)) *
        100
      : 0
    : p.pnlPct;
  const v = currency === 'THB' ? p.marketTHB : p.marketUSD;

  return (
    <button
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        gap: 12,
        padding: '14px 14px',
        background: 'transparent',
        border: 'none',
        borderBottom: last ? 'none' : '1px solid var(--border)',
        cursor: 'pointer',
        width: '100%',
        textAlign: 'left',
        color: 'var(--text)',
        fontFamily: 'var(--ui)',
      }}
    >
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        <PlatformChip platform={p.platform} symbol={p.symbol} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--mono)' }}>{p.symbol}</div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 180,
            }}
          >
            {p.qty} @ {fmtUSD(avgShown, { dp: avgShown < 10 ? 3 : 2 })}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 500 }}>
          {veil(fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 }))}
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: pnl >= 0 ? 'var(--up)' : 'var(--down)',
            marginTop: 2,
          }}
        >
          {fmtMoney(pnl, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })} · {fmtPct(pnlPctShown)}
        </div>
      </div>
    </button>
  );
}

function PlatformChip({ platform, symbol }: { platform: Platform; symbol: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    DIME: { bg: 'color-mix(in oklab, var(--accent) 14%, transparent)', fg: 'var(--accent)' },
    Binance: { bg: 'color-mix(in oklab, var(--accent-2) 14%, transparent)', fg: 'var(--accent-2)' },
    OnChain: {
      bg: 'color-mix(in oklab, oklch(0.78 0.15 145) 14%, transparent)',
      fg: 'oklch(0.78 0.15 145)',
    },
    Bank: { bg: 'var(--surface-2)', fg: 'var(--muted)' },
  };
  const c = colors[platform] ?? colors.Bank;
  const initial = symbol.slice(0, 2);
  return (
    <div
      style={{
        width: 38,
        height: 38,
        borderRadius: 10,
        background: c.bg,
        color: c.fg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}
