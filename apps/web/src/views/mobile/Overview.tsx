import { useMemo } from 'react';
import { Donut, WinLossBar } from '../../components/charts';
import { fmtMoney, fmtPct, fmtTHB, fmtUSD } from '../../lib/format';
import { M } from './styles';
import type { Currency, EnrichedPosition, PortfolioSnapshot } from '@consolidate/shared';

interface Props {
  data: PortfolioSnapshot;
  currency: Currency;
  setCurrency: (c: Currency) => void;
  privacy: boolean;
  setPrivacy: (p: boolean) => void;
}

const SECTOR_COLORS: Record<string, string> = {
  Tech: 'oklch(0.72 0.15 250)',
  Semis: 'oklch(0.78 0.16 150)',
  Auto: 'oklch(0.75 0.14 55)',
  Retail: 'oklch(0.70 0.16 340)',
  ETF: 'oklch(0.68 0.10 200)',
  Crypto: 'oklch(0.75 0.16 80)',
  Stable: 'oklch(0.65 0.08 160)',
  Cash: 'oklch(0.60 0.04 80)',
  Other: 'var(--muted-2)',
};

export function Overview({ data, currency, setCurrency, privacy, setPrivacy }: Props) {
  const t = data.totals.all;
  const usdthb = data.fx.usdthb;

  const allPositions = useMemo(
    () => [
      ...data.positions.dime,
      ...data.positions.binance,
      ...data.positions.onchain,
    ],
    [data.positions]
  );

  const sectorSlices = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of allPositions) {
      const k = p.sector ?? 'Other';
      m.set(k, (m.get(k) ?? 0) + p.marketUSD);
    }
    if (data.totals.bank.marketUSD > 0) m.set('Cash', data.totals.bank.marketUSD);
    return Array.from(m.entries())
      .map(([label, value]) => ({ label, value, color: SECTOR_COLORS[label] ?? 'var(--muted-2)' }))
      .sort((a, b) => b.value - a.value);
  }, [allPositions, data.totals.bank.marketUSD]);

  const pnlOf = (p: EnrichedPosition) => (currency === 'THB' ? p.pnlTHB : p.pnlUSD);
  const topMovers = useMemo(
    () =>
      [...allPositions]
        .sort((a, b) => Math.abs(pnlOf(b)) - Math.abs(pnlOf(a)))
        .slice(0, 6)
        .map((p) => ({ sym: p.symbol, pnl: pnlOf(p) })),
    [allPositions, currency]
  );

  const market = currency === 'THB' ? t.marketTHB : t.marketUSD;
  const pnlCur = currency === 'THB' ? t.pnlTHB : t.pnlUSD;
  const costCur = currency === 'THB' ? t.costTHB : t.costUSD;
  const pnlPct = costCur > 0 ? (pnlCur / costCur) * 100 : 0;

  const veil = (s: string) => (privacy ? '••••' : s);

  return (
    <>
      <header style={M.header}>
        <div>
          <div style={M.title}>Consolidate</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
            {new Date(data.asOf).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · USDTHB {usdthb.toFixed(2)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setPrivacy(!privacy)}
            aria-label={privacy ? 'Show numbers' : 'Hide numbers'}
            style={M.iconBtn}
          >
            {privacy ? <EyeOff /> : <Eye />}
          </button>
          <CurrencySeg currency={currency} setCurrency={setCurrency} />
        </div>
      </header>

      <div style={M.scroll}>
        {/* Hero */}
        <div style={{ ...M.card, padding: '20px 18px' }}>
          <div style={M.eyebrow}>Net worth · {currency}</div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 36,
              fontWeight: 500,
              letterSpacing: -0.8,
              lineHeight: 1.05,
            }}
          >
            {veil(fmtMoney(market, currency, { dp: currency === 'THB' ? 0 : 2 }))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 14,
                color: pnlCur >= 0 ? 'var(--up)' : 'var(--down)',
              }}
            >
              {veil(fmtMoney(pnlCur, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 }))}
            </div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                padding: '2px 7px',
                borderRadius: 4,
                color: pnlCur >= 0 ? 'var(--up)' : 'var(--down)',
                background: pnlCur >= 0 ? 'var(--up-bg)' : 'var(--down-bg)',
              }}
            >
              {fmtPct(pnlPct)}
            </div>
          </div>
        </div>

        {/* True PNL breakdown — THB only since FX split is THB-native */}
        <div style={{ ...M.card, marginTop: 12 }}>
          <div style={M.eyebrow}>True PNL · breakdown</div>
          <BreakdownRow
            label="Market PNL"
            valueTHB={t.pnlTHB - t.fxContribTHB}
            sub={`${fmtUSD(t.pnlUSD, { sign: true })} · asset appreciation`}
            privacy={privacy}
          />
          <Divider />
          <BreakdownRow
            label="FX contribution"
            valueTHB={t.fxContribTHB}
            sub={`THB now ${usdthb.toFixed(2)}`}
            privacy={privacy}
          />
          <Divider />
          <BreakdownRow
            label="Realized · banked from sells"
            valueTHB={t.realizedTHB}
            sub={`${fmtUSD(t.realizedUSD, { sign: true })} · ${fmtTHB(t.realizedFxContribTHB, { sign: true })} from FX`}
            privacy={privacy}
          />
          <Divider />
          <BreakdownRow
            label="Total THB PNL"
            valueTHB={t.pnlTHB + t.realizedTHB}
            sub={`unrealized ${fmtTHB(t.pnlTHB, { sign: true })} + realized ${fmtTHB(t.realizedTHB, { sign: true })}`}
            privacy={privacy}
            bold
          />
        </div>

        {/* By platform */}
        <div style={M.section}>By platform</div>
        <div style={{ ...M.card, padding: '14px 16px' }}>
          {[
            { key: 'dime', name: 'DIME', sub: 'US stocks', color: 'var(--accent)', tot: data.totals.dime },
            { key: 'binance', name: 'Binance', sub: 'Crypto', color: 'var(--accent-2)', tot: data.totals.binance },
            { key: 'onchain', name: 'On-chain', sub: 'World Chain', color: 'oklch(0.78 0.15 145)', tot: data.totals.onchain },
            { key: 'bank', name: 'Bank', sub: 'THB cash', color: 'var(--muted-2)', tot: data.totals.bank },
          ]
            .filter((p) => p.tot.marketUSD > 0)
            .map((p, i, arr) => {
              const v = currency === 'THB' ? p.tot.marketTHB : p.tot.marketUSD;
              const pct = data.totals.all.marketUSD > 0
                ? (p.tot.marketUSD / data.totals.all.marketUSD) * 100
                : 0;
              const pnl = currency === 'THB' ? p.tot.pnlTHB : p.tot.pnlUSD;
              return (
                <div key={p.key} style={{ marginBottom: i < arr.length - 1 ? 14 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{p.sub}</span>
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                      {pct.toFixed(1)}%
                    </div>
                  </div>
                  <div
                    style={{
                      height: 6,
                      background: 'var(--surface-2)',
                      borderRadius: 3,
                      overflow: 'hidden',
                      marginTop: 6,
                    }}
                  >
                    <div style={{ width: `${pct}%`, height: '100%', background: p.color, opacity: 0.85 }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {veil(fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 }))}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 11,
                        color: pnl >= 0 ? 'var(--up)' : 'var(--down)',
                      }}
                    >
                      {fmtMoney(pnl, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>

        {/* Asset class donut */}
        <div style={M.section}>By asset class</div>
        <div style={M.card}>
          {sectorSlices.length === 0 ? (
            <div style={M.empty}>Import trades to see allocation.</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Donut
                slices={sectorSlices}
                size={130}
                thickness={16}
                centerLabel="Classes"
                centerValue={String(sectorSlices.length)}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, fontSize: 11 }}>
                {sectorSlices.slice(0, 6).map((s) => (
                  <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: s.color }} />
                    <span style={{ flex: 1 }}>{s.label}</span>
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                      {((s.value / (data.totals.all.marketUSD || 1)) * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Top movers */}
        <div style={M.section}>Top movers</div>
        <div style={M.card}>
          {topMovers.length === 0 ? (
            <div style={M.empty}>No positions yet.</div>
          ) : (
            <WinLossBar
              rows={topMovers}
              format={(n) => fmtMoney(n, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })}
            />
          )}
        </div>

        <div style={{ height: 24 }} />
      </div>
    </>
  );
}

function CurrencySeg({ currency, setCurrency }: { currency: Currency; setCurrency: (c: Currency) => void }) {
  return (
    <div style={M.segGroup}>
      {(['USD', 'THB', 'USDT'] as Currency[]).map((c) => (
        <button
          key={c}
          onClick={() => setCurrency(c)}
          style={{
            ...M.segBtn,
            ...(currency === c ? M.segBtnActive : {}),
          }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

function BreakdownRow({
  label,
  valueTHB,
  sub,
  privacy,
  bold,
}: {
  label: string;
  valueTHB: number;
  sub: string;
  privacy: boolean;
  bold?: boolean;
}) {
  const color = valueTHB >= 0 ? 'var(--up)' : 'var(--down)';
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: bold ? 22 : 18,
          fontWeight: 500,
          color,
        }}
      >
        {privacy ? '••••' : fmtTHB(valueTHB, { sign: true })}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
        {sub}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '12px 0' }} />;
}

function Eye() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A11 11 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.7 4.3" />
      <path d="M6.6 6.6A17 17 0 0 0 2 12s3.5 6 10 6c1.6 0 3-.3 4.3-.8" />
      <path d="M14.1 14.1a3 3 0 0 1-4.2-4.2" />
    </svg>
  );
}
