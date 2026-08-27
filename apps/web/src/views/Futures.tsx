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
import { ChannelLadderCard } from '../components/ChannelLadderCard';
import type {
  FuturesPosition,
  FuturesBotLegStats,
  FuturesIncomeBucket,
  FuturesBotTrade,
  FuturesExitPlan,
  ManualSymbolStats,
} from '@consolidate/shared';
import { splitRealizedBySymbol, isBotSymbol, isOpenPosition } from '@consolidate/shared';

const RANGES = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
];

const UP = 'var(--up, #3fb950)';
const DOWN = 'var(--down, #f85149)';
const MUTED = 'var(--muted, #8b949e)';
// Data defect, not a market direction — deliberately neither UP nor DOWN.
const WARN = 'var(--warn, #d29922)';

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
              {(() => {
                const s = splitRealizedBySymbol(data.account.realizedBySymbol);
                return (
                  <Stat label={`Realized PnL (${days}d)`} value={usd(data.account.realizedPnlUsd, privacy)} color={signColor(data.account.realizedPnlUsd)}
                    sub={!privacy && s.hasManual ? `BTC bot ${usd(s.botUsd)} · manual ${usd(s.manualUsd)}` : ''} />
                );
              })()}
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

          {/* ── Manual trades (hand-traded, non-bot symbols) — the account-side
                counterpart to Bot legs: per-symbol realized/funding/fees over the
                range + live open status. Only rendered when hand trades exist. ── */}
          {data.manualTrades.length > 0 && (() => {
            const openCount = data.manualTrades.filter((m) => m.open != null).length;
            const n = data.manualTrades.length;
            return (
              <Section title="Manual trades" sub={`hand-traded · ${n} symbol${n > 1 ? 's' : ''}${openCount ? ` · ${openCount} open` : ''}`}>
                <div style={card}><ManualTable rows={data.manualTrades} days={days} privacy={privacy} /></div>
              </Section>
            );
          })()}

          <ChannelLadderCard privacy={privacy} />

      {/* ── Bot legs ── */}
          <Section
            title="Bot legs (snapback attribution)"
            sub={`last ${data.rangeDays}d over lifetime · from pushed entry/exit events`}
          >
            <div style={card}>
              {/* ?? botLegs: web and API deploy independently, so a freshly
                  shipped page can briefly hit an API that has no lifetime
                  field. Degrade to the windowed rows instead of blowing up. */}
              {(data.botLegsLifetime ?? data.botLegs).length === 0
                ? <Empty>No bot legs have reported trades yet.</Empty>
                : <LegTable
                    legs={data.botLegs}
                    lifetime={data.botLegsLifetime ?? data.botLegs}
                    days={data.rangeDays}
                    privacy={privacy}
                  />}
            </div>
          </Section>

          {/* ── Recent bot trades ──
              Windowed by EXIT time, not entry, so a row here can carry an entry
              date older than the range start. The count makes no claim beyond
              "in range": the list also holds trades still open and UNRESOLVED
              entries, so the old "N resolved" contradicted the "unresolved"
              label on the very rows beneath it. */}
          {data.botTrades.length > 0 && (
            <Section title="Recent bot trades" sub={`${data.botTrades.length} in the last ${data.rangeDays}d`}>
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

// BOT (bot-traded symbol, e.g. BTC) vs MANUAL (hand trade on the same account).
function PosTag({ isBot }: { isBot: boolean }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: 0.5, padding: '2px 6px', borderRadius: 999,
      whiteSpace: 'nowrap',
      background: isBot ? 'rgba(47,128,199,0.18)' : 'rgba(212,160,23,0.20)',
      color: isBot ? '#4aa3e8' : '#d4a017',
    }}>{isBot ? 'BOT' : 'MANUAL'}</span>
  );
}

