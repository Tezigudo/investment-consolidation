import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { usePortfolio, useTrades } from '../hooks/usePortfolio';
import { fmtMoney, fmtPct, fmtTHB, fmtUSD } from '../lib/format';
import { TopBar } from '../components/TopBar';
import { DashboardSkeleton } from '../components/DashboardSkeleton';
import { Toast } from '../components/Toast';
import { DualHeroCell } from '../components/DualHeroCell';
import { Donut, WinLossBar } from '../components/charts';
import { PriceModal } from '../components/PriceModal';
import { CsvUpload } from '../components/CsvUpload';
import { FxScenario } from '../components/FxScenario';
import { DepositsLedger } from '../components/DepositsLedger';
import { IncomeCenter } from '../components/IncomeCenter';
import { HeroHistoryChart, DeltaStrip, usePortfolioHistory } from '../components/HeroHistoryChart';
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
  const { data: history } = usePortfolioHistory();
  const [selected, setSelected] = useState<EnrichedPosition | null>(null);
  const [filter, setFilter] = useState<'All' | 'DIME' | 'Binance' | 'OnChain'>('All');
  const [costView, setCostView] = useState<'standard' | 'dime'>('standard');

  const t = snap?.totals.all;

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
                ? 'Click the ⚙ in the bottom-right and paste your bearer token to load your portfolio.'
                : `${errMsg}. Check your API URL in the ⚙ settings (bottom-right).`
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

  const idleBinanceUSD = snap.positions.binance
    .filter((p) => p.sector === 'Cash')
    .reduce((acc, p) => acc + p.marketUSD, 0);

  return (
    <>
      <TopBar currency={currency} setCurrency={setCurrency} lastSyncMs={snap.asOf} />

      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 28px 120px' }}>
        {/* TOP ROW — Hero + True PNL breakdown */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16, marginBottom: 16 }}>
          <div className="widget" style={{ padding: '22px 26px', display: 'flex', flexDirection: 'column' }}>
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
            <div style={{ marginTop: 16, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <HeroHistoryChart
                currency={currency}
                fallbackToday={{ marketTHB: t.marketTHB, marketUSD: t.marketUSD, ts: snap.asOf }}
                pnlSign={pnlCur}
                history={history}
              />
            </div>
          </div>

          <div className="widget" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                True PNL · breakdown
              </div>
              <PnlMethodologyTip />
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
                <TwrLine twr={history?.twr} />
              </div>
              <FxScenario currentFX={usdthb} totals={t} bankUSD={snap.totals.bank.marketUSD} currency={currency} />
            </div>
          </div>
        </div>

        {/* DELTA STRIP — Today / week / month / YTD net-worth changes */}
        <DeltaStrip currency={currency} history={history} />

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
                    {p.key === 'binance' && idleBinanceUSD > 50 && !privacy && (
                      <IdleCashChip usd={idleBinanceUSD} usdthb={usdthb} />
                    )}
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

        {/* RISK — Concentration + Drawdown */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <ConcentrationPanel positions={allPositions} totalUSD={snap.totals.all.marketUSD} currency={currency} privacy={privacy} />
          <DrawdownPanel history={history} currency={currency} privacy={privacy} />
        </div>

        {/* DEPOSITS + INCOME — the "money in / money out" pair */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginBottom: 16 }}>
          <DepositsLedger />
          <IncomeCenter />
        </div>

        {/* TRADING ATTRIBUTION — humility check on past sells */}
        <TradingAttribution privacy={privacy} />

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
                            : `DIME-style avg cost: FIFO. A SELL eats the oldest open lots first; the surviving lots' cost is what you see here.\n\n• If your old buys were cheap and you sold most of them, the avg moves UP toward the cost of the newer (held) lots.\n• If your recent buys are cheap and you only sold older expensive ones, the avg moves DOWN.\n\nThis matches the "Cost per Share" the DIME app shows.\n\nFormula: Σ (remaining_lot_qty × lot_cost_per_share) ÷ qty held`
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
                  // DIME view: FIFO cost basis (matches the DIME app exactly).
                  // Standard view: weighted-average cost-basis preservation.
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

      {selected && <PriceModal position={selected} currency={currency} usdthb={usdthb} costView={costView} onClose={() => setSelected(null)} />}
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

function MinimalHeader() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '14px 28px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Consolidate</div>
    </div>
  );
}

