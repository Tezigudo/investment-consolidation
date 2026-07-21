// Binance Futures analytics — desktop page.
//
// Two data sources, shown side-by-side and never assumed equal (see
// packages/shared FuturesAnalytics doc): the "Account" cards/charts are the
// Binance ground truth for whatever account the API key belongs to; the "Bot
// legs" table is per-leg attribution from the snapback bot's pushed events.
// The account side degrades gracefully (banner) when no futures key is set or
// the key lacks futures permission — the bot side always renders.
//
// Money is USDT-native (futures is USDT-margined). A THB-at-current-rate
// secondary is shown on the headline balance only; we deliberately do NOT
// attempt the app's FX-locked true-baht decomposition here — futures legs
// carry no per-trade fx_at_trade, so locking would be fabricated. USDT is the
// honest unit for this surface.

import { useState } from 'react';
import { useFuturesAnalytics, usePortfolio } from '../hooks/usePortfolio';
import { AreaChart } from '../components/charts';
import type {
  FuturesPosition,
  FuturesBotLegStats,
  FuturesIncomeBucket,
  FuturesBotTrade,
  FuturesExitPlan,
} from '@consolidate/shared';

const RANGES = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
];

const UP = 'var(--up, #3fb950)';
const DOWN = 'var(--down, #f85149)';
const MUTED = 'var(--muted, #8b949e)';

