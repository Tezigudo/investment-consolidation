// Lightweight SVG charts — no dependencies, sharp lines, consumer-fintech look.
// Line/area/donut/bar — all sized responsively via parent height/width.

function useSize(ref) {
  const [sz, setSz] = React.useState({ w: 0, h: 0 });
  React.useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(e => {
      const r = e[0].contentRect;
      setSz({ w: r.width, h: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return sz;
}

// ── Portfolio value / PNL area line
function AreaChart({ data, pickY, color, gradId, fill = true, showAxis = true, height = 220, pad = { t: 16, r: 12, b: 24, l: 12 }, formatY, onHover }) {
  const ref = React.useRef(null);
  const { w } = useSize(ref);
  const [hover, setHover] = React.useState(null);
  const H = height;
  const values = data.map(pickY);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const innerW = Math.max(0, w - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;

  const x = (i) => pad.l + (i / (data.length - 1)) * innerW;
  const y = (v) => pad.t + innerH - ((v - min) / range) * innerH;

  const pts = data.map((d, i) => `${x(i)},${y(pickY(d))}`).join(' ');
  const areaPath = data.length
    ? `M ${x(0)},${H - pad.b} L ${data.map((d, i) => `${x(i)},${y(pickY(d))}`).join(' L ')} L ${x(data.length - 1)},${H - pad.b} Z`
    : '';

  function handleMove(e) {
    const rect = ref.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / innerW) * (data.length - 1))));
    setHover({ i, x: x(i), y: y(pickY(data[i])) });
    onHover && onHover(i);
  }

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%', height: H }}
         onMouseMove={handleMove}
         onMouseLeave={() => { setHover(null); onHover && onHover(null); }}>
      {w > 0 && (
        <svg width={w} height={H} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {fill && <path d={areaPath} fill={`url(#${gradId})`} />}
          <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={pad.t} y2={H - pad.b} stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
              <circle cx={hover.x} cy={hover.y} r="5" fill={color} stroke="white" strokeWidth="2" />
            </>
          )}
        </svg>
      )}
      {hover && formatY && (
        <div style={{
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
        }}>
          {formatY(data[hover.i])}
        </div>
      )}
    </div>
  );
}

// ── Dual line (PNL: THB vs USD indexed)
function DualLine({ data, height = 180 }) {
  const ref = React.useRef(null);
  const { w } = useSize(ref);
  const H = height, pad = { t: 16, r: 12, b: 8, l: 12 };
  // Normalize each series to % change from start
  const startUSD = data[0].usd, startTHB = data[0].thb;
  const usdPct = data.map(d => ((d.usd - startUSD) / startUSD) * 100);
  const thbPct = data.map(d => ((d.thb - startTHB) / startTHB) * 100);
  const all = [...usdPct, ...thbPct];
  const min = Math.min(...all, 0);
  const max = Math.max(...all, 0);
  const range = max - min || 1;
  const innerW = Math.max(0, w - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;
  const x = (i) => pad.l + (i / (data.length - 1)) * innerW;
  const y = (v) => pad.t + innerH - ((v - min) / range) * innerH;
  const usdPts = usdPct.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const thbPts = thbPct.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const zeroY = y(0);

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%', height: H }}>
      {w > 0 && (
        <svg width={w} height={H} style={{ display: 'block', overflow: 'visible' }}>
          <line x1={pad.l} x2={w - pad.r} y1={zeroY} y2={zeroY} stroke="currentColor" strokeWidth="1" strokeDasharray="2 4" opacity="0.2" />
          <polyline points={usdPts} fill="none" stroke="var(--accent-2)" strokeWidth="1.75" opacity="0.7" />
          <polyline points={thbPts} fill="none" stroke="var(--accent)" strokeWidth="2.25" />
        </svg>
      )}
    </div>
  );
}

// ── Donut
function Donut({ slices, size = 180, thickness = 22, centerLabel, centerValue }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
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
          <circle key={i} cx={c} cy={c} r={r}
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
          <text x={c} y={c - 4} textAnchor="middle" fontSize="10" fill="var(--muted)" fontFamily="var(--mono)" style={{ letterSpacing: 0.5 }}>{centerLabel}</text>
          <text x={c} y={c + 14} textAnchor="middle" fontSize="17" fill="var(--text)" fontFamily="var(--mono)" fontWeight="600">{centerValue}</text>
        </>
      )}
    </svg>
  );
}

// ── Horizontal bar — winners / losers
function WinLossBar({ rows, height = 220, currency = 'USD' }) {
  const max = Math.max(...rows.map(r => Math.abs(r.pnl)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r, i) => {
        const pct = Math.abs(r.pnl) / max;
        const pos = r.pnl >= 0;
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '52px 1fr 90px', alignItems: 'center', gap: 10 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{r.sym}</div>
            <div style={{ position: 'relative', height: 8, background: 'var(--surface-2)', borderRadius: 4 }}>
              <div style={{
                position: 'absolute',
                [pos ? 'left' : 'right']: '50%',
                top: 0,
                bottom: 0,
                width: `${pct * 50}%`,
                background: pos ? 'var(--up)' : 'var(--down)',
                borderRadius: 4,
              }} />
              <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'var(--border)' }} />
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right', color: pos ? 'var(--up)' : 'var(--down)' }}>
              {fmtMoney(r.pnl, currency, { sign: true })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Vertical bar (dividends)
function VerticalBars({ data, height = 120, color = 'var(--accent)' }) {
  const ref = React.useRef(null);
  const { w } = useSize(ref);
  const max = Math.max(...data.map(d => d.v));
  const pad = { t: 14, r: 4, b: 18, l: 4 };
  const innerH = height - pad.t - pad.b;
  const barW = w > 0 ? Math.max(4, (w - pad.l - pad.r) / data.length - 6) : 10;
  return (
    <div ref={ref} style={{ width: '100%', height }}>
      {w > 0 && (
        <svg width={w} height={height} style={{ display: 'block' }}>
          {data.map((d, i) => {
            const h = (d.v / max) * innerH;
            const x = pad.l + i * ((w - pad.l - pad.r) / data.length) + 3;
            const y = height - pad.b - h;
            return (
              <g key={i}>
                <rect x={x} y={y} width={barW} height={h} fill={color} rx="2" opacity={0.85} />
                <text x={x + barW / 2} y={height - 4} fontSize="9" textAnchor="middle" fill="var(--muted)" fontFamily="var(--mono)">{d.m}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// ── Sparkline
function Spark({ values, color = 'currentColor', w = 60, h = 20 }) {
  const min = Math.min(...values), max = Math.max(...values), r = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / r) * h}`).join(' ');
  return <svg width={w} height={h}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

Object.assign(window, { AreaChart, DualLine, Donut, WinLossBar, VerticalBars, Spark });
