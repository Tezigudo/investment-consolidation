import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { fmtPct, fmtTHB, fmtUSD } from '../../lib/format';
import { MobilePriceChart } from './PriceChart';
import type { Currency, EnrichedPosition } from '@consolidate/shared';
import type { CostView } from '../MobileShell';

type Range = '1M' | '3M' | '6M' | '1Y';
const RANGE_DAYS: Record<Range, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };

interface Trade {
  id: number;
  ts: number;
  side: 'BUY' | 'SELL' | 'DIV';
  qty: number;
  price_usd: number;
  fx_at_trade: number;
  commission: number | null;
  source: string | null;
}

const REWARD_SOURCES = new Set(['api-reward']);
function isSpotTrade(t: Trade): boolean {
  if (t.side !== 'BUY' && t.side !== 'SELL') return false;
  if (t.source && REWARD_SOURCES.has(t.source)) return false;
  return true;
}

interface Props {
  position: EnrichedPosition;
  currency: Currency;
  usdthb: number;
  costView: CostView;
  onClose: () => void;
}

export function PositionSheet({ position, currency, usdthb, costView, onClose }: Props) {
  const [range, setRange] = useState<Range>('6M');
  const kind = position.platform === 'DIME' ? 'stock' : 'crypto';

  // Fetch the widest window (1Y) once per session and slice client-side
  // for range buttons. Avoids a fresh round-trip on every range tap, which
  // on Fly's auto-suspending free machine can stack 5–15 s if the symbol's
  // prices_daily cache is cold. Mirrors the desktop HeroHistoryChart's
  // single-fetch pattern.
  const { data } = useQuery({
    queryKey: ['symbol-history', position.symbol, kind],
    queryFn: () => api.symbolHistory(position.symbol, { days: 365, kind }),
    staleTime: 5 * 60_000,
  });

  // Lock body scroll while sheet is open. Esc / hardware back close it.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const fullSeries = data?.series ?? [];
  // Slice the series for the active range. Series is daily, sorted ascending,
  // so taking the tail is exact for the requested window.
  const series = useMemo(() => {
    if (!fullSeries.length) return fullSeries;
    return fullSeries.slice(-RANGE_DAYS[range]);
  }, [fullSeries, range]);
  const allTrades = (data?.trades ?? []) as Trade[];
  const inTHB = currency === 'THB';
  const toDisplay = (usd: number) => (inTHB ? usd * usdthb : usd);
  const fmt = (usd: number) =>
    inTHB ? fmtTHB(toDisplay(usd), { dp: usd < 10 ? 2 : 0 }) : fmtUSD(usd, { dp: usd < 10 ? 3 : 2 });

  const prices = series.map((s) => s.price);
  const hasSeries = prices.length > 0;
  const first = prices[0] ?? 0;
  // Fall back to position.priceUSD when the chart series hasn't loaded yet —
  // otherwise "Holding value" reads ฿0 even though /portfolio already knows
  // the live price.
  const last = prices[prices.length - 1] ?? position.priceUSD ?? 0;
  // change / min / max only make sense when the series is loaded; otherwise
  // show "—" instead of fake zeros (was misleading: ฿0 high/low/change while
  // PNL shows +฿182).
  const change = hasSeries ? last - first : 0;
  const changePct = hasSeries && first > 0 ? (change / first) * 100 : 0;
  const prevPrice = prices.length >= 2 ? prices[prices.length - 2] : last;
  const dayChange = hasSeries ? last - prevPrice : 0;
  const dayChangePct = hasSeries && prevPrice > 0 ? (dayChange / prevPrice) * 100 : 0;
  const min = hasSeries ? Math.min(...prices) : 0;
  const max = hasSeries ? Math.max(...prices) : 0;
  const holdingUSD = position.qty * last;

  const realizedUSD = data?.realizedUSD ?? 0;
  const realizedTHB = data?.realizedTHB ?? 0;
  const hasRealized = Math.abs(realizedUSD) >= 0.005;

  const isDimeView = costView === 'dime';
  const dimeAvgUSD = position.qty > 0 ? position.fifoCostUSD / position.qty : position.avgUSD;
  const avgShown = isDimeView ? dimeAvgUSD : position.avgUSD;
  const unrealizedUSDShown = isDimeView ? holdingUSD - position.fifoCostUSD : position.pnlUSD;
  const unrealizedTHBShown = isDimeView
    ? position.qty * last * usdthb - position.fifoCostTHB
    : position.pnlTHB;

  const earned = data?.earned ?? { qty: 0, valueUSD: 0, valueTHB: 0, count: 0, vaults: 0, firstTs: 0, lastTs: 0 };
  const hasEarned = earned.qty > 0;
  const earnedNowUSD = earned.qty * last;
  const earnedNowTHB = earnedNowUSD * usdthb;
  const airdrop = data?.airdrop ?? null;
  const hasAirdrop = !!airdrop && airdrop.qty > 0;
  const totalRewardsQty = earned.qty + (airdrop?.qty ?? 0);
  const totalRewardsNowUSD = totalRewardsQty * last;
  const totalRewardsNowTHB = totalRewardsNowUSD * usdthb;
  const hasAnyRewards = hasEarned || hasAirdrop;

  const tradesInRange = useMemo(() => {
    if (!series.length) return [] as Trade[];
    const t0 = series[0].t;
    const t1 = series[series.length - 1].t + 86_400_000;
    return allTrades.filter((t) => isSpotTrade(t) && t.ts >= t0 && t.ts < t1);
  }, [allTrades, series]);

  const color = change >= 0 ? 'var(--up)' : 'var(--down)';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        animation: 'm-sheet-up 220ms ease-out',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <style>{`
        @keyframes m-sheet-up {
          from { transform: translateY(20px); opacity: 0.6; }
          to   { transform: translateY(0);    opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg)',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Back"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 10px 6px 4px',
            background: 'transparent',
            border: 'none',
            color: 'var(--text)',
            cursor: 'pointer',
            fontFamily: 'var(--ui)',
            fontSize: 14,
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back
        </button>
        <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
          {position.platform}
        </div>
      </div>

      <div style={{ padding: '16px 16px 32px' }}>
        {/* Title block */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 12,
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--mono)',
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {position.symbol}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {position.name ?? position.symbol}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              {position.sector ?? '—'} · {position.qty} held
            </div>
          </div>
        </div>

        {/* Price */}
        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 32,
              fontWeight: 300,
              letterSpacing: -1,
              lineHeight: 1,
            }}
          >
            {fmt(last)}
          </div>
          {hasSeries && (
            <>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color }}>
                {change >= 0 ? '+' : '−'}
                {fmt(Math.abs(change)).replace(/^[−-]/, '')}
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  padding: '2px 7px',
                  borderRadius: 4,
                  color,
                  background: change >= 0 ? 'var(--up-bg)' : 'var(--down-bg)',
                }}
              >
                {range} {fmtPct(changePct)}
              </div>
            </>
          )}
        </div>

        {/* Chart */}
        <div style={{ marginTop: 14 }}>
          <MobilePriceChart
            data={series}
            trades={tradesInRange}
            color={color}
            height={210}
            refLine={position.avgUSD}
            refLabel={`Your avg · ${fmtUSD(position.avgUSD, { dp: position.avgUSD < 10 ? 3 : 2 })}`}
            toDisplay={toDisplay}
            fmt={fmt}
          />
        </div>

        {/* Range buttons */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 6,
            marginTop: 14,
            marginBottom: 18,
          }}
        >
          {(['1M', '3M', '6M', '1Y'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                padding: '8px 0',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                letterSpacing: 0.5,
                background: range === r ? 'var(--text)' : 'var(--surface-2)',
                color: range === r ? 'var(--bg)' : 'var(--muted)',
                fontWeight: 600,
              }}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Stats grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            padding: '14px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
          }}
        >
          <Stat label="Period high" value={hasSeries ? fmt(max) : '—'} />
          <Stat label="Period low" value={hasSeries ? fmt(min) : '—'} />
          <Stat
            label="1D change"
            value={
              hasSeries
                ? `${dayChange >= 0 ? '+' : '−'}${fmt(Math.abs(dayChange))} (${fmtPct(dayChangePct)})`
                : '—'
            }
            color={hasSeries ? (dayChange >= 0 ? 'var(--up)' : 'var(--down)') : undefined}
          />
          <Stat label={isDimeView ? 'Your avg (DIME)' : 'Your avg'} value={fmt(avgShown)} muted />
          <Stat label="Holding value" value={fmt(holdingUSD)} />
          <Stat
            label="Unrealized PNL"
            value={
              currency === 'THB'
                ? fmtTHB(unrealizedTHBShown, { sign: true })
                : fmtUSD(unrealizedUSDShown, { sign: true })
            }
            color={unrealizedUSDShown >= 0 ? 'var(--up)' : 'var(--down)'}
          />
          {hasRealized && !isDimeView && (
            <Stat
              label="Realized PNL"
              value={
                currency === 'THB' ? fmtTHB(realizedTHB, { sign: true }) : fmtUSD(realizedUSD, { sign: true })
              }
              color={realizedUSD >= 0 ? 'var(--up)' : 'var(--down)'}
            />
          )}
          {hasRealized && !isDimeView && (
            <Stat
              label="Net PNL"
              value={
                currency === 'THB'
                  ? fmtTHB(position.pnlTHB + realizedTHB, { sign: true })
                  : fmtUSD(position.pnlUSD + realizedUSD, { sign: true })
              }
              color={position.pnlUSD + realizedUSD >= 0 ? 'var(--up)' : 'var(--down)'}
            />
          )}
        </div>

        {hasAnyRewards && (hasEarned ? 1 : 0) + (hasAirdrop ? 1 : 0) > 1 && (
          <Card title="Total rewards">
            <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600, color: 'var(--up)' }}>
              {totalRewardsQty.toLocaleString('en-US', { maximumFractionDigits: 6 })} {position.symbol}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              {currency === 'THB' ? fmtTHB(totalRewardsNowTHB) : fmtUSD(totalRewardsNowUSD)} at today's price · vault yield + airdrop combined
            </div>
          </Card>
        )}

        {hasEarned && (
          <Card title="Earn rewards">
            <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600, color: 'var(--up)' }}>
              {earned.qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} {position.symbol}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              {earnedSubtitle(earned)} · worth{' '}
              {currency === 'THB' ? fmtTHB(earnedNowTHB) : fmtUSD(earnedNowUSD)} now (
              {currency === 'THB' ? fmtTHB(earned.valueTHB) : fmtUSD(earned.valueUSD)} at receipt)
            </div>
          </Card>
        )}

        {hasAirdrop && airdrop && (
          <Card title="Airdrop received">
            <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600, color: 'var(--up)' }}>
              {airdrop.qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} {position.symbol}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              {airdrop.count} drops from {airdrop.sources} distributor{airdrop.sources === 1 ? '' : 's'} ·{' '}
              {currency === 'THB' ? fmtTHB(airdrop.valueTHB) : fmtUSD(airdrop.valueUSD)} at today's price
            </div>
          </Card>
        )}

        {/* Trade list */}
        {allTrades.filter(isSpotTrade).length > 0 && (
          <TradeList trades={allTrades.filter(isSpotTrade)} currency={currency} usdthb={usdthb} />
        )}
      </div>
    </div>
  );
}

// Earn-rewards subtitle: distinguishes Binance Earn discrete payouts from
// on-chain ERC-4626 vaults (continuous yield via share-price). Either or
// both may contribute, so the label adapts.
function earnedSubtitle(e: { count: number; vaults: number }): string {
  const parts: string[] = [];
  if (e.count > 0) parts.push(`${e.count} payout${e.count === 1 ? '' : 's'}`);
  if (e.vaults > 0) parts.push(`${e.vaults} vault${e.vaults === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' + ') : 'no payouts yet';
}

function Stat({ label, value, color, muted }: { label: string; value: string; color?: string; muted?: boolean }) {
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 13,
          color: color ?? (muted ? 'var(--muted-2)' : 'var(--text)'),
          fontWeight: 500,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: 14,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function TradeList({ trades, currency, usdthb }: { trades: Trade[]; currency: Currency; usdthb: number }) {
  const sorted = [...trades].sort((a, b) => b.ts - a.ts);
  const inTHB = currency === 'THB';
  const fmt = (usd: number) =>
    inTHB ? fmtTHB(usd * usdthb, { dp: usd < 10 ? 2 : 0 }) : fmtUSD(usd, { dp: usd < 10 ? 3 : 2 });
  const tc = (s: Trade['side']) => (s === 'BUY' ? 'var(--up)' : s === 'SELL' ? 'var(--down)' : 'var(--muted)');
  return (
    <div style={{ marginTop: 18 }}>
      <div
        style={{
          fontSize: 10,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 8,
        }}
      >
        Transactions ({trades.length})
      </div>
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        {sorted.map((t, i) => (
          <div
            key={t.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px',
              borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: tc(t.side), fontWeight: 700, fontFamily: 'var(--mono)', fontSize: 11 }}>
                  {t.side}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                  {new Date(t.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                FX {t.fx_at_trade.toFixed(2)}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                {t.qty} × {fmt(t.price_usd)}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                ≈ {fmt(t.qty * t.price_usd + (t.side === 'SELL' ? -1 : 1) * (t.commission ?? 0))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
