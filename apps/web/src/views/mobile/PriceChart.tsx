import { useLayoutEffect, useRef, useState } from 'react';

interface Trade {
  id: number;
  ts: number;
  side: 'BUY' | 'SELL' | 'DIV';
  qty: number;
  price_usd: number;
  fx_at_trade: number;
}

interface Props {
  data: { t: number; price: number }[];
  trades: Trade[];
  color: string;
  height?: number;
  refLine?: number;
  refLabel?: string;
  toDisplay: (usd: number) => number;
  fmt: (usd: number) => string;
}

// Touch-aware variant of PricePointChart from PriceModal. Differences:
// - Uses Pointer Events (so single handlers work for mouse + finger).
// - On the marker hit-test, falls back to nearest-day if the tap missed
//   any trade dot. The desktop version requires <14px proximity, which
//   maps poorly to a thumb.
// - Tooltip stays anchored until the user lifts the finger.
export function MobilePriceChart({
  data,
  trades,
  color,
  height = 220,
  refLine,
  refLabel,
  toDisplay,
  fmt,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverTrade, setHoverTrade] = useState<Trade | null>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const pad = { t: 18, r: 14, b: 24, l: 14 };
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
      ? `M ${x(0)},${H - pad.b} L ${data
          .map((d, i) => `${x(i)},${y(toDisplay(d.price))}`)
          .join(' L ')} L ${x(data.length - 1)},${H - pad.b} Z`
      : '';
  const dotEvery = Math.max(1, Math.floor(data.length / 30));

  function pointerAt(clientX: number) {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = clientX - rect.left;
    // Hit-test trade markers first — generous 18px window for finger.
    let nearest: { trade: Trade; dist: number } | null = null;
    for (const t of trades) {
      const tx = xAtTs(t.ts);
      const d = Math.abs(px - tx);
      if (d <= 18 && (!nearest || d < nearest.dist)) nearest = { trade: t, dist: d };
    }
    if (nearest) {
      setHoverTrade(nearest.trade);
      const i = Math.max(
        0,
        Math.min(data.length - 1, Math.round(((px - pad.l) / innerW) * (data.length - 1)))
      );
      setHoverIdx(i);
      return;
    }
    setHoverTrade(null);
    const i = Math.max(
      0,
      Math.min(data.length - 1, Math.round(((px - pad.l) / innerW) * (data.length - 1)))
    );
    setHoverIdx(i);
  }

  function clearHover() {
    setHoverIdx(null);
    setHoverTrade(null);
  }

  const dateAt = (i: number) =>
    new Date(data[i].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const tradeColor = (side: Trade['side']) =>
    side === 'BUY' ? 'var(--up)' : side === 'SELL' ? 'var(--down)' : 'var(--muted)';

  return (
    <div
      ref={ref}
      style={{ position: 'relative', width: '100%', height: H, touchAction: 'pan-y' }}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerAt(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0 && e.pointerType === 'mouse') {
          // mouse hover-without-press
          pointerAt(e.clientX);
        } else if (e.pointerType !== 'mouse') {
          pointerAt(e.clientX);
        }
      }}
      onPointerUp={() => {
        // Keep tooltip pinned briefly so the user can read it. No-op now;
        // user can tap elsewhere to dismiss via onPointerLeave on container.
      }}
      onPointerLeave={() => clearHover()}
    >
      {w > 0 && data.length > 0 && (
        <svg width={w} height={H} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <linearGradient id="m-phm-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#m-phm-grad)" />
          {refY != null && (
            <>
              <line
                x1={pad.l}
                x2={w - pad.r}
                y1={y(refY)}
                y2={y(refY)}
                stroke="var(--muted-2)"
                strokeWidth={1}
                strokeDasharray="4 4"
                opacity={0.6}
              />
              <text
                x={w - pad.r}
                y={y(refY) - 5}
                fill="var(--muted-2)"
                fontSize={9}
                fontFamily="var(--mono)"
                textAnchor="end"
                opacity={0.85}
              >
                {refLabel}
              </text>
            </>
          )}
          <polyline
            points={pts}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {data.map((d, i) =>
            i % dotEvery === 0 ? (
              <circle
                key={i}
                cx={x(i)}
                cy={y(toDisplay(d.price))}
                r={1.8}
                fill="var(--bg)"
                stroke={color}
                strokeWidth={1.2}
              />
            ) : null
          )}

          {trades.map((t) => {
            const cx = xAtTs(t.ts);
            const cy = y(toDisplay(t.price_usd));
            const c = tradeColor(t.side);
            const isHover = hoverTrade?.id === t.id;
            return (
              <g key={t.id}>
                <line
                  x1={cx}
                  x2={cx}
                  y1={pad.t}
                  y2={H - pad.b}
                  stroke={c}
                  strokeWidth={1}
                  strokeDasharray="2 4"
                  opacity={isHover ? 0.55 : 0.18}
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={isHover ? 7 : 5}
                  fill={c}
                  stroke="var(--bg)"
                  strokeWidth={2}
                />
              </g>
            );
          })}

          {hoverIdx != null && !hoverTrade && (
            <>
              <line
                x1={x(hoverIdx)}
                x2={x(hoverIdx)}
                y1={pad.t}
                y2={H - pad.b}
                stroke="currentColor"
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.3}
              />
              <circle
                cx={x(hoverIdx)}
                cy={y(toDisplay(data[hoverIdx].price))}
                r={5}
                fill={color}
                stroke="var(--bg)"
                strokeWidth={2}
              />
            </>
          )}

          <text x={pad.l} y={H - 4} fontSize={9} fontFamily="var(--mono)" fill="var(--muted)">
            {dateAt(0)}
          </text>
          <text
            x={w / 2}
            y={H - 4}
            fontSize={9}
            fontFamily="var(--mono)"
            fill="var(--muted)"
            textAnchor="middle"
          >
            {dateAt(Math.floor(data.length / 2))}
          </text>
          <text
            x={w - pad.r}
            y={H - 4}
            fontSize={9}
            fontFamily="var(--mono)"
            fill="var(--muted)"
            textAnchor="end"
          >
            {dateAt(data.length - 1)}
          </text>
        </svg>
      )}

      {hoverTrade && w > 0 && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(Math.max(xAtTs(hoverTrade.ts) - 90, 0), w - 200),
            top: 0,
            background: 'var(--surface-2)',
            border: `1px solid ${tradeColor(hoverTrade.side)}`,
            borderRadius: 8,
            padding: '8px 11px',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            pointerEvents: 'none',
            color: 'var(--text)',
            minWidth: 170,
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
              {new Date(hoverTrade.ts).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
          </div>
          <div>
            {hoverTrade.qty} @ {fmt(hoverTrade.price_usd)}
          </div>
          <div style={{ color: 'var(--muted)' }}>FX {hoverTrade.fx_at_trade.toFixed(4)} ฿/$</div>
          <div style={{ color: 'var(--muted)' }}>≈ {fmt(hoverTrade.qty * hoverTrade.price_usd)}</div>
        </div>
      )}
      {!hoverTrade && hoverIdx != null && data[hoverIdx] && w > 0 && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(Math.max(x(hoverIdx) - 60, 0), w - 130),
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