function usd(v: number | null | undefined, privacy = false): string {
  if (privacy) return '•••';
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(1)}%`;
}
function signColor(v: number | null | undefined): string {
  if (v == null || v === 0) return 'var(--text)';
  return v > 0 ? UP : DOWN;
}
function legLabel(src: string): string {
  return src.replace('snapback-btc-', '').replace('snapback-btc', 'v1');
}
function groupBySource<T extends { source: string; ts: number }>(rows: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[r.source] ??= []).push(r);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.ts - b.ts);
  return out;
}
function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'Asia/Bangkok', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
// "~6d left · 36/48 bars" from the time-stop ceiling. Null when the strategy
// has no known hold window (unknown leg) — the ceiling isn't an ETA, just the
// outer force-close bound.
function fmtBarsLeft(plan: FuturesExitPlan): string | null {
  if (plan.barsLeft == null || plan.barMs == null || plan.maxHoldBars == null) return null;
  const dLeft = (plan.barsLeft * plan.barMs) / 86_400_000;
  const d = dLeft >= 2 ? dLeft.toFixed(0) : dLeft.toFixed(1);
  return `~${d}d left · ${plan.barsLeft}/${plan.maxHoldBars} bars`;
}

interface Props {
  privacy: boolean;
}

export function Futures({ privacy }: Props) {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useFuturesAnalytics(days);
  const { data: pf } = usePortfolio();
  const usdthb = pf?.fx?.usdthb ?? null;

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '24px 20px 80px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 24, margin: 0 }}>Futures analytics</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>
            Binance USDT-M · account ground-truth + snapback bot attribution
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              style={seg(days === r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <Skeleton />}
      {error && <Banner kind="error">Couldn’t load futures analytics: {(error as Error).message}</Banner>}

      {data && (
        <>
          {!data.account.available && (
            <Banner kind="info">
              {data.futuresConfigured
                ? 'Futures account data not available yet — either the cron hasn’t run, or the API key lacks “Enable Futures” read permission (the account this key belongs to may differ from the bot’s). The bot-attribution section below still works.'
                : 'No futures API key configured. Set BINANCE_FUTURES_API_KEY/SECRET (a read-only, futures-enabled key) to see account balances, realized PnL, funding and positions. The bot-attribution section below works regardless.'}
            </Banner>
          )}

          {/* ── Account summary ── */}
          <Section title="Account (Binance ground truth)" sub={data.account.asOf ? `as of ${fmtTs(data.account.asOf)}` : 'no snapshot yet'}>
            <div style={cardGrid}>
              <Stat label="Wallet balance" value={usd(data.account.walletBalanceUsd, privacy)}
                sub={usdthb && data.account.walletBalanceUsd != null && !privacy ? `≈ ฿${(data.account.walletBalanceUsd * usdthb).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''} />
              <Stat label="Margin balance" value={usd(data.account.marginBalanceUsd, privacy)} sub="wallet + uPnL" />
              <Stat label="Unrealized PnL" value={usd(data.account.unrealizedPnlUsd, privacy)} color={signColor(data.account.unrealizedPnlUsd)} />
              <Stat label={`Realized PnL (${days}d)`} value={usd(data.account.realizedPnlUsd, privacy)} color={signColor(data.account.realizedPnlUsd)} />
              <Stat label={`Funding net (${days}d)`} value={usd(data.account.fundingNetUsd, privacy)} color={signColor(data.account.fundingNetUsd)}
                sub={privacy ? '' : `paid ${usd(-data.account.fundingPaidUsd)} · recv ${usd(data.account.fundingReceivedUsd)}`} />
              <Stat label={`Commission (${days}d)`} value={usd(-data.account.commissionUsd, privacy)} color={data.account.commissionUsd > 0 ? DOWN : 'var(--text)'} />
              <Stat label={`Net income (${days}d)`} value={usd(data.account.netIncomeUsd, privacy)} color={signColor(data.account.netIncomeUsd)}
                sub="realized + funding − fees" />
            </div>
          </Section>

          {/* ── Reconciliation: Binance account vs bot-reported equity ── */}
          {data.reconciliation && (
            <Section title="Reconciliation" sub="Binance account value vs bot-reported equity">
              <div style={card}>
                <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <div style={{ fontSize: 12, color: MUTED }}>Futures account (margin)</div>
                    <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' }}>{usd(data.reconciliation.futuresWalletUsd, privacy)}</div>
                  </div>
                  <div style={{ fontSize: 18, color: MUTED, paddingBottom: 4 }}>vs</div>
                  <div>
                    <div style={{ fontSize: 12, color: MUTED }}>Bot-reported equity (Σ legs)</div>
                    <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' }}>{usd(data.reconciliation.botEquityTotalUsd, privacy)}</div>
                  </div>
                  {data.reconciliation.deltaUsd != null && (
                    <div>
                      <div style={{ fontSize: 12, color: MUTED }}>Δ</div>
                      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)', color: signColor(-Math.abs(data.reconciliation.deltaUsd)) }}>{usd(data.reconciliation.deltaUsd, privacy)}</div>
                    </div>
                  )}
                  {data.reconciliation.likelySameAccount != null && (
                    <div style={{
                      marginLeft: 'auto', alignSelf: 'center', fontSize: 12, fontWeight: 600,
                      padding: '4px 10px', borderRadius: 999,
                      border: `1px solid ${data.reconciliation.likelySameAccount ? UP : '#d4a017'}`,
                      color: data.reconciliation.likelySameAccount ? UP : '#d4a017',
                    }}>
                      {data.reconciliation.likelySameAccount ? 'same account (likely)' : 'different account (likely)'}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 10, maxWidth: 760 }}>{data.reconciliation.note}</div>
              </div>
            </Section>
          )}

          {/* ── Equity curve ── */}
          {data.equityCurve.length > 1 && (
            <Section title="Account equity" sub="margin balance, hourly snapshots">
              <div style={{ ...card, height: 240 }}>
                <AreaChart
                  data={data.equityCurve}
                  pickY={(d) => d.marginBalanceUsd}
                  color="#2563eb"
                  gradId="futEquity"
                  height={208}
                  formatY={(d) => `${usd(d.marginBalanceUsd)} · ${fmtTs(d.ts)}`}
                />
              </div>
            </Section>
          )}

          {/* ── Bot equity (the real live curve — v1 pushes hourly even with
                 no futures key, so this is what renders on day one) ── */}
          {(() => {
            // Only groups with ≥2 points are chartable; render the Section only
            // if at least one is, so we never show an empty "Bot equity" header.
            const groups = Object.entries(groupBySource(data.botEquityCurve)).filter(([, pts]) => pts.length > 1);
            if (groups.length === 0) return null;
            return (
              <Section title="Bot equity" sub="hourly heartbeat snapshots, per live leg">
                {groups.map(([src, pts]) => (
                  <div key={src} style={{ ...card, height: 210, marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{legLabel(src)}</div>
                    <AreaChart
                      data={pts}
                      pickY={(d) => d.equityUsd}
                      color={UP}
                      gradId={`botEq-${src}`}
                      height={158}
                      formatY={(d) => `${usd(d.equityUsd)} · ${fmtTs(d.ts)}`}
                    />
                  </div>
                ))}
              </Section>
            );
          })()}

          {/* ── Daily PnL ── */}
          {data.incomeByDay.length > 0 && (
            <Section title="Daily net (realized + funding − fees)">
              <div style={card}><PnLBars buckets={data.incomeByDay} privacy={privacy} /></div>
            </Section>
          )}

          {/* ── Open positions ── */}
          <Section title="Open positions" sub={`${data.positions.length} open`}>
            <div style={card}>
              {data.positions.length === 0
                ? <Empty>No open futures positions.</Empty>
                : <PositionsTable positions={data.positions} privacy={privacy} />}
            </div>
          </Section>

          {/* ── Bot legs ── */}
          <Section title="Bot legs (snapback attribution)" sub="per-leg, from pushed entry/exit events">
            <div style={card}>
              {data.botLegs.length === 0
                ? <Empty>No bot legs have reported trades yet.</Empty>
                : <LegTable legs={data.botLegs} privacy={privacy} />}
            </div>
          </Section>

          {/* ── Recent bot trades ── */}
          {data.botTrades.length > 0 && (
            <Section title="Recent bot trades" sub={`${data.botTrades.length} in range`}>
              <div style={card}><TradeTable trades={data.botTrades.slice(-25).reverse()} privacy={privacy} /></div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

// ── Daily PnL bars (hand-rolled SVG, matches the no-chart-lib convention) ──
function PnLBars({ buckets, privacy }: { buckets: FuturesIncomeBucket[]; privacy: boolean }) {
  const W = 1100, H = 160, pad = 20;
  const innerW = W - pad * 2, innerH = H - pad * 2;
  const vals = buckets.map((b) => b.netUsd);
  const max = Math.max(1, ...vals.map((v) => Math.abs(v)));
  const bw = innerW / Math.max(1, buckets.length);
  const zeroY = pad + innerH / 2;
  const total = vals.reduce((s, v) => s + v, 0);
  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
        Range total: <b style={{ color: signColor(total) }}>{usd(total, privacy)}</b>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <line x1={pad} x2={W - pad} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeWidth={1} />
        {buckets.map((b, i) => {
          const hgt = (Math.abs(b.netUsd) / max) * (innerH / 2);
          const x = pad + i * bw + bw * 0.15;
          const w = bw * 0.7;
          const up = b.netUsd >= 0;
          return (
            <rect key={b.day} x={x} y={up ? zeroY - hgt : zeroY} width={w} height={Math.max(0.5, hgt)}
              fill={up ? UP : DOWN} opacity={0.85}>
              <title>{`${b.day}: ${usd(b.netUsd)} (realized ${usd(b.realizedPnlUsd)}, funding ${usd(b.fundingUsd)}, fees ${usd(b.commissionUsd)})`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

function PositionsTable({ positions, privacy }: { positions: FuturesPosition[]; privacy: boolean }) {
  return (
    <table style={tbl}>
      <thead><tr>{['Symbol', 'Side', 'Size', 'Entry', 'Mark', 'uPnL', 'Lev', 'Liq.', 'SL', 'TP'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {positions.map((p) => {
          const short = p.positionAmt < 0;
          return (
            <tr key={p.symbol}>
              <td style={td}><b>{p.symbol}</b></td>
              <td style={{ ...td, color: short ? DOWN : UP }}>{short ? 'SHORT' : 'LONG'}</td>
              <td style={td}>{privacy ? '•••' : `${Math.abs(p.positionAmt)} (${usd(p.notionalUsd)})`}</td>
              <td style={td}>{usd(p.entryPrice)}</td>
              <td style={td}>{usd(p.markPrice)}</td>
              <td style={{ ...td, color: signColor(p.unrealizedPnlUsd) }}>{usd(p.unrealizedPnlUsd, privacy)}</td>
              <td style={td}>{p.leverage}×</td>
              <td style={td}>{p.liquidationPrice ? usd(p.liquidationPrice) : '—'}</td>
              <td style={{ ...td, color: p.slPriceUsd != null ? DOWN : MUTED }}>{p.slPriceUsd != null ? usd(p.slPriceUsd) : '—'}</td>
              <td style={{ ...td, color: p.tpPriceUsd != null ? UP : MUTED }}>{p.tpPriceUsd != null ? usd(p.tpPriceUsd) : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Compact stacked cell for a leg's open-trade exit plan: SL/TP line, the exit
// condition, and the time-stop ceiling. Renders "—" when the leg is flat.
function ExitPlanCell({ plan }: { plan: FuturesExitPlan | null }) {
  if (!plan) return <span style={{ color: MUTED }}>—</span>;
  const bars = fmtBarsLeft(plan);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.35 }}>
      <div>
        <span style={{ color: plan.slPriceUsd != null ? DOWN : MUTED }}>SL {plan.slPriceUsd != null ? usd(plan.slPriceUsd) : '—'}</span>
        <span style={{ color: MUTED }}> · </span>
        <span style={{ color: plan.tpPriceUsd != null ? UP : MUTED }}>TP {plan.tpPriceUsd != null ? usd(plan.tpPriceUsd) : '—'}</span>
      </div>
      {plan.exitCondition && <div style={{ color: MUTED, fontSize: 11 }}>{plan.exitCondition}</div>}
      {bars && <div style={{ color: MUTED, fontSize: 11 }}>{bars}</div>}
    </div>
  );
}

function LegTable({ legs, privacy }: { legs: FuturesBotLegStats[]; privacy: boolean }) {
  return (
    <table style={tbl}>
      <thead><tr>{['Leg', 'Strategy', 'Trades', 'Win rate', 'Net PnL', 'Equity', 'State', 'Open exit (SL/TP · trigger)'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {legs.map((l) => (
          <tr key={l.source}>
            <td style={td}><b>{l.source.replace('snapback-btc', 'v1').replace('v1-', '')}</b></td>
            <td style={{ ...td, color: MUTED }}>{l.strategy ?? '—'}</td>
            <td style={td}>{l.trades}{l.openTrade ? ' +1 open' : ''}</td>
            <td style={td}>{pct(l.winRatePct)} <span style={{ color: MUTED }}>({l.wins}/{l.wins + l.losses})</span></td>
            <td style={{ ...td, color: signColor(l.netPnlUsd) }}>{usd(l.netPnlUsd, privacy)}</td>
            <td style={td}>{usd(l.currentEquityUsd, privacy)}</td>
            <td style={{ ...td, color: l.isHalted ? DOWN : UP }}>{l.isHalted ? 'HALTED' : 'live'}</td>
            <td style={td}>{privacy ? '•••' : <ExitPlanCell plan={l.openExit} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TradeTable({ trades, privacy }: { trades: FuturesBotTrade[]; privacy: boolean }) {
  return (
    <table style={tbl}>
      <thead><tr>{['Leg', 'Side', 'Entry', 'Exit', 'PnL', 'Reason'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {trades.map((t, i) => (
          <tr key={`${t.source}-${t.entryTs}-${i}`}>
            <td style={{ ...td, color: MUTED }}>{t.source.replace('snapback-btc-', '').replace('snapback-btc', 'v1')}</td>
            <td style={{ ...td, color: t.side === 'short' ? DOWN : UP }}>{t.side ?? '—'}</td>
            <td style={td}>{fmtTs(t.entryTs)}</td>
            <td style={td}>{t.exitTs ? fmtTs(t.exitTs) : <span style={{ color: MUTED }}>open</span>}</td>
            <td style={{ ...td, color: signColor(t.pnlUsd) }}>{t.pnlUsd == null ? '—' : usd(t.pnlUsd, privacy)}</td>
            <td style={{ ...td, color: MUTED }}>{t.exitReason ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── primitives ──
function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 26 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{title}</h2>
        {sub && <span style={{ color: MUTED, fontSize: 12 }}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}
function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ ...card, padding: '12px 14px' }}>
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, color: color ?? 'var(--text)', fontFamily: 'var(--mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function Banner({ kind, children }: { kind: 'info' | 'error'; children: React.ReactNode }) {
  const c = kind === 'error' ? DOWN : '#d4a017';
  return (
    <div style={{ border: `1px solid ${c}`, background: 'color-mix(in srgb, var(--surface-2) 80%, transparent)', color: 'var(--text)', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 12 }}>
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: MUTED, fontSize: 13, padding: '8px 2px' }}>{children}</div>;
}
function Skeleton() {
  return <div style={{ ...card, height: 120, opacity: 0.5 }} />;
}

// ── styles ──
const card: React.CSSProperties = { background: 'var(--surface, var(--surface-2))', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };
const cardGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 };
const tbl: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border)', color: MUTED, fontWeight: 600, fontSize: 12 };
const td: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid color-mix(in srgb, var(--border) 50%, transparent)', fontVariantNumeric: 'tabular-nums' };
function seg(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
    border: '1px solid var(--border)',
    background: active ? 'var(--accent, #2563eb)' : 'transparent',
    color: active ? '#fff' : 'var(--text)',
  };
}
