// PriceHistoryModal — shown when a holdings row is clicked.
// Line + point chart of symbol price history, with range toggle and key stats.

function PriceHistoryModal({ position, currency, onClose }) {
  const [range, setRange] = React.useState('6M');
  const [hoverIdx, setHoverIdx] = React.useState(null);

  React.useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    // lock body scroll
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (!position) return null;

  const rangeDays = { '1M': 30, '3M': 90, '6M': 180, '1Y': 180 }[range] || 180;
  const full = symbolSeries(position.sym, position.priceUSD, position.avgUSD, 180);
  const data = full.slice(-rangeDays);

  const displayInTHB = currency === 'THB';
  const toDisplay = (usdPrice) => displayInTHB ? usdPrice * FX.USDTHB : usdPrice;
  const fmt = (usd) => displayInTHB ? fmtTHB(toDisplay(usd), { dp: usd < 10 ? 2 : 0 }) : fmtUSD(usd, { dp: usd < 10 ? 3 : 2 });

  const prices = data.map(d => d.price);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const change = last - first;
  const changePct = (change / first) * 100;
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  const hover = hoverIdx != null ? data[hoverIdx] : null;
  const displayPrice = hover ? hover.price : last;
  const displayDate = hover ? new Date(hover.t) : new Date(data[data.length - 1].t);

  const color = change >= 0 ? 'var(--up)' : 'var(--down)';
  const costColor = 'var(--muted-2)';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20, animation: 'phm-fade 180ms ease-out',
      }}
    >
      <style>{`
        @keyframes phm-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes phm-pop { from { opacity: 0; transform: translateY(12px) scale(0.98) } to { opacity: 1; transform: none } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 760,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 28,
          fontFamily: 'var(--ui)',
          color: 'var(--text)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.4)',
          animation: 'phm-pop 220ms cubic-bezier(.2,.9,.3,1.15)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 46, height: 46, borderRadius: 10,
              background: 'var(--surface-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, letterSpacing: 0.3,
            }}>{position.sym}</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.2 }}>{position.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                {position.plat} · {position.sector} · {position.qty} {position.qty === 1 ? 'share' : 'units'} held
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--muted)', cursor: 'pointer',
            fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>×</button>
        </div>

        {/* Price + change */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 4 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 40, fontWeight: 300, letterSpacing: -1.2, lineHeight: 1 }}>
            {fmt(displayPrice)}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color }}>
            {(change >= 0 ? '+' : '−')}{fmt(Math.abs(change)).replace(/^[−-]/, '')}
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 12, padding: '2px 7px', borderRadius: 4,
            color, background: change >= 0 ? 'var(--up-bg)' : 'var(--down-bg)',
          }}>
            {fmtPct(changePct)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto', fontFamily: 'var(--mono)' }}>
            {displayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        </div>

        {/* Chart */}
        <div style={{ marginTop: 18 }}>
          <PricePointChart
            data={data}
            color={color}
            height={240}
            hoverIdx={hoverIdx}
            onHover={setHoverIdx}
            refLine={position.avgUSD}
            refLabel={`Your avg cost · ${fmtUSD(position.avgUSD, { dp: position.avgUSD < 10 ? 3 : 2 })}`}
            refColor={costColor}
            toDisplay={toDisplay}
            fmt={fmt}
          />
        </div>

        {/* Range toggle */}
        <div style={{ display: 'flex', gap: 4, marginTop: 14, marginBottom: 20 }}>
          {['1M', '3M', '6M', '1Y'].map(r => (
            <button key={r} onClick={() => setRange(r)} style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.5,
              background: range === r ? 'var(--text)' : 'var(--surface-2)',
              color: range === r ? 'var(--bg)' : 'var(--muted)',
              fontWeight: 600,
            }}>{r}</button>
          ))}
        </div>

        {/* Stat strip */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12,
          padding: '14px 16px', background: 'var(--surface)', borderRadius: 10,
          border: '1px solid var(--border)',
        }}>
          <Stat label="Period high" value={fmt(max)} />
          <Stat label="Period low"  value={fmt(min)} />
          <Stat label="Your avg"    value={fmt(position.avgUSD)} muted />
          <Stat
            label="Position PNL"
            value={currency === 'THB'
              ? fmtTHB(position.pnlTHB, { sign: true })
              : fmtUSD(position.pnlUSD, { sign: true })}
            color={position.pnlPct >= 0 ? 'var(--up)' : 'var(--down)'}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color, muted }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: color || (muted ? 'var(--muted-2)' : 'var(--text)') }}>{value}</div>
    </div>
  );
}

// Line + point chart — every datapoint gets a dot, line connects them.
function PricePointChart({ data, color, height = 240, hoverIdx, onHover, refLine, refLabel, refColor, toDisplay, fmt }) {
  const ref = React.useRef(null);
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(e => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const H = height, pad = { t: 20, r: 16, b: 28, l: 16 };
  const innerW = Math.max(0, w - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;

  const prices = data.map(d => toDisplay(d.price));
  const refY = refLine != null ? toDisplay(refLine) : null;
  const values = refY != null ? [...prices, refY] : prices;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = (max - min) || 1;
  const pMin = min - range * 0.06;
  const pMax = max + range * 0.06;
  const pRange = pMax - pMin;

  const x = (i) => pad.l + (i / (data.length - 1)) * innerW;
  const y = (v) => pad.t + innerH - ((v - pMin) / pRange) * innerH;

  const pts = data.map((d, i) => `${x(i)},${y(toDisplay(d.price))}`).join(' ');
  const areaPath = data.length
    ? `M ${x(0)},${H - pad.b} L ${data.map((d, i) => `${x(i)},${y(toDisplay(d.price))}`).join(' L ')} L ${x(data.length - 1)},${H - pad.b} Z`
    : '';

  // Decimate dots so we don't draw 180 of them on a small chart
  const dotEvery = Math.max(1, Math.floor(data.length / 40));

  function handleMove(e) {
    const rect = ref.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / innerW) * (data.length - 1))));
    onHover(i);
  }

  const gradId = 'phm-grad';

  // Date labels: start, middle, end
  const dateAt = (i) => new Date(data[i].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div
      ref={ref}
      style={{ position: 'relative', width: '100%', height: H }}
      onMouseMove={handleMove}
      onMouseLeave={() => onHover(null)}
    >
      {w > 0 && (
        <svg width={w} height={H} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Fill */}
          <path d={areaPath} fill={`url(#${gradId})`} />

          {/* Reference line: avg cost */}
          {refY != null && (
            <>
              <line x1={pad.l} x2={w - pad.r} y1={y(refY)} y2={y(refY)} stroke={refColor} strokeWidth="1" strokeDasharray="4 4" opacity="0.6" />
              <text x={w - pad.r} y={y(refY) - 5} fill={refColor} fontSize="10" fontFamily="var(--mono)" textAnchor="end" opacity="0.85">{refLabel}</text>
            </>
          )}

          {/* Main line */}
          <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {/* Decimated points */}
          {data.map((d, i) => (i % dotEvery === 0) && (
            <circle
              key={i}
              cx={x(i)} cy={y(toDisplay(d.price))} r="2.2"
              fill="var(--bg)" stroke={color} strokeWidth="1.4"
            />
          ))}

          {/* Hover */}
          {hoverIdx != null && (
            <>
              <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={pad.t} y2={H - pad.b} stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
              <circle cx={x(hoverIdx)} cy={y(toDisplay(data[hoverIdx].price))} r="5" fill={color} stroke="var(--bg)" strokeWidth="2" />
            </>
          )}

          {/* X-axis date labels */}
          <text x={pad.l}             y={H - 6} fontSize="10" fontFamily="var(--mono)" fill="var(--muted)">{dateAt(0)}</text>
          <text x={w / 2}             y={H - 6} fontSize="10" fontFamily="var(--mono)" fill="var(--muted)" textAnchor="middle">{dateAt(Math.floor(data.length / 2))}</text>
          <text x={w - pad.r}         y={H - 6} fontSize="10" fontFamily="var(--mono)" fill="var(--muted)" textAnchor="end">{dateAt(data.length - 1)}</text>
        </svg>
      )}

      {hoverIdx != null && (
        <div style={{
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
        }}>
          {fmt(data[hoverIdx].price)}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { PriceHistoryModal });
