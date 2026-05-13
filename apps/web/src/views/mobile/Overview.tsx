import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AreaChart, Donut, WinLossBar } from '../../components/charts';
import { api, type PortfolioHistoryResponse } from '../../api/client';
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

type ChartRange = '1M' | '3M' | '6M' | '1Y' | 'ALL';
const RANGE_DAYS: Record<ChartRange, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, ALL: Infinity };

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
  // Top Movers aggregates by ticker, summing unrealized PNL (open
  // positions) + lifetime realized PNL for that ticker. This is what
  // makes WLD show as net ~$1.18 instead of +$72.81 — the airdrop's
  // unrealized gain offsets against the closed-Binance realized loss.
  // Cash rows (USDT, USD) skipped — they're not "movers".
  const realizedBySymbol = data.realizedBySymbol ?? {};
  const topMovers = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of allPositions) {
      if (p.sector === 'Cash') continue;
      map.set(p.symbol, (map.get(p.symbol) ?? 0) + pnlOf(p));
    }
    for (const [sym, r] of Object.entries(realizedBySymbol)) {
      const add = currency === 'THB' ? r.realizedTHB : r.realizedUSD;
      map.set(sym, (map.get(sym) ?? 0) + add);
    }
    return [...map.entries()]
      .filter(([, pnl]) => Math.abs(pnl) >= (currency === 'THB' ? 1 : 0.5))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 6)
      .map(([sym, pnl]) => ({ sym, pnl }));
  }, [allPositions, currency, realizedBySymbol]);

  const idleBinanceUSD = useMemo(
    () =>
      data.positions.binance
        .filter((p) => p.sector === 'Cash')
        .reduce((acc, p) => acc + p.marketUSD, 0),
    [data.positions.binance]
  );

  const market = currency === 'THB' ? t.marketTHB : t.marketUSD;
  const pnlCur = currency === 'THB' ? t.pnlTHB : t.pnlUSD;
  const costCur = currency === 'THB' ? t.costTHB : t.costUSD;
  const pnlPct = costCur > 0 ? (pnlCur / costCur) * 100 : 0;

  const veil = (s: string) => (privacy ? '••••' : s);

  // Same key + same args as the desktop HeroHistoryChart so the in-process
  // cache is shared if the user resizes between layouts (and so the two
  // codepaths stay literally consistent in TanStack DevTools).
  const { data: history } = useQuery({
    queryKey: ['portfolio-history'],
    queryFn: () => api.portfolioHistory(3650),
    staleTime: 5 * 60_000,
  });

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
          <NetWorthSparkline
            history={history}
            currency={currency}
            pnlSign={pnlCur >= 0 ? 1 : -1}
            fallbackTHB={t.marketTHB}
            fallbackUSD={t.marketUSD}
            fallbackTs={data.asOf}
          />
        </div>

        {/* Today / week / month / YTD deltas */}
        <DeltaStripMobile history={history} currency={currency} />

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
          <TwrInline twr={history?.twr} />
        </div>

        {/* Risk: concentration + drawdown */}
        <div style={M.section}>Risk</div>
        <ConcentrationCard positions={allPositions} totalUSD={data.totals.all.marketUSD} currency={currency} privacy={privacy} />
        <DrawdownCard history={history} currency={currency} privacy={privacy} />

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
                  {p.key === 'binance' && idleBinanceUSD > 50 && !privacy && (
                    <IdleCashChip usd={idleBinanceUSD} usdthb={usdthb} />
                  )}
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

        {/* Income TTM */}
        <IncomeMobile />

        {/* Trading attribution */}
        <AttributionMobile privacy={privacy} />

        <div style={{ height: 24 }} />
      </div>
    </>
  );
}

