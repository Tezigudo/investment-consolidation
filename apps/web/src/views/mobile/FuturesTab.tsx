// Mobile Futures tab — compact version of the desktop Futures view.
// Same data source (useFuturesAnalytics); USDT-native. Hand-rolled, no chart
// lib. Degrades to the bot-attribution section when no futures key is set.

import { useState } from 'react';
import { useFuturesAnalytics } from '../../hooks/usePortfolio';
import { AreaChart } from '../../components/charts';
import { ChannelLadderCard } from '../../components/ChannelLadderCard';
import { M } from './styles';
import type { FuturesExitPlan, ManualSymbolStats } from '@consolidate/shared';
import { splitRealizedBySymbol, isBotSymbol } from '@consolidate/shared';

const UP = 'var(--up, #3fb950)';
const DOWN = 'var(--down, #f85149)';
const MUTED = 'var(--muted)';

function barsLeftStr(plan: FuturesExitPlan): string | null {
  if (plan.barsLeft == null || plan.barMs == null || plan.maxHoldBars == null) return null;
  const dLeft = (plan.barsLeft * plan.barMs) / 86_400_000;
  const d = dLeft >= 2 ? dLeft.toFixed(0) : dLeft.toFixed(1);
  return `~${d}d left · ${plan.barsLeft}/${plan.maxHoldBars} bars`;
}