function PositionsTable({ positions, privacy }: { positions: FuturesPosition[]; privacy: boolean }) {
  return (
    <table style={tbl}>
      <thead><tr>{['Symbol', 'Side', 'Size', 'Entry', 'Mark', 'uPnL', 'Lev', 'Margin', 'Liq.', 'SL', 'TP'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {positions.map((p) => {
          const short = p.positionAmt < 0;
          return (
            <tr key={p.symbol}>
              <td style={td}><b>{p.symbol}</b> <PosTag isBot={isBotSymbol(p.symbol)} /></td>
              <td style={{ ...td, color: short ? DOWN : UP }}>{short ? 'SHORT' : 'LONG'}</td>
              <td style={td}>{privacy ? '•••' : `${Math.abs(p.positionAmt)} (${usd(p.notionalUsd)})`}</td>
              <td style={td}>{usd(p.entryPrice)}</td>
              <td style={td}>{usd(p.markPrice)}</td>
              <td style={{ ...td, color: signColor(p.unrealizedPnlUsd) }}>{usd(p.unrealizedPnlUsd, privacy)}</td>
              <td style={td}>{p.leverage > 0 ? `${p.leverage}×` : '—'}</td>
              <td style={td}>{p.marginUsd != null ? usd(p.marginUsd, privacy) : '—'}</td>
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

// Per-symbol MANUAL activity: live open status (when held) + realized outcome
// over the range. No win-rate — manual trades leave no paired events (see
// deriveManualStats); the Realized cell's tooltip carries funding/fees/net.
function ManualTable({ rows, days, privacy }: { rows: ManualSymbolStats[]; days: number; privacy: boolean }) {
  const dash = <span style={{ color: MUTED }}>—</span>;
  return (
    <table style={tbl}>
      <thead><tr>{['Symbol', 'Status', 'Size', 'Entry', 'Mark', 'uPnL', `Realized (${days}d)`, 'SL / TP'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((m) => {
          const p = m.open;
          const short = p != null && p.positionAmt < 0;
          const netTip = `net ${usd(m.netUsd)} · funding ${usd(m.fundingNetUsd)} · fees ${usd(-m.commissionUsd)}${m.realizedEvents ? ` · ${m.realizedEvents} realized event${m.realizedEvents > 1 ? 's' : ''}` : ''}`;
          return (
            <tr key={m.symbol}>
              <td style={td}><b>{m.symbol}</b></td>
              <td style={{ ...td, color: p ? (short ? DOWN : UP) : MUTED }}>{p ? (short ? 'OPEN short' : 'OPEN long') : 'flat'}</td>
              <td style={td}>{p ? (privacy ? '•••' : `${Math.abs(p.positionAmt)} (${usd(p.notionalUsd)})`) : dash}</td>
              <td style={td}>{p ? usd(p.entryPrice) : dash}</td>
              <td style={td}>{p ? usd(p.markPrice) : dash}</td>
              <td style={{ ...td, color: p ? signColor(p.unrealizedPnlUsd) : MUTED }}>{p ? usd(p.unrealizedPnlUsd, privacy) : '—'}</td>
              <td style={{ ...td, color: signColor(m.realizedPnlUsd) }} title={privacy ? undefined : netTip}>{usd(m.realizedPnlUsd, privacy)}</td>
              <td style={td}>
                {p
                  ? <>
                      <span style={{ color: p.slPriceUsd != null ? DOWN : MUTED }}>{p.slPriceUsd != null ? usd(p.slPriceUsd) : '—'}</span>
                      <span style={{ color: MUTED }}> / </span>
                      <span style={{ color: p.tpPriceUsd != null ? UP : MUTED }}>{p.tpPriceUsd != null ? usd(p.tpPriceUsd) : '—'}</span>
                    </>
                  : dash}
              </td>
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

/** Two-line cell: windowed value on top, lifetime underneath in muted small. */
function Dual({ top, bottom, topColor }: { top: React.ReactNode; bottom: React.ReactNode; topColor?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.3 }}>
      <span style={topColor ? { color: topColor } : undefined}>{top}</span>
      <span style={{ color: MUTED, fontSize: 11 }}>{bottom}</span>
    </div>
  );
}

/** Header cell carrying the "{n}d / life" legend for the dual columns. */
function DualTh({ label, days }: { label: string; days: number }) {
  return (
    <th style={th}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.3 }}>
        <span>{label}</span>
        <span style={{ color: MUTED, fontWeight: 400, fontSize: 10 }}>{days}d / life</span>
      </div>
    </th>
  );
}

function LegTable({ legs, lifetime, days, privacy }: {
  legs: FuturesBotLegStats[];
  lifetime: FuturesBotLegStats[];
  days: number;
  privacy: boolean;
}) {
  // Rows come from LIFETIME, which is a superset: a leg with no trade resolved
  // inside the window has no windowed row at all, and iterating `legs` would
  // make it vanish from the table entirely rather than show as a quiet 0.
  const byRange = new Map(legs.map((l) => [l.source, l]));
  return (
    <table style={tbl}>
      <thead>
        <tr>
          {['Leg', 'Strategy'].map((h) => <th key={h} style={th}>{h}</th>)}
          <DualTh label="Trades" days={days} />
          <DualTh label="Win rate" days={days} />
          <DualTh label="Net PnL" days={days} />
          {['Equity', 'State', 'Open exit (SL/TP · trigger)'].map((h) => <th key={h} style={th}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {lifetime.map((life) => {
          const r = byRange.get(life.source);
          return (
            <tr key={life.source}>
              <td style={td}><b>{life.source.replace('snapback-btc', 'v1').replace('v1-', '')}</b></td>
              <td style={{ ...td, color: MUTED }}>{life.strategy ?? '—'}</td>
              <td style={td}>
                {/* r.openTrade and life.openTrade are provably identical —
                    tradesClosedWithin keeps every genuinely open trade
                    regardless of window — but read from the windowed row so
                    the annotation belongs to the number it sits on.
                    unresolvedTrades is NOT identical across the two (an
                    unresolved entry windows by entry time), so it rides the
                    lifetime line: a hole in the ledger is a lifetime fact. */}
                <Dual
                  top={<>{r?.trades ?? 0}{(r?.openTrade ?? life.openTrade) ? ' +1 open' : ''}</>}
                  bottom={<>
                    {life.trades} lifetime
                    {life.unresolvedTrades > 0 && (
                      <span
                        style={{ color: WARN }}
                        title="Entry with no exit event: the position closed but the bot never pushed the exit, so this trade's PnL is missing from every figure on this row."
                      >
                        {' '}· {life.unresolvedTrades} unresolved
                      </span>
                    )}
                  </>}
                />
              </td>
              <td style={td}>
                <Dual
                  top={<>{pct(r?.winRatePct ?? null)}{r ? <span style={{ color: MUTED }}> ({r.wins}/{r.wins + r.losses})</span> : null}</>}
                  bottom={<>{pct(life.winRatePct)} ({life.wins}/{life.wins + life.losses})</>}
                />
              </td>
              <td style={td}>
                <Dual
                  top={usd(r?.netPnlUsd ?? 0, privacy)}
                  topColor={signColor(r?.netPnlUsd ?? 0)}
                  bottom={usd(life.netPnlUsd, privacy)}
                />
              </td>
              <td style={td}>{usd(life.currentEquityUsd, privacy)}</td>
              <td style={{ ...td, color: life.isHalted ? DOWN : UP }}>{life.isHalted ? 'HALTED' : 'live'}</td>
              <td style={td}>{privacy ? '•••' : <ExitPlanCell plan={life.openExit} />}</td>
            </tr>
          );
        })}
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
            <td style={td}>
              {/* isOpenPosition, not a hand-written exitTs check — same
                  predicate the API uses, so the two can't drift. */}
              {t.exitTs != null
                ? fmtTs(t.exitTs)
                : isOpenPosition(t)
                  ? <span style={{ color: MUTED }}>open</span>
                  : <span style={{ color: WARN }} title="The bot never pushed an exit for this entry; a later entry proves the position closed. Its PnL is unknown and excluded from the leg's stats.">unresolved</span>}
            </td>
            <td style={{ ...td, color: signColor(t.pnlUsd) }}>{t.pnlUsd == null ? '—' : usd(t.pnlUsd, privacy)}</td>
            <td style={{ ...td, color: MUTED }}>{t.exitReason ?? (t.unresolved ? 'exit not reported' : '—')}</td>
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
