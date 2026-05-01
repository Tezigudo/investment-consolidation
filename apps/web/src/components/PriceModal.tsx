import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { fmtPct, fmtTHB, fmtUSD } from '../lib/format';
import type { Currency, EnrichedPosition, Platform } from '@consolidate/shared';

interface Props {
  position: EnrichedPosition & { plat?: Platform };
  currency: Currency;
  usdthb: number;
  onClose: () => void;
}

type Range = '1M' | '3M' | '6M' | '1Y';
const RANGE_DAYS: Record<Range, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };

interface TradeRow {
  id: number;
  ts: number;
  side: 'BUY' | 'SELL' | 'DIV';
  qty: number;
  price_usd: number;
  fx_at_trade: number;
  source: string | null;
}

// Sources that represent passive payouts, not user-initiated spot trades.
// Binance Earn rewards land as `side: 'BUY'` with `source: 'api-reward'`,
// so filtering by side alone is not enough.
const REWARD_SOURCES = new Set(['api-reward']);
function isSpotTrade(t: TradeRow): boolean {
  if (t.side !== 'BUY' && t.side !== 'SELL') return false;
  if (t.source && REWARD_SOURCES.has(t.source)) return false;
  return true;
}

export function PriceModal({ position, currency, usdthb, onClose }: Props) {
  const [range, setRange] = useState<Range>('6M');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverTrade, setHoverTrade] = useState<TradeRow | null>(null);
  const kind = position.platform === 'Binance' ? 'crypto' : 'stock';

  const { data } = useQuery({
    queryKey: ['symbol-history', position.symbol, kind, RANGE_DAYS[range]],
    queryFn: () => api.symbolHistory(position.symbol, { days: RANGE_DAYS[range], kind }),
    staleTime: 60_000,
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const series = data?.series ?? [];
  const allTrades = data?.trades ?? [];
  const inTHB = currency === 'THB';
  const toDisplay = (usd: number) => (inTHB ? usd * usdthb : usd);
  const fmt = (usd: number) =>
    inTHB ? fmtTHB(toDisplay(usd), { dp: usd < 10 ? 2 : 0 }) : fmtUSD(usd, { dp: usd < 10 ? 3 : 2 });

  const prices = series.map((s) => s.price);
  const first = prices[0] ?? 0;
  const last = prices[prices.length - 1] ?? 0;
  const change = last - first;
  const changePct = first > 0 ? (change / first) * 100 : 0;
  const min = prices.length ? Math.min(...prices) : 0;
  const max = prices.length ? Math.max(...prices) : 0;

  // Spot trades that fall inside the visible window. Earn/reward rows
  // are excluded so chart markers only represent buy/sell decisions.
  const tradesInRange = useMemo(() => {
    if (!series.length) return [] as TradeRow[];
    const t0 = series[0].t;
    const t1 = series[series.length - 1].t + 86_400_000;
    return allTrades.filter((t) => isSpotTrade(t) && t.ts >= t0 && t.ts < t1);
  }, [allTrades, series]);

  const hover = hoverIdx != null ? series[hoverIdx] : null;
  const displayPrice = hoverTrade ? hoverTrade.price_usd : hover ? hover.price : last;
  const displayDate = hoverTrade
    ? new Date(hoverTrade.ts)
    : hover
      ? new Date(hover.t)
      : series.length
        ? new Date(series[series.length - 1].t)
        : new Date();
  const color = change >= 0 ? 'var(--up)' : 'var(--down)';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 820,
          maxHeight: 'calc(100vh - 40px)',
          overflowY: 'auto',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 28,
          color: 'var(--text)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: 10,
                background: 'var(--surface-2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--mono)',
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              {position.symbol}
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{position.name ?? position.symbol}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                {position.platform} · {position.sector ?? '—'} · {position.qty} held
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 4 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 40, fontWeight: 300, letterSpacing: -1.2, lineHeight: 1 }}>{fmt(displayPrice)}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color }}>
            {change >= 0 ? '+' : '−'}
            {fmt(Math.abs(change)).replace(/^[−-]/, '')}
          </div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              padding: '2px 7px',
              borderRadius: 4,
              color,
              background: change >= 0 ? 'var(--up-bg)' : 'var(--down-bg)',
            }}
          >
            {fmtPct(changePct)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto', fontFamily: 'var(--mono)' }}>
            {displayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <PricePointChart
            data={series}
            trades={tradesInRange}
            color={color}
            height={240}
            hoverIdx={hoverIdx}
            onHover={setHoverIdx}
            hoverTrade={hoverTrade}
            onHoverTrade={setHoverTrade}
            refLine={position.avgUSD}
            refLabel={`Your avg · ${fmtUSD(position.avgUSD, { dp: position.avgUSD < 10 ? 3 : 2 })}`}
            toDisplay={toDisplay}
            fmt={fmt}
          />
        </div>

        <div style={{ display: 'flex', gap: 4, marginTop: 14, marginBottom: 20 }}>
          {(['1M', '3M', '6M', '1Y'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
                fontSize: 11,
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

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
            padding: '14px 16px',
            background: 'var(--surface)',
            borderRadius: 10,
            border: '1px solid var(--border)',
          }}
        >
          <Stat label="Period high" value={fmt(max)} />
          <Stat label="Period low" value={fmt(min)} />
          <Stat label="Your avg" value={fmt(position.avgUSD)} muted />
          <Stat
            label="Position PNL"
            value={currency === 'THB' ? fmtTHB(position.pnlTHB, { sign: true }) : fmtUSD(position.pnlUSD, { sign: true })}
            color={position.pnlPct >= 0 ? 'var(--up)' : 'var(--down)'}
          />
        </div>

        {allTrades.length > 0 && (
          <TradeList trades={allTrades.filter(isSpotTrade)} currency={currency} usdthb={usdthb} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color, muted }: { label: string; value: string; color?: string; muted?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: color ?? (muted ? 'var(--muted-2)' : 'var(--text)') }}>{value}</div>
    </div>
  );
}

interface PPCProps {
  data: { t: number; price: number }[];
  trades: TradeRow[];
  color: string;
  height?: number;
  hoverIdx: number | null;
  onHover: (i: number | null) => void;
  hoverTrade: TradeRow | null;
  onHoverTrade: (t: TradeRow | null) => void;
  refLine?: number;
  refLabel?: string;
  toDisplay: (usd: number) => number;
  fmt: (usd: number) => string;
}
function PricePointChart({ data, trades, color, height = 240, hoverIdx, onHover, hoverTrade, onHoverTrade, refLine, refLabel, toDisplay, fmt }: PPCProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const pad = { t: 20, r: 16, b: 28, l: 16 };
  const innerW = Math.max(0, w - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;
  const prices = data.map((d) => toDisplay(d.price));
  const refY = refLine != null ? toDisplay(refLine) : null;
  const tradePricesDisplay = trades.map((t) => toDisplay(t.price_usd));
  const values = [...prices, ...tradePricesDisplay, ...(refY != null ? [refY] : [])];
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const range = max - min || 1;
  const pMin = min - range * 0.06;
  const pMax = max + range * 0.06;
  const pRange = pMax - pMin || 1;

  const tStart = data[0]?.t ?? 0;
  const tEnd = data[data.length - 1]?.t ?? 1;
  const tSpan = Math.max(1, tEnd - tStart);

  const x = (i: number) => pad.l + (i / Math.max(1, data.length - 1)) * innerW;
  const xAtTs = (ts: number) => pad.l + ((ts - tStart) / tSpan) * innerW;
  const y = (v: number) => pad.t + innerH - ((v - pMin) / pRange) * innerH;

  const pts = data.map((d, i) => `${x(i)},${y(toDisplay(d.price))}`).join(' ');
  const areaPath =
    data.length > 0
      ? `M ${x(0)},${H - pad.b} L ${data.map((d, i) => `${x(i)},${y(toDisplay(d.price))}`).join(' L ')} L ${x(
          data.length - 1,
        )},${H - pad.b} Z`
      : '';
  const dotEvery = Math.max(1, Math.floor(data.length / 40));

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // First, see if the cursor is near a trade marker (within 14px).
    let nearest: { trade: TradeRow; dist: number } | null = null;
    for (const t of trades) {
      const tx = xAtTs(t.ts);
      const d = Math.abs(px - tx);
      if (d <= 14 && (!nearest || d < nearest.dist)) nearest = { trade: t, dist: d };
    }
    if (nearest) {
      onHoverTrade(nearest.trade);
      // Snap series-hover to the closest day for the vertical guide.
      const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / innerW) * (data.length - 1))));
      onHover(i);
      return;
    }
    onHoverTrade(null);
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / innerW) * (data.length - 1))));
    onHover(i);
  }

  const dateAt = (i: number) => new Date(data[i].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const tradeColor = (side: TradeRow['side']) =>
    side === 'BUY' ? 'var(--up)' : side === 'SELL' ? 'var(--down)' : 'var(--muted)';

  return (
    <div
      ref={ref}
      style={{ position: 'relative', width: '100%', height: H }}
      onMouseMove={handleMove}
      onMouseLeave={() => {
        onHover(null);
        onHoverTrade(null);
      }}
    >
      {w > 0 && data.length > 0 && (
        <svg width={w} height={H} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <linearGradient id="phm-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#phm-grad)" />
          {refY != null && (
            <>
              <line x1={pad.l} x2={w - pad.r} y1={y(refY)} y2={y(refY)} stroke="var(--muted-2)" strokeWidth={1} strokeDasharray="4 4" opacity={0.6} />
              <text x={w - pad.r} y={y(refY) - 5} fill="var(--muted-2)" fontSize={10} fontFamily="var(--mono)" textAnchor="end" opacity={0.85}>
                {refLabel}
              </text>
            </>
          )}
          <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {data.map((d, i) =>
            i % dotEvery === 0 ? (
              <circle key={i} cx={x(i)} cy={y(toDisplay(d.price))} r={2.2} fill="var(--bg)" stroke={color} strokeWidth={1.4} />
            ) : null,
          )}

          {/* Trade markers — drawn at trade ts mapped to chart x and trade price mapped to chart y. */}
          {trades.map((t) => {
            const cx = xAtTs(t.ts);
            const cy = y(toDisplay(t.price_usd));
            const c = tradeColor(t.side);
            const isHover = hoverTrade?.id === t.id;
            return (
              <g key={t.id}>
                <line x1={cx} x2={cx} y1={pad.t} y2={H - pad.b} stroke={c} strokeWidth={1} strokeDasharray="2 4" opacity={isHover ? 0.55 : 0.18} />
                <circle cx={cx} cy={cy} r={isHover ? 7 : 5} fill={c} stroke="var(--bg)" strokeWidth={2} />
              </g>
            );
          })}

          {hoverIdx != null && !hoverTrade && (
            <>
              <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={pad.t} y2={H - pad.b} stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" opacity={0.3} />
              <circle cx={x(hoverIdx)} cy={y(toDisplay(data[hoverIdx].price))} r={5} fill={color} stroke="var(--bg)" strokeWidth={2} />
            </>
          )}

          <text x={pad.l} y={H - 6} fontSize={10} fontFamily="var(--mono)" fill="var(--muted)">
            {dateAt(0)}
          </text>
          <text x={w / 2} y={H - 6} fontSize={10} fontFamily="var(--mono)" fill="var(--muted)" textAnchor="middle">
            {dateAt(Math.floor(data.length / 2))}
          </text>
          <text x={w - pad.r} y={H - 6} fontSize={10} fontFamily="var(--mono)" fill="var(--muted)" textAnchor="end">
            {dateAt(data.length - 1)}
          </text>
        </svg>
      )}

      {/* Tooltip — trade detail when hovering a marker, plain price otherwise. */}
      {hoverTrade && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(Math.max(xAtTs(hoverTrade.ts) - 90, 0), (w || 0) - 200),
            top: 0,
            background: 'var(--surface-2)',
            border: `1px solid ${tradeColor(hoverTrade.side)}`,
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            pointerEvents: 'none',
            color: 'var(--text)',
            minWidth: 180,
            lineHeight: 1.5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span
              style={{
                color: tradeColor(hoverTrade.side),
                fontWeight: 700,
                letterSpacing: 0.5,
              }}
            >
              {hoverTrade.side}
            </span>
            <span style={{ color: 'var(--muted)' }}>
              {new Date(hoverTrade.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
          <div>{hoverTrade.qty} @ {fmt(hoverTrade.price_usd)}</div>
          <div style={{ color: 'var(--muted)' }}>FX {hoverTrade.fx_at_trade.toFixed(4)} ฿/$</div>
          <div style={{ color: 'var(--muted)' }}>≈ {fmt(hoverTrade.qty * hoverTrade.price_usd)}</div>
        </div>
      )}
      {!hoverTrade && hoverIdx != null && data[hoverIdx] && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(Math.max(x(hoverIdx) - 60, 0), (w || 0) - 140),
            top: 0,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            color: 'var(--text)',
          }}
        >
          {fmt(data[hoverIdx].price)}
        </div>
      )}
    </div>
  );
}