function usd(v: number | null | undefined, privacy = false): string {
  if (privacy) return '•••';
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function sc(v: number | null | undefined): string {
  if (v == null || v === 0) return 'var(--text)';
  return v > 0 ? UP : DOWN;
}

function legLabel(src: string): string {
  return src.replace('snapback-btc-', '').replace('snapback-btc', 'v1');
}
// The busiest leg's equity series, sorted by ts — mobile shows one chart.
function topSeries(rows: Array<{ source: string; ts: number; equityUsd: number }>) {
  const bySrc: Record<string, typeof rows> = {};
  for (const r of rows) (bySrc[r.source] ??= []).push(r);
  const best = Object.values(bySrc).sort((a, b) => b.length - a.length)[0] ?? [];
  return [...best].sort((a, b) => a.ts - b.ts);
}

const RANGES = [7, 30, 90, 365];

export function FuturesTab({ privacy }: { privacy: boolean }) {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useFuturesAnalytics(days);

  return (
    <div style={M.scroll}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={M.title}>Futures</div>
        <div style={M.segGroup as React.CSSProperties}>
          {RANGES.map((d) => (
            <button key={d} onClick={() => setDays(d)}
              style={{ ...M.segBtn, ...(days === d ? M.segBtnActive : {}) } as React.CSSProperties}>
              {d === 365 ? '1Y' : `${d}D`}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <div style={{ ...M.card, height: 120, opacity: 0.5 }} />}
      {error && <div style={M.empty as React.CSSProperties}>Couldn’t load: {(error as Error).message}</div>}

      {data && (
        <>
          {!data.account.available && (
            <div style={{ ...M.card, marginBottom: 12, fontSize: 12, color: 'var(--muted)', borderColor: '#d4a017' }}>
              {data.futuresConfigured
                ? 'Account data not available yet (cron pending, or key lacks futures permission). Bot section below still works.'
                : 'No futures key set. Add a read-only futures key to see balances, PnL & positions. Bot section below works regardless.'}
            </div>
          )}

          {/* headline balances */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 }}>
            <Stat label="Wallet" value={usd(data.account.walletBalanceUsd, privacy)} />
            <Stat label="uPnL" value={usd(data.account.unrealizedPnlUsd, privacy)} color={sc(data.account.unrealizedPnlUsd)} />
            <Stat label={`Realized ${days}d`} value={usd(data.account.realizedPnlUsd, privacy)} color={sc(data.account.realizedPnlUsd)} />
            <Stat label={`Funding ${days}d`} value={usd(data.account.fundingNetUsd, privacy)} color={sc(data.account.fundingNetUsd)} />
          </div>

          {/* realized split — bot (BTC) vs manual alt trades, so a red Realized
              isn't misread as the bot losing money (only shows when there ARE
              non-BTC hand trades on the account in the window). */}
          {!privacy && (() => {
            const s = splitRealizedBySymbol(data.account.realizedBySymbol);
            return s.hasManual ? (
              <div style={{ ...M.card, marginBottom: 6, fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: MUTED }}>Realized split</span>
                <span style={{ fontFamily: 'var(--mono)' }}>
                  <span style={{ color: sc(s.botUsd) }}>BTC bot {usd(s.botUsd)}</span>
                  <span style={{ color: MUTED }}> · </span>
                  <span style={{ color: sc(s.manualUsd) }} title={s.manualSymbols.join(', ')}>manual {usd(s.manualUsd)}</span>
                </span>
              </div>
            ) : null;
          })()}

          {/* reconciliation */}
          {data.reconciliation && data.reconciliation.likelySameAccount != null && (
            <div style={{ ...M.card, marginTop: 6, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--muted)' }}>Account vs bot equity</span>
                <span style={{ color: data.reconciliation.likelySameAccount ? UP : '#d4a017', fontWeight: 600 }}>
                  {data.reconciliation.likelySameAccount ? 'same acct' : 'diff acct'}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', marginTop: 4 }}>
                {usd(data.reconciliation.futuresWalletUsd, privacy)} vs {usd(data.reconciliation.botEquityTotalUsd, privacy)}
                {data.reconciliation.deltaUsd != null && <span style={{ color: 'var(--muted)' }}> · Δ {usd(data.reconciliation.deltaUsd, privacy)}</span>}
              </div>
            </div>
          )}

          {/* bot equity — the real live curve (v1 pushes hourly even with no
              futures key, so this renders on day one). Show the busiest leg. */}
          {(() => {
            const series = topSeries(data.botEquityCurve);
            return series.length > 1 ? (
              <>
                <div style={M.section as React.CSSProperties}>Bot equity · {legLabel(series[0].source)}</div>
                <div style={{ ...M.card, height: 160 }}>
                  <AreaChart
                    data={series}
                    pickY={(d) => d.equityUsd}
                    color={UP}
                    gradId="mobBotEq"
                    height={128}
                    formatY={(d) => usd(d.equityUsd)}
                  />
                </div>
              </>
            ) : null;
          })()}

          {/* open positions */}
          <div style={M.section as React.CSSProperties}>Open positions ({data.positions.length})</div>
          {data.positions.length === 0
            ? <div style={M.empty as React.CSSProperties}>No open positions.</div>
            : data.positions.map((p) => {
              const isBot = isBotSymbol(p.symbol);
              return (
              <div key={p.symbol} style={{ ...M.card, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{p.symbol} <PosTag isBot={isBot} /> <span style={{ color: p.positionAmt < 0 ? DOWN : UP, fontSize: 11 }}>{p.positionAmt < 0 ? 'SHORT' : 'LONG'}{p.leverage > 0 ? ` ${p.leverage}×` : ''}</span></div>
                    <div style={{ fontSize: 11, color: MUTED }}>entry {usd(p.entryPrice)} · mark {usd(p.markPrice)}{p.marginUsd != null ? <> · margin {usd(p.marginUsd, privacy)}</> : null}</div>
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: sc(p.unrealizedPnlUsd) }}>{usd(p.unrealizedPnlUsd, privacy)}</div>
                </div>
                {(p.slPriceUsd != null || p.tpPriceUsd != null) && !privacy && (
                  <div style={{ fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
                    <span style={{ color: p.slPriceUsd != null ? DOWN : MUTED }}>SL {p.slPriceUsd != null ? usd(p.slPriceUsd) : '—'}</span>
                    <span style={{ color: MUTED }}> · </span>
                    <span style={{ color: p.tpPriceUsd != null ? UP : MUTED }}>TP {p.tpPriceUsd != null ? usd(p.tpPriceUsd) : '—'}</span>
                  </div>
                )}
              </div>
              );
            })}

          {/* manual trades — hand-traded non-bot symbols: live open status +
              realized outcome over the range (account-side counterpart to bot
              legs). Only shown when hand trades exist. */}
          {data.manualTrades.length > 0 && (
            <>
              <div style={M.section as React.CSSProperties}>Manual trades</div>
              {data.manualTrades.map((m) => <ManualCard key={m.symbol} m={m} days={days} privacy={privacy} />)}
            </>
          )}

          <ChannelLadderCard privacy={privacy} />

          {/* bot legs */}
          <div style={M.section as React.CSSProperties}>Bot legs</div>
          {data.botLegs.length === 0
            ? <div style={M.empty as React.CSSProperties}>No bot legs have reported trades yet.</div>
            : data.botLegs.map((l) => (
              <div key={l.source} style={{ ...M.card, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700 }}>{l.source.replace('snapback-btc-', '').replace('snapback-btc', 'v1')}</span>
                  <span style={{ color: l.isHalted ? DOWN : UP, fontSize: 11, fontWeight: 600 }}>{l.isHalted ? 'HALTED' : 'live'}</span>
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4, display: 'flex', gap: 12 }}>
                  <span>{l.trades} trades</span>
                  <span>WR {l.winRatePct == null ? '—' : `${l.winRatePct.toFixed(0)}%`}</span>
                  <span style={{ color: sc(l.netPnlUsd) }}>net {usd(l.netPnlUsd, privacy)}</span>
                </div>
                {l.openExit && !privacy && (
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)', fontSize: 11, color: MUTED }}>
                    <div style={{ fontFamily: 'var(--mono)' }}>
                      <span style={{ color: l.openExit.slPriceUsd != null ? DOWN : MUTED }}>SL {l.openExit.slPriceUsd != null ? usd(l.openExit.slPriceUsd) : '—'}</span>
                      <span> · </span>
                      <span style={{ color: l.openExit.tpPriceUsd != null ? UP : MUTED }}>TP {l.openExit.tpPriceUsd != null ? usd(l.openExit.tpPriceUsd) : '—'}</span>
                    </div>
                    {l.openExit.exitCondition && <div style={{ marginTop: 2 }}>exit: {l.openExit.exitCondition}</div>}
                    {barsLeftStr(l.openExit) && <div style={{ marginTop: 2 }}>{barsLeftStr(l.openExit)}</div>}
                  </div>
                )}
              </div>
            ))}
        </>
      )}
    </div>
  );
}

// BOT (bot-traded symbol, e.g. BTC) vs MANUAL (hand trade on the same account).
function PosTag({ isBot }: { isBot: boolean }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: 0.5, padding: '2px 6px', borderRadius: 999,
      verticalAlign: 'middle',
      background: isBot ? 'rgba(47,128,199,0.18)' : 'rgba(212,160,23,0.20)',
      color: isBot ? '#4aa3e8' : '#d4a017',
    }}>{isBot ? 'BOT' : 'MANUAL'}</span>
  );
}

