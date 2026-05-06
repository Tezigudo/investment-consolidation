import { useMemo, useState } from 'react';
import { usePortfolio, useTrades } from '../hooks/usePortfolio';
import { fmtMoney, fmtPct, fmtTHB, fmtUSD } from '../lib/format';
import { TopBar } from '../components/TopBar';
import { SettingsPopover } from '../components/SettingsPopover';
import { DashboardSkeleton } from '../components/DashboardSkeleton';
import { Toast } from '../components/Toast';
import { DualHeroCell } from '../components/DualHeroCell';
import { Donut, WinLossBar, AreaChart } from '../components/charts';
import { PriceModal } from '../components/PriceModal';
import { CsvUpload } from '../components/CsvUpload';
import type { Currency, EnrichedPosition, TradeRow } from '@consolidate/shared';

interface Props {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  privacy: boolean;
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
};

export function Dashboard({ currency, setCurrency, privacy }: Props) {
  const { data: snap, isLoading, error } = usePortfolio();
  const { data: trades } = useTrades();
  const [selected, setSelected] = useState<EnrichedPosition | null>(null);
  const [filter, setFilter] = useState<'All' | 'DIME' | 'Binance' | 'OnChain'>('All');
  const [costView, setCostView] = useState<'standard' | 'dime'>('standard');

  const t = snap?.totals.all;
  // Synthesize a flat baseline series for the hero chart (true history
  // would come from a snapshots table; omitted from MVP). Indexed to today.
  const mockSeries = useMemo(() => {
    if (!t) return [] as { t: number; value: number }[];
    const base = currency === 'THB' ? t.costTHB : t.costUSD;
    const end = currency === 'THB' ? t.marketTHB : t.marketUSD;
    const out: { t: number; value: number }[] = [];
    const days = 60;
    const now = Date.now();
    for (let i = 0; i < days; i++) {
      const p = i / (days - 1);
      const noise = Math.sin(i * 0.5) * 0.015 + Math.sin(i * 0.17) * 0.02;
      out.push({ t: now - (days - 1 - i) * 86400000, value: base + (end - base) * p + end * noise });
    }
    out[out.length - 1].value = end;
    return out;
  }, [currency, t?.costTHB, t?.costUSD, t?.marketTHB, t?.marketUSD]);

  // Both error and loading states render the same skeleton + minimal
  // header. Error additionally pops a top-right Toast — keeps the user
  // oriented (sees where data will land) and points at the gear icon
  // in the header so they know where to fix auth.
  if (error || isLoading || !snap || !t) {
    const errMsg = error ? (error as Error).message : null;
    const is401 = errMsg ? /\b401\b/.test(errMsg) : false;
    return (
      <>
        <MinimalHeader />
        <DashboardSkeleton />
        {errMsg && (
          <Toast
            tone={is401 ? 'warn' : 'error'}
            title={is401 ? 'Sign in needed' : 'API error'}
            message={
              is401
                ? 'Click the ⚙ in the top-right and paste your bearer token to load your portfolio.'
                : `${errMsg}. Check your API URL in ⚙ settings.`
            }
          />
        )}
      </>
    );
  }

  const usdthb = snap.fx.usdthb;
  const pnlCur = currency === 'THB' ? t.pnlTHB : t.pnlUSD;

  const allPositions = [...snap.positions.dime, ...snap.positions.binance, ...snap.positions.onchain];
  const sectorMap = new Map<string, number>();
  for (const p of allPositions) {
    const key = p.sector ?? 'Other';
    sectorMap.set(key, (sectorMap.get(key) ?? 0) + p.marketUSD);
  }
  if (snap.totals.bank.marketUSD > 0) sectorMap.set('Cash', snap.totals.bank.marketUSD);
  const sectorSlices = Array.from(sectorMap.entries()).map(([label, value]) => ({
    label,
    value,
    color: SECTOR_COLORS[label] ?? 'var(--muted-2)',
  }));

  const filtered: (EnrichedPosition & { key: string })[] = [];
  if (filter === 'All' || filter === 'DIME') snap.positions.dime.forEach((p) => filtered.push({ ...p, key: `DIME:${p.symbol}` }));
  if (filter === 'All' || filter === 'Binance') snap.positions.binance.forEach((p) => filtered.push({ ...p, key: `Binance:${p.symbol}` }));
  if (filter === 'All' || filter === 'OnChain') snap.positions.onchain.forEach((p) => filtered.push({ ...p, key: `OnChain:${p.symbol}` }));
  filtered.sort((a, b) => b.marketUSD - a.marketUSD);

  const pnlOf = (p: EnrichedPosition) => (currency === 'THB' ? p.pnlTHB : p.pnlUSD);
  const topMovers = [...allPositions]
    .sort((a, b) => Math.abs(pnlOf(b)) - Math.abs(pnlOf(a)))
    .slice(0, 6)
    .map((p) => ({ sym: p.symbol, pnl: pnlOf(p) }));

  return (
    <>
      <TopBar currency={currency} setCurrency={setCurrency} lastSyncMs={snap.asOf} />

      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 28px 120px' }}>
        {/* TOP ROW — Hero + True PNL breakdown */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16, marginBottom: 16 }}>
          <div className="widget" style={{ padding: '22px 26px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                Net worth · both currencies
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                USDTHB {usdthb.toFixed(2)}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <DualHeroCell
                label="Thai Baht"
                tag="THB · true"
                value={t.marketTHB}
                pnl={t.pnlTHB}
                pct={t.costTHB > 0 ? (t.pnlTHB / t.costTHB) * 100 : 0}
                primary={currency === 'THB'}
                privacy={privacy}
                cur="THB"
              />
              <DualHeroCell
                label="US Dollar"
                tag="USD · market"
                value={t.marketUSD}
                pnl={t.pnlUSD}
                pct={t.costUSD > 0 ? (t.pnlUSD / t.costUSD) * 100 : 0}
                primary={currency === 'USD'}
                privacy={privacy}
                cur="USD"
              />
            </div>
            <div style={{ marginTop: 16 }}>
              <AreaChart
                data={mockSeries}
                pickY={(d) => d.value}
                color={pnlCur >= 0 ? 'var(--up)' : 'var(--down)'}
                gradId="hero-grad"
                height={110}
                formatY={(d) => fmtMoney(d.value, currency, { dp: currency === 'THB' ? 0 : 2 })}
              />
            </div>
          </div>

          <div className="widget" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 10 }}>
              True PNL · breakdown
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Market PNL</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, color: t.pnlTHB - t.fxContribTHB >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {fmtTHB(t.pnlTHB - t.fxContribTHB, { sign: true })}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                  {fmtUSD(t.pnlUSD, { sign: true })} · asset appreciation
                </div>
              </div>
              <div style={{ height: 1, background: 'var(--border)' }} />
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>FX contribution</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, color: t.fxContribTHB >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {fmtTHB(t.fxContribTHB, { sign: true })}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                  THB now {usdthb.toFixed(2)}
                </div>
              </div>
              <div style={{ height: 1, background: 'var(--border)' }} />
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
                  Realized · banked from sells
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, color: t.realizedTHB >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {fmtTHB(t.realizedTHB, { sign: true })}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                  {fmtUSD(t.realizedUSD, { sign: true })} · {fmtTHB(t.realizedFxContribTHB, { sign: true })} from FX
                </div>
              </div>
              <div style={{ height: 1, background: 'var(--border)' }} />
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Total THB PNL</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 500, color: t.pnlTHB + t.realizedTHB >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {fmtTHB(t.pnlTHB + t.realizedTHB, { sign: true })}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                  unrealized {fmtTHB(t.pnlTHB, { sign: true })} + realized {fmtTHB(t.realizedTHB, { sign: true })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 2nd ROW — Allocation + Platforms + Top movers */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: 16, marginBottom: 16 }}>
          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="By asset class" />
            {sectorSlices.length === 0 ? (
              <Empty>Import trades to see allocation.</Empty>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Donut slices={sectorSlices} size={140} thickness={18} centerLabel="Classes" centerValue={String(sectorSlices.length)} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, fontSize: 11 }}>
                  {sectorSlices
                    .sort((a, b) => b.value - a.value)
                    .slice(0, 6)
                    .map((s) => (
                      <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: 2, background: s.color }} />
                        <span style={{ flex: 1 }}>{s.label}</span>
                        <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                          {((s.value / (snap.totals.all.marketUSD || 1)) * 100).toFixed(1)}%
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>

          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="By platform" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 4 }}>
              {[
                { key: 'dime', name: 'DIME', sub: 'US stocks', color: 'var(--accent)', tot: snap.totals.dime },
                { key: 'binance', name: 'Binance', sub: 'Crypto', color: 'var(--accent-2)', tot: snap.totals.binance },
                { key: 'onchain', name: 'On-chain', sub: 'World Chain', color: 'oklch(0.78 0.15 145)', tot: snap.totals.onchain },
                { key: 'bank', name: 'Bank', sub: 'THB cash', color: 'var(--muted-2)', tot: snap.totals.bank },
              ].filter((p) => p.tot.marketUSD > 0).map((p) => {
                const v = currency === 'THB' ? p.tot.marketTHB : p.tot.marketUSD;
                const pct = snap.totals.all.marketUSD > 0 ? (p.tot.marketUSD / snap.totals.all.marketUSD) * 100 : 0;
                const pnl = currency === 'THB' ? p.tot.pnlTHB : p.tot.pnlUSD;
                return (
                  <div key={p.key}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{p.sub}</span>
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>{pct.toFixed(1)}%</div>
                    </div>
                    <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: p.color, opacity: 0.85 }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                        {privacy ? '•••' : fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 })}
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
                        {fmtMoney(pnl, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="Top movers" sub="By absolute PNL" />
            {topMovers.length === 0 ? (
              <Empty>No positions yet.</Empty>
            ) : (
              <WinLossBar rows={topMovers} format={(n) => fmtMoney(n, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })} />
            )}
          </div>
        </div>

        {/* HOLDINGS */}
        <div className="widget" style={{ padding: 0, marginBottom: 16 }}>
          <div
            style={{
              padding: '18px 24px 14px',
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Holdings</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {snap.positions.dime.length + snap.positions.binance.length + snap.positions.onchain.length} positions across DIME, Binance{snap.positions.onchain.length > 0 ? ', On-chain' : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['standard', 'dime'] as const).map((v) => (
                  <button
                    key={v}
                    className="pill"
                    data-active={costView === v}
                    onClick={() => setCostView(v)}
                    title={
                      v === 'standard'
                        ? 'Avg cost = remaining cost basis ÷ qty (weighted average; preserved across sells).'
                        : 'Avg cost = (total BUY cash − total SELL cash) ÷ qty held. Matches the "cost per share" the DIME app shows.'
                    }
                  >
                    {v === 'standard' ? 'Standard' : 'DIME view'}
                  </button>
                ))}
              </div>
              <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
              <div style={{ display: 'flex', gap: 6 }}>
                {(['All', 'DIME', 'Binance', 'OnChain'] as const).map((f) => (
                  <button key={f} className="pill" data-active={filter === f} onClick={() => setFilter(f)}>
                    {f === 'OnChain' ? 'On-chain' : f}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filtered.length === 0 ? (
            <Empty style={{ padding: '40px 24px' }}>
              No positions yet. Import a CSV below (or configure <code>BINANCE_API_KEY</code> in <code>.env</code>).
            </Empty>
          ) : (
            <table className="holdings-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Platform</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                      Avg cost
                      <InfoDot
                        body={
                          costView === 'standard'
                            ? `Standard avg cost: take what you originally paid for the shares you still hold and divide by qty.\n\n• A SELL banks the gain or loss as "realized PNL" and removes the cost of just the sold shares — so the avg cost per remaining share doesn't change.\n• Result: this number tells you what each share you still hold cost you on the books.\n\nFormula: remaining cost basis ÷ qty held`
                            : `DIME-style avg cost: take all the cash you've put in (BUY total) minus all the cash you've taken out (SELL total), divided by qty you still hold.\n\n• A profitable SELL makes this number go DOWN (you got more cash back than the per-share cost).\n• A loss-taking SELL makes this number go UP (you got less cash back, so your "net out-of-pocket per share" is now higher).\n\nThis matches the "Cost per Share" the DIME app shows.\n\nFormula: (BUY total cash − SELL total cash) ÷ qty held`
                        }
                      />
                    </span>
                  </th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Market</th>
                  <th style={{ textAlign: 'right' }}>PNL ({currency})</th>
                  <th style={{ textAlign: 'right' }}>%</th>
                  <th style={{ textAlign: 'right' }}>FX locked</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const v = currency === 'THB' ? p.marketTHB : p.marketUSD;
                  // DIME view: fold realized PNL back into PNL and back-out avg cost
                  // from net cash invested per share. Standard view: weighted-average.
                  const isDimeView = costView === 'dime';
                  const realized = currency === 'THB' ? p.realizedTHB : p.realizedUSD;
                  const pnl = (currency === 'THB' ? p.pnlTHB : p.pnlUSD) + (isDimeView ? realized : 0);
                  const dimeCostUSD = p.qty > 0 ? p.costUSD - p.realizedUSD : 0;
                  const dimeAvgUSD = p.qty > 0 ? dimeCostUSD / p.qty : p.avgUSD;
                  const avgShown = isDimeView ? dimeAvgUSD : p.avgUSD;
                  const pnlPctShown = isDimeView
                    ? dimeCostUSD > 0
                      ? (((currency === 'THB' ? p.pnlTHB + realized : p.pnlUSD + realized)) /
                          (currency === 'THB' ? p.costTHB - p.realizedTHB : dimeCostUSD)) *
                        100
                      : 0
                    : p.pnlPct;
                  return (
                    <tr key={p.key} className="row-clickable" onClick={() => setSelected(p)}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="symbol-chip">{p.symbol}</div>
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{p.name ?? p.symbol}</div>
                        </div>
                      </td>
                      <td>
                        <span className="plat-tag" data-plat={p.platform}>
                          {p.platform}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{p.qty}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                        {fmtUSD(avgShown, { dp: avgShown < 10 ? 3 : 2 })}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
                        {fmtUSD(p.priceUSD, { dp: p.priceUSD < 10 ? 3 : 2 })}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
                        {privacy ? '•••' : fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 })}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
                        {fmtMoney(pnl, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: pnlPctShown >= 0 ? 'var(--up)' : 'var(--down)' }}>
                        {fmtPct(pnlPctShown)}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                        {p.fxLocked.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Transactions + CSV upload */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
          <div className="widget" style={{ padding: 0 }}>
            <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Recent transactions</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Aggregated across platforms</div>
            </div>
            {!trades || trades.length === 0 ? (
              <Empty style={{ padding: '28px 22px' }}>No transactions recorded yet.</Empty>
            ) : (
              trades.slice(0, 10).map((tx) => <TxRow key={tx.id} tx={tx} />)
            )}
          </div>

          <div className="widget" style={{ padding: 0 }}>
            <CsvUpload />
          </div>
        </div>
      </div>

      {selected && <PriceModal position={selected} currency={currency} usdthb={usdthb} onClose={() => setSelected(null)} />}
    </>
  );
}

function WidgetHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

function Empty({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12, ...style }}>{children}</div>
  );
}

// Tiny ⓘ marker that opens a hover-popover with longer-form copy than a
// native `title` tooltip can comfortably hold (multi-line, formatted).
function InfoDot({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '1px solid var(--muted)',
          color: 'var(--muted)',
          fontSize: 9,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'help',
          fontFamily: 'serif',
          fontStyle: 'italic',
          lineHeight: 1,
        }}
      >
        i
      </span>
      {open && (
        <span
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 6,
            zIndex: 50,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px',
            width: 320,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--text)',
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
            fontWeight: 400,
            letterSpacing: 0,
            textTransform: 'none',
          }}
        >
          {body}
        </span>
      )}
    </span>
  );
}