function TradeList({ trades, currency, usdthb }: { trades: TradeRow[]; currency: Currency; usdthb: number }) {
  const sorted = [...trades].sort((a, b) => b.ts - a.ts);
  const inTHB = currency === 'THB';
  const fmt = (usd: number) =>
    inTHB ? fmtTHB(usd * usdthb, { dp: usd < 10 ? 2 : 0 }) : fmtUSD(usd, { dp: usd < 10 ? 3 : 2 });
  const tradeColor = (side: TradeRow['side']) =>
    side === 'BUY' ? 'var(--up)' : side === 'SELL' ? 'var(--down)' : 'var(--muted)';
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
        Transactions ({trades.length})
      </div>
      <div
        style={{
          maxHeight: 220,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--surface)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11 }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
            <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
              <th style={th}>Date</th>
              <th style={th}>Side</th>
              <th style={{ ...th, textAlign: 'right' }}>Qty</th>
              <th style={{ ...th, textAlign: 'right' }}>Price</th>
              <th style={{ ...th, textAlign: 'right' }}>FX</th>
              <th style={{ ...th, textAlign: 'right' }}>Value</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>{new Date(t.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</td>
                <td style={{ ...td, color: tradeColor(t.side), fontWeight: 700 }}>{t.side}</td>
                <td style={{ ...td, textAlign: 'right' }}>{t.qty}</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(t.price_usd)}</td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--muted)' }}>{t.fx_at_trade.toFixed(2)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(t.qty * t.price_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 12px', fontWeight: 500, fontSize: 10, letterSpacing: 0.4 };
const td: React.CSSProperties = { padding: '8px 12px' };