// Compact net-worth chart with range pills, mirrors HeroHistoryChart but
// sized for mobile. Fallback values are taken as primitives (not an
// object) so the parent's per-render object literal doesn't churn the
// memo on every paint.
function NetWorthSparkline({
  history,
  currency,
  pnlSign,
  fallbackTHB,
  fallbackUSD,
  fallbackTs,
}: {
  history: PortfolioHistoryResponse | undefined;
  currency: Currency;
  pnlSign: number;
  fallbackTHB: number;
  fallbackUSD: number;
  fallbackTs: number;
}) {
  const [range, setRange] = useState<ChartRange>('6M');
  const series = useMemo(() => {
    const all = history?.series ?? [];
    if (all.length === 0) {
      return [
        {
          date: new Date(fallbackTs).toISOString().slice(0, 10),
          ts: fallbackTs,
          marketUSD: fallbackUSD,
          marketTHB: fallbackTHB,
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
  }, [history, range, fallbackTHB, fallbackUSD, fallbackTs]);

  const pickY = (d: { marketTHB: number; marketUSD: number }) =>
    currency === 'THB' ? d.marketTHB : d.marketUSD;
  const formatY = (d: { marketTHB: number; marketUSD: number }) =>
    fmtMoney(pickY(d), currency, { dp: currency === 'THB' ? 0 : 2 });

  return (
    <div style={{ marginTop: 14 }}>
      <AreaChart
        data={series}
        pickY={pickY}
        color={pnlSign >= 0 ? 'var(--up)' : 'var(--down)'}
        gradId="m-nw-grad"
        height={84}
        formatY={formatY}
      />
      <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
        {(Object.keys(RANGE_DAYS) as ChartRange[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            style={{
              ...M.pillBtn,
              padding: '4px 9px',
              fontSize: 10,
              ...(range === r ? M.pillBtnActive : {}),
            }}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}

const DELTA_DEFS = [
  { key: 'today' as const, label: 'Today' },
  { key: 'week' as const, label: 'Week' },
  { key: 'month' as const, label: 'Month' },
  { key: 'ytd' as const, label: 'YTD' },
];

function DeltaStripMobile({
  history,
  currency,
}: {
  history: PortfolioHistoryResponse | undefined;
  currency: Currency;
}) {
  return (
    <div
      style={{
        ...M.card,
        marginTop: 12,
        padding: '12px 14px',
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 8,
      }}
    >
      {DELTA_DEFS.map((d) => {
        const v = history?.deltas?.[d.key];
        const value = v ? (currency === 'THB' ? v.thb : v.usd) : null;
        const tone = value == null ? 'var(--muted)' : value >= 0 ? 'var(--up)' : 'var(--down)';
        return (
          <div key={d.key} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>
              {d.label}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 500, color: tone, lineHeight: 1.1 }}>
              {value == null ? '—' : fmtMoney(value, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })}
            </div>
            {v && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', marginTop: 1 }}>
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

function TwrInline({ twr }: { twr?: { ytd: number | null; oneYear: number | null; all: number | null } }) {
  if (!twr) return null;
  const fmt = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
  const tone = (v: number | null) => (v == null ? 'var(--muted)' : v >= 0 ? 'var(--up)' : 'var(--down)');
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10.5, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--muted)' }}>TWR</span>
      <span><span style={{ color: 'var(--muted)' }}>YTD </span><span style={{ color: tone(twr.ytd) }}>{fmt(twr.ytd)}</span></span>
      <span><span style={{ color: 'var(--muted)' }}>1Y </span><span style={{ color: tone(twr.oneYear) }}>{fmt(twr.oneYear)}</span></span>
      <span><span style={{ color: 'var(--muted)' }}>All </span><span style={{ color: tone(twr.all) }}>{fmt(twr.all)}</span></span>
    </div>
  );
}

function ConcentrationCard({
  positions,
  totalUSD,
  currency,
  privacy,
}: {
  positions: EnrichedPosition[];
  totalUSD: number;
  currency: Currency;
  privacy: boolean;
}) {
  if (totalUSD <= 0 || positions.length === 0) return null;
  const sorted = [...positions].sort((a, b) => b.marketUSD - a.marketUSD);
  const weights = sorted.map((p) => p.marketUSD / totalUSD);
  const hhi = weights.reduce((acc, w) => acc + w * w, 0) * 10000;
  const top1 = (weights[0] ?? 0) * 100;
  const top3 = weights.slice(0, 3).reduce((a, w) => a + w, 0) * 100;
  const verdict =
    hhi > 2500 ? { label: 'Concentrated', color: 'var(--down)' }
    : hhi > 1500 ? { label: 'Moderate', color: 'oklch(0.75 0.13 80)' }
    : { label: 'Diversified', color: 'var(--up)' };

  return (
    <div style={{ ...M.card, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={M.eyebrow}>Concentration</div>
        <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: verdict.color }}>
          HHI {hhi.toFixed(0)} · {verdict.label}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
        <ConcStat label="Top 1" pct={top1} />
        <ConcStat label="Top 3" pct={top3} />
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {sorted.slice(0, 3).map((p) => {
          const w = (p.marketUSD / totalUSD) * 100;
          const v = currency === 'THB' ? p.marketTHB : p.marketUSD;
          return (
            <div key={`${p.platform}:${p.symbol}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: 'var(--muted)' }}>{p.symbol}</span>
              <span style={{ fontFamily: 'var(--mono)' }}>
                {w.toFixed(1)}%
                <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
                  {privacy ? '•••' : fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 })}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConcStat({ label, pct }: { label: string; pct: number }) {
  const tone = pct >= 60 ? 'var(--down)' : pct >= 40 ? 'oklch(0.75 0.13 80)' : 'var(--up)';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 3 }}>
        <span style={{ color: 'var(--muted)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', color: tone }}>{pct.toFixed(1)}%</span>
      </div>
      <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: tone, opacity: 0.85 }} />
      </div>
    </div>
  );
}

function DrawdownCard({
  history,
  currency,
  privacy,
}: {
  history: PortfolioHistoryResponse | undefined;
  currency: Currency;
  privacy: boolean;
}) {
  const series = history?.series ?? [];
  if (series.length < 2) return null;

  const pickV = (p: { marketTHB: number; marketUSD: number }) =>
    currency === 'THB' ? p.marketTHB : p.marketUSD;

  let peak = pickV(series[0]);
  let peakAt = series[0].date;
  let maxDD = 0;
  let maxDDPct = 0;
  let maxDDAt = series[0].date;
  let maxDDFromPeak = peakAt;
  for (const p of series) {
    const v = pickV(p);
    if (v > peak) {
      peak = v;
      peakAt = p.date;
    }
    const dd = peak - v;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct > maxDDPct) {
      maxDD = dd;
      maxDDPct = ddPct;
      maxDDAt = p.date;
      maxDDFromPeak = peakAt;
    }
  }

  const last = series[series.length - 1];
  const lastV = pickV(last);
  const currentDD = peak - lastV;
  const currentDDPct = peak > 0 ? (currentDD / peak) * 100 : 0;

  return (
    <div style={M.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={M.eyebrow}>Drawdown</div>
        <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
          Peak {privacy ? '•••' : fmtMoney(peak, currency, { dp: currency === 'THB' ? 0 : 2 })} on {peakAt}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 4 }}>
        <DDStat label="Current" amount={currentDD} pct={currentDDPct} currency={currency} privacy={privacy} />
        <DDStat label="Max" amount={maxDD} pct={maxDDPct} currency={currency} privacy={privacy} subtitle={`${maxDDFromPeak} → ${maxDDAt}`} />
      </div>
    </div>
  );
}

function DDStat({
  label,
  amount,
  pct,
  currency,
  privacy,
  subtitle,
}: {
  label: string;
  amount: number;
  pct: number;
  currency: Currency;
  privacy: boolean;
  subtitle?: string;
}) {
  const tone = pct < 0.5 ? 'var(--up)' : pct < 5 ? 'var(--muted-2)' : pct < 15 ? 'oklch(0.75 0.13 80)' : 'var(--down)';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: tone }}>−{pct.toFixed(2)}%</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 9, color: 'var(--muted)' }}>{subtitle ?? ''}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          −{privacy ? '•••' : fmtMoney(amount, currency, { dp: currency === 'THB' ? 0 : 2 })}
        </span>
      </div>
    </div>
  );
}

function IdleCashChip({ usd, usdthb }: { usd: number; usdthb: number }) {
  const APY = 0.05;
  const yearlyTHB = usd * APY * usdthb;
  return (
    <div
      style={{
        marginTop: 8,
        fontSize: 10,
        color: 'var(--muted)',
        background: 'var(--surface-2)',
        borderRadius: 6,
        padding: '5px 7px',
        lineHeight: 1.4,
      }}
    >
      <span style={{ color: 'var(--text)' }}>${usd.toFixed(2)} idle in Spot</span>
      {' '}— ~฿{Math.round(yearlyTHB).toLocaleString()}/yr at 5% Earn APY
    </div>
  );
}

function IncomeMobile() {
  const { data } = useQuery({
    queryKey: ['income'],
    queryFn: () => api.income(),
    staleTime: 60_000,
  });
  if (!data || data.totalUSD <= 0.005) return null;

  // Anchor to the 1st of the month-11. setUTCMonth on the current day
  // overflows when day > target-month length (e.g. May 31 → April 31 →
  // rolls forward to May 1, dropping a month from the TTM bucket).
  const now = new Date();
  const trail = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const trailStart = trail.toISOString().slice(0, 7);
  const ttm = data.byMonth.reduce(
    (acc, m) => {
      if (m.month < trailStart) return acc;
      acc.earn += m.earnUSD;
      acc.vault += m.vaultUSD;
      acc.airdrop += m.airdropUSD;
      acc.div += m.divUSD;
      return acc;
    },
    { earn: 0, vault: 0, airdrop: 0, div: 0 },
  );
  const ttmUSD = ttm.earn + ttm.vault + ttm.airdrop + ttm.div;
  const ttmTHB = ttmUSD * data.currentFX;
  if (ttmUSD <= 0.005) return null;

  const parts = [
    { label: 'Earn', usd: ttm.earn },
    { label: 'Vault', usd: ttm.vault },
    { label: 'Airdrop', usd: ttm.airdrop },
    { label: 'Div', usd: ttm.div },
  ].filter((p) => p.usd > 0.5);

  return (
    <>
      <div style={M.section}>Income · TTM</div>
      <div style={M.card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 500, color: 'var(--up)' }}>
            {fmtTHB(ttmTHB, { sign: true, dp: 0 })}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
            {fmtUSD(ttmUSD, { dp: 0 })}
            {data.yieldOnCapitalPct > 0 && (
              <span> · {data.yieldOnCapitalPct.toFixed(2)}% on capital</span>
            )}
          </div>
        </div>
        {parts.length > 0 && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            {parts.map((p, i) => (
              <span key={p.label}>
                {i > 0 ? ' · ' : ''}
                {p.label} {fmtUSD(p.usd, { dp: 0 })}
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function AttributionMobile({ privacy }: { privacy: boolean }) {
  const { data } = useQuery({
    queryKey: ['attribution'],
    queryFn: () => api.attribution(),
    staleTime: 5 * 60_000,
  });
  if (!data || data.bySymbol.length === 0) return null;

  const tone = data.totalImpactUSD >= 0 ? 'var(--up)' : 'var(--down)';
  const top = data.bySymbol.slice(0, 4);

  return (
    <>
      <div style={M.section}>Trading attribution · USD</div>
      <div style={M.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>vs. "if you'd held everything"</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, color: tone }}>
            {privacy ? '•••' : fmtUSD(data.totalImpactUSD, { sign: true, dp: 2 })}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {top.map((r) => {
            const rowTone = r.tradingImpactUSD >= 0 ? 'var(--up)' : 'var(--down)';
            return (
              <div key={`${r.platform}:${r.symbol}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11 }}>
                <span>
                  <span style={{ fontWeight: 600 }}>{r.symbol}</span>
                  <span style={{ color: 'var(--muted)', marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 10 }}>
                    sold @ ${r.avgSellUSD.toFixed(2)} · now ${r.currentPriceUSD.toFixed(2)}
                  </span>
                </span>
                <span style={{ fontFamily: 'var(--mono)', color: rowTone }}>
                  {privacy ? '•••' : fmtUSD(r.tradingImpactUSD, { sign: true, dp: 2 })}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function CurrencySeg({ currency, setCurrency }: { currency: Currency; setCurrency: (c: Currency) => void }) {
  return (
    <div style={M.segGroup}>
      {(['THB', 'USD'] as Currency[]).map((c) => (
        <button
          key={c}
          onClick={() => setCurrency(c)}
          style={{ ...M.segBtn, ...(currency === c ? M.segBtnActive : {}) }}
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
  sub?: string;
  privacy: boolean;
  bold?: boolean;
}) {
  const color = valueTHB >= 0 ? 'var(--up)' : 'var(--down)';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</div>
        {sub && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
            {sub}
          </div>
        )}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: bold ? 18 : 15,
          fontWeight: bold ? 600 : 500,
          color,
        }}
      >
        {privacy ? '••••' : fmtTHB(valueTHB, { sign: true })}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '10px 0' }} />;
}

function Eye() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M22 12s-3.5 7-10 7a10.94 10.94 0 0 1-5.94-1.94" />
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    </svg>
  );
}