const TX_STYLES: Record<string, { bg: string; fg: string; icon: string }> = {
  BUY: { bg: 'color-mix(in oklab, var(--up) 18%, transparent)', fg: 'var(--up)', icon: '↑' },
  SELL: { bg: 'color-mix(in oklab, var(--down) 18%, transparent)', fg: 'var(--down)', icon: '↓' },
  DIV: { bg: 'color-mix(in oklab, var(--accent) 18%, transparent)', fg: 'var(--accent)', icon: '$' },
};

function TxRow({ tx }: { tx: TradeRow }) {
  const sty = TX_STYLES[tx.side] ?? TX_STYLES.BUY;
  const d = new Date(tx.ts).toISOString().slice(0, 10);
  return (
    <div className="tx-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            background: sty.bg,
            color: sty.fg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {sty.icon}
        </div>
        <div>
          <div style={{ fontSize: 13 }}>
            <span style={{ fontWeight: 500 }}>{tx.side}</span> <span style={{ color: 'var(--muted)' }}>· {tx.symbol}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
            {tx.platform} · {d}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
          {tx.side === 'DIV' ? fmtUSD(tx.price_usd) : `${tx.qty} × ${fmtUSD(tx.price_usd, { dp: tx.price_usd < 10 ? 3 : 2 })}`}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>FX {tx.fx_at_trade.toFixed(2)}</div>
      </div>
    </div>
  );
}

// Slim header used during loading/error — gives the user the gear
// button (and brand) without depending on portfolio data being loaded.
function MinimalHeader() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 28px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Consolidate</div>
      <SettingsPopover />
    </div>
  );
}
