import { useLayoutEffect, useRef, useState } from 'react';

function useSize(ref: React.RefObject<HTMLDivElement>): { w: number; h: number } {
  const [sz, setSz] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => {
      const r = e[0].contentRect;
      setSz({ w: r.width, h: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return sz;
}

// ── Area line chart ─────────────────────────────────────────
interface AreaProps<T> {
  data: T[];
  pickY: (d: T) => number;
  color: string;
  gradId: string;
  // number → fixed pixel height. 'auto' → fill parent (parent must have a
  // defined height; the chart measures its container with a ResizeObserver).
  height?: number | 'auto';
  fill?: boolean;
  formatY?: (d: T) => string;
  onHover?: (i: number | null) => void;
}

export function AreaChart<T>({
  data,
  pickY,
  color,
  gradId,
  height = 220,
  fill = true,
  formatY,
  onHover,
}: AreaProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h: measuredH } = useSize(ref);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const pad = { t: 16, r: 12, b: 24, l: 12 };
  const fluid = height === 'auto';
  const H = fluid ? measuredH : height;
  const values = data.map(pickY);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const innerW = Math.max(0, w - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;

  const x = (i: number) => pad.l + (i / Math.max(1, data.length - 1)) * innerW;
  const y = (v: number) => pad.t + innerH - ((v - min) / range) * innerH;

  const pts = data.map((d, i) => `${x(i)},${y(pickY(d))}`).join(' ');
  const areaPath =
    data.length > 0
      ? `M ${x(0)},${H - pad.b} L ${data.map((d, i) => `${x(i)},${y(pickY(d))}`).join(' L ')} L ${x(
          data.length - 1,
        )},${H - pad.b} Z`
      : '';

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.max(
      0,
      Math.min(data.length - 1, Math.round(((px - pad.l) / innerW) * (data.length - 1))),
    );
    setHover({ i, x: x(i), y: y(pickY(data[i])) });
    onHover?.(i);
  }

  return (
    <div
      ref={ref}
      style={{ position: 'relative', width: '100%', height: fluid ? '100%' : H, minHeight: 0 }}
      onMouseMove={handleMove}
      onMouseLeave={() => {
        setHover(null);
        onHover?.(null);
      }}
    >
      {w > 0 && H > 0 && (
        <svg width={w} height={H} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {fill && <path d={areaPath} fill={`url(#${gradId})`} />}
          <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={pad.t} y2={H - pad.b} stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" opacity={0.3} />
              <circle cx={hover.x} cy={hover.y} r={5} fill={color} stroke="var(--bg)" strokeWidth={2} />
            </>
          )}
        </svg>
      )}
      {hover && formatY && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(Math.max(hover.x - 60, 0), w - 120),
            top: 0,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            color: 'var(--text)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {formatY(data[hover.i])}
        </div>
      )}
    </div>
  );
}

// ── Donut ───────────────────────────────────────────────────
export interface Slice {
  label?: string;
  value: number;
  color: string;
}
export function Donut({
  slices,
  size = 180,
  thickness = 22,
  centerLabel,
  centerValue,
}: {
  slices: Slice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const r = size / 2 - thickness / 2 - 2;
  const c = size / 2;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map((s, i) => {
        const frac = s.value / total;
        const len = frac * 2 * Math.PI * r;
        const gap = 2 * Math.PI * r - len;
        const off = -acc * 2 * Math.PI * r;
        acc += frac;
        return (
          <circle
            key={i}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={thickness}
            strokeDasharray={`${len} ${gap}`}
            strokeDashoffset={off}
            transform={`rotate(-90 ${c} ${c})`}
            strokeLinecap="butt"
          />
        );
      })}
      {centerValue && (
        <>
          <text x={c} y={c - 4} textAnchor="middle" fontSize={10} fill="var(--muted)" fontFamily="var(--mono)" style={{ letterSpacing: 0.5 }}>
            {centerLabel}
          </text>
          <text x={c} y={c + 14} textAnchor="middle" fontSize={17} fill="var(--text)" fontFamily="var(--mono)" fontWeight={600}>
            {centerValue}
          </text>
        </>
      )}
    </svg>
  );
}

// ── Horizontal winners/losers ──────────────────────────────
export function WinLossBar({
  rows,
  format,
}: {
  rows: { sym: string; pnl: number }[];
  format: (n: number) => string;
}) {
  const max = Math.max(...rows.map((r) => Math.abs(r.pnl)), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r, i) => {
        const pct = Math.abs(r.pnl) / max;
        const pos = r.pnl >= 0;
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '52px 1fr 90px', alignItems: 'center', gap: 10 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{r.sym}</div>
            <div style={{ position: 'relative', height: 8, background: 'var(--surface-2)', borderRadius: 4 }}>
              <div
                style={{
                  position: 'absolute',
                  [pos ? 'left' : 'right']: '50%',
                  top: 0,
                  bottom: 0,
                  width: `${pct * 50}%`,
                  background: pos ? 'var(--up)' : 'var(--down)',
                  borderRadius: 4,
                }}
              />
              <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'var(--border)' }} />
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right', color: pos ? 'var(--up)' : 'var(--down)' }}>
              {format(r.pnl)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