// One hand-traded symbol: header (symbol + live side or "flat" + realized over
// range), then the live open row (entry/mark/uPnL) and SL/TP when held.
function ManualCard({ m, days, privacy }: { m: ManualSymbolStats; days: number; privacy: boolean }) {
  const p = m.open;
  const short = p != null && p.positionAmt < 0;
  return (
    <div style={{ ...M.card, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 700 }}>
          {m.symbol}{' '}
          <span style={{ color: p ? (short ? DOWN : UP) : MUTED, fontSize: 11 }}>
            {p ? `${short ? 'SHORT' : 'LONG'}${p.leverage > 0 ? ` ${p.leverage}×` : ''}` : 'flat'}
          </span>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
          <span style={{ color: MUTED }}>realized {days}d </span>
          <span style={{ color: sc(m.realizedPnlUsd), fontWeight: 700 }}>{usd(m.realizedPnlUsd, privacy)}</span>
        </div>
      </div>
      {p && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <div style={{ fontSize: 11, color: MUTED }}>entry {usd(p.entryPrice)} · mark {usd(p.markPrice)}</div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: sc(p.unrealizedPnlUsd) }}>{usd(p.unrealizedPnlUsd, privacy)}</div>
        </div>
      )}
      {p && (p.slPriceUsd != null || p.tpPriceUsd != null) && !privacy && (
        <div style={{ fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          <span style={{ color: p.slPriceUsd != null ? DOWN : MUTED }}>SL {p.slPriceUsd != null ? usd(p.slPriceUsd) : '—'}</span>
          <span style={{ color: MUTED }}> · </span>
          <span style={{ color: p.tpPriceUsd != null ? UP : MUTED }}>TP {p.tpPriceUsd != null ? usd(p.tpPriceUsd) : '—'}</span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ ...M.card, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--mono)', color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}