// Trade attribution: "what if I'd never sold?". Compares actual return
// (current market + realized) against a buy-and-hold counterfactual.
// Net impact reduces to sum(sellQty × (sellPrice − currentPrice)).
//
// Displayed in USD only — converting to THB at today's spot would
// violate the true-baht-PNL contract (cost basis is FX-locked, this
// counterfactual is not). If a THB version is wanted, fx_at_trade
// would need to flow through the per-sell math.
function TradingAttribution({ privacy }: { privacy: boolean }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['attribution'],
    queryFn: () => api.attribution(),
    staleTime: 5 * 60_000,
  });
  if (isLoading || !data) {
    if (error) return null;
    return null;
  }
  if (data.bySymbol.length === 0) return null;

  const totalUSD = data.totalImpactUSD;
  const tone = totalUSD >= 0 ? 'var(--up)' : 'var(--down)';

  const top = data.bySymbol.slice(0, 6);
  return (
    <div className="widget" style={{ padding: '18px 22px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            Trading attribution
            <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 8, fontWeight: 400 }}>USD only</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            Actual return − "if you'd held everything" baseline. Negative = sells gave up upside.
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 500, color: tone }}>
            {privacy ? '•••' : fmtUSD(totalUSD, { sign: true, dp: 2 })}
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>net trading impact</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
        {top.map((r) => {
          const rowTone = r.tradingImpactUSD >= 0 ? 'var(--up)' : 'var(--down)';
          return (
            <div
              key={`${r.platform}:${r.symbol}`}
              style={{ background: 'var(--surface-2)', borderRadius: 6, padding: '10px 12px' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{r.symbol}</span>
                <span style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {r.platform}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: rowTone, marginTop: 4 }}>
                {privacy ? '•••' : fmtUSD(r.tradingImpactUSD, { sign: true, dp: 2 })}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                sold {r.sellQty.toFixed(r.sellQty < 1 ? 4 : 2)} @ avg ≈ ${(r.avgSellUSD).toFixed(2)} · now ${r.currentPriceUSD.toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Time-weighted return — strips deposit-timing from the % so it's
// directly comparable to a benchmark. Showing YTD / 1Y / All in one
// line keeps the True PNL block dense but readable.
function TwrLine({ twr }: { twr?: { ytd: number | null; oneYear: number | null; all: number | null } }) {
  const [open, setOpen] = useState(false);
  if (!twr) return null;
  const fmt = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
  const tone = (v: number | null) => (v == null ? 'var(--muted)' : v >= 0 ? 'var(--up)' : 'var(--down)');
  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11, alignItems: 'center', position: 'relative' }}>
      <span style={{ color: 'var(--muted)' }}>TWR</span>
      <span><span style={{ color: 'var(--muted)' }}>YTD</span> <span style={{ color: tone(twr.ytd) }}>{fmt(twr.ytd)}</span></span>
      <span><span style={{ color: 'var(--muted)' }}>1Y</span> <span style={{ color: tone(twr.oneYear) }}>{fmt(twr.oneYear)}</span></span>
      <span><span style={{ color: 'var(--muted)' }}>All</span> <span style={{ color: tone(twr.all) }}>{fmt(twr.all)}</span></span>
      <span
        style={{ color: 'var(--muted)', cursor: 'help' }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        ⓘ
      </span>
      {open && (
        <span
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
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
            textAlign: 'left',
            whiteSpace: 'normal',
            fontFamily: 'inherit',
          }}
        >
          Time-weighted return chains daily portfolio returns and removes the
          timing of new BUYs and SELLs. Lets you compare directly to "SPY
          returned X% YTD" without deposit-timing skewing the answer.
          <br />
          <br />
          Computed against the daily snapshot series in THB. Accuracy degrades
          during windows with heavy selling because cash from sells isn't
          held in the snapshot — best for buy-and-mostly-hold periods.
        </span>
      )}
    </div>
  );
}

// HHI (Herfindahl-Hirschman Index): sum of squared %-weights × 10000.
// 0 = perfectly diversified, 10000 = one holding. >2500 is the conventional
// threshold for "concentrated"; <1500 is "diversified".
function ConcentrationPanel({
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
  if (totalUSD <= 0 || positions.length === 0) {
    return (
      <div className="widget" style={{ padding: '18px 20px' }}>
        <WidgetHeader title="Concentration" />
        <Empty>No positions yet.</Empty>
      </div>
    );
  }
  const sorted = [...positions].sort((a, b) => b.marketUSD - a.marketUSD);
  const weights = sorted.map((p) => p.marketUSD / totalUSD);
  const hhi = weights.reduce((acc, w) => acc + w * w, 0) * 10000;
  const top1 = weights[0] * 100;
  const top3 = weights.slice(0, 3).reduce((a, w) => a + w, 0) * 100;
  const top5 = weights.slice(0, 5).reduce((a, w) => a + w, 0) * 100;
  const verdict =
    hhi > 2500 ? { label: 'Concentrated', color: 'var(--down)' }
    : hhi > 1500 ? { label: 'Moderate', color: 'oklch(0.75 0.13 80)' }
    : { label: 'Diversified', color: 'var(--up)' };

  return (
    <div className="widget" style={{ padding: '18px 20px' }}>
      <WidgetHeader title="Concentration" sub={`HHI ${hhi.toFixed(0)} · ${verdict.label}`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
        <ConcentrationStat label="Top 1" pct={top1} />
        <ConcentrationStat label="Top 3" pct={top3} />
        <ConcentrationStat label="Top 5" pct={top5} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          {sorted.slice(0, 3).map((p) => {
            const w = (p.marketUSD / totalUSD) * 100;
            const v = currency === 'THB' ? p.marketTHB : p.marketUSD;
            return (
              <div key={`${p.platform}:${p.symbol}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: 'var(--muted)' }}>
                  {p.symbol}
                </span>
                <span style={{ fontFamily: 'var(--mono)' }}>
                  {w.toFixed(1)}%
                  <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                    {privacy ? '•••' : fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 })}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 10, color: verdict.color, marginTop: 10, lineHeight: 1.5 }}>
        {verdict.label}: HHI {hhi.toFixed(0)} (under 1500 = diversified, over 2500 = concentrated).
      </div>
    </div>
  );
}

function ConcentrationStat({ label, pct }: { label: string; pct: number }) {
  const tone = pct >= 60 ? 'var(--down)' : pct >= 40 ? 'oklch(0.75 0.13 80)' : 'var(--up)';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: 'var(--muted)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', color: tone }}>{pct.toFixed(1)}%</span>
      </div>
      <div style={{ height: 5, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: tone, opacity: 0.85 }} />
      </div>
    </div>
  );
}

// Drawdown from running peak. We use marketTHB so THB-locals see THB-real
// drawdowns (FX moves count). Switch series when currency toggles.
function DrawdownPanel({
  history,
  currency,
  privacy,
}: {
  history: ReturnType<typeof usePortfolioHistory>['data'];
  currency: Currency;
  privacy: boolean;
}) {
  const series = history?.series ?? [];
  if (series.length < 2) {
    return (
      <div className="widget" style={{ padding: '18px 20px' }}>
        <WidgetHeader title="Drawdown" />
        <Empty>Not enough history yet — drawdown needs at least 2 daily snapshots.</Empty>
      </div>
    );
  }

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
    // Rank by percentage so a 50% dip from a small peak isn't shadowed
    // by a 10% dip from a larger peak (industry-convention max DD).
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
    <div className="widget" style={{ padding: '18px 20px' }}>
      <WidgetHeader title="Drawdown" sub={`Peak ${privacy ? '•••' : fmtMoney(peak, currency, { dp: currency === 'THB' ? 0 : 2 })} on ${peakAt}`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        <DrawdownStat
          label="Current"
          amount={currentDD}
          pct={currentDDPct}
          currency={currency}
          privacy={privacy}
        />
        <DrawdownStat
          label="Max (period)"
          amount={maxDD}
          pct={maxDDPct}
          currency={currency}
          privacy={privacy}
          subtitle={`${maxDDFromPeak} → ${maxDDAt}`}
        />
      </div>
    </div>
  );
}

function DrawdownStat({
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
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 16, color: tone }}>
          −{pct.toFixed(2)}%
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 2 }}>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>{subtitle ?? ''}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
          −{privacy ? '•••' : fmtMoney(amount, currency, { dp: currency === 'THB' ? 0 : 2 })}
        </span>
      </div>
    </div>
  );
}

// USDT sitting in Spot wallet earns 0% — Binance Earn currently offers
// ~5% APY on flexible USDT. Surfacing this catches forgotten balances
// before they accumulate. Threshold $50 keeps dust out.
function IdleCashChip({ usd, usdthb }: { usd: number; usdthb: number }) {
  const APY = 0.05;
  const yearlyTHB = usd * APY * usdthb;
  return (
    <div
      style={{
        marginTop: 8,
        fontSize: 10.5,
        color: 'var(--muted)',
        background: 'var(--surface-2)',
        borderRadius: 6,
        padding: '6px 8px',
        lineHeight: 1.45,
      }}
    >
      <span style={{ color: 'var(--text)' }}>
        ${usd.toFixed(2)} idle in Spot
      </span>
      {' '}— ~฿{Math.round(yearlyTHB).toLocaleString()}/yr at 5% Earn APY.
    </div>
  );
}

function PnlMethodologyTip() {
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
      <span style={{ fontSize: 11, color: 'var(--muted)', cursor: 'help' }}>ⓘ</span>
      {open && (
        <span
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 14px',
            width: 360,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            fontSize: 11,
            lineHeight: 1.6,
            color: 'var(--text)',
            textAlign: 'left',
            whiteSpace: 'normal',
          }}
        >
          Every trade carries the USDTHB rate at the moment it filled. Each
          row breaks the THB return into:
          <br />
          <br />
          <b>Market PNL</b> — what your assets did in their <i>own</i>{' '}
          currency, converted at the FX locked when you bought. Pure
          asset-appreciation slice; FX is held flat.
          <br />
          <b>FX contribution</b> — what changed because the baht moved against
          your USD-denominated cost basis. Positive means USDTHB went up since
          you bought.
          <br />
          <b>Realized</b> — banked from sells. Same Market vs FX split, just
          locked in instead of marked to market.
          <br />
          <b>Total THB PNL</b> = unrealized + realized. The actual baht you've
          made or lost end-to-end.
          <br />
          <br />
          The slider below previews any USDTHB level so you can see how
          sensitive your THB net worth is to the baht.
        </span>
      )}
    </span>
  );
}
