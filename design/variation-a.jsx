// Variation A — Robinhood-style: single flowing column, hero PNL, generous whitespace.
// Designed to feel like a consumer app. Dark mode with cream option.
// Focus is on the BIG number at top + the portfolio curve beneath it.

function VariationA({ currency, setCurrency, dark, privacy }) {
  const [range, setRange] = React.useState('6M');
  const [hoverIdx, setHoverIdx] = React.useState(null);
  const [selected, setSelected] = React.useState(null);

  const t = TOTALS.all;
  const valCur = currency === 'THB' ? t.marketTHB : currency === 'USDT' ? t.marketUSD / FX.USDTUSD : t.marketUSD;
  const pnlCur = currency === 'THB' ? t.pnlTHB : currency === 'USDT' ? t.pnlUSD / FX.USDTUSD : t.pnlUSD;
  const costCur = currency === 'THB' ? t.costTHB : currency === 'USDT' ? t.costUSD / FX.USDTUSD : t.costUSD;
  const pnlPct = (pnlCur / costCur) * 100;

  const seriesField = currency === 'THB' ? 'thb' : 'usd';
  const hoverPoint = hoverIdx != null ? SERIES[hoverIdx] : SERIES[SERIES.length - 1];
  const heroVal = hoverPoint[seriesField] * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);

  const platforms = [
    { key: 'dime',    name: 'DIME',    sub: 'US stocks, offshore', tot: TOTALS.dime,    color: 'var(--accent)', positions: PORTFOLIO.dime.length },
    { key: 'binance', name: 'Binance', sub: 'Crypto',              tot: TOTALS.binance, color: 'var(--accent-2)', positions: PORTFOLIO.binance.length },
    { key: 'bank',    name: 'Bank',    sub: 'THB cash',            tot: TOTALS.bank,    color: 'var(--muted-2)', positions: 1 },
  ];

  const winners = [...PORTFOLIO.dime, ...PORTFOLIO.binance]
    .sort((a, b) => (currency === 'THB' ? b.pnlTHB - a.pnlTHB : b.pnlUSD - a.pnlUSD))
    .slice(0, 6)
    .map(p => ({ sym: p.sym, pnl: currency === 'THB' ? p.pnlTHB : p.pnlUSD }));

  const losersAndWinners = [...PORTFOLIO.dime, ...PORTFOLIO.binance]
    .sort((a, b) => Math.abs(currency === 'THB' ? b.pnlTHB : b.pnlUSD) - Math.abs(currency === 'THB' ? a.pnlTHB : a.pnlUSD))
    .slice(0, 6)
    .map(p => ({ sym: p.sym, pnl: currency === 'THB' ? p.pnlTHB : p.pnlUSD }));

  return (
    <div className="var-a" style={{ ...themeVars(dark), background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--ui)', width: '100%', minHeight: '100%' }}>
      <TopBar currency={currency} setCurrency={setCurrency} variant="A" />

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 24px 120px' }}>

        {/* HERO — DUAL CURRENCY (THB + USD side by side) */}
        <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--muted)', letterSpacing: 0.3 }}>Total portfolio</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
          <DualHeroCell
            label="Thai Baht"
            tag="THB · true"
            value={t.marketTHB}
            pnl={t.pnlTHB}
            pct={(t.pnlTHB / t.costTHB) * 100}
            primary={currency === 'THB'}
            privacy={privacy}
            cur="THB"
          />
          <DualHeroCell
            label="US Dollar"
            tag="USD · market"
            value={t.marketUSD}
            pnl={t.pnlUSD}
            pct={(t.pnlUSD / t.costUSD) * 100}
            primary={currency === 'USD'}
            privacy={privacy}
            cur="USD"
          />
        </div>

        {/* TRUE PNL BREAKDOWN — always shown under dual hero */}
        <div style={{ padding: '14px 16px', background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Market PNL</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 15, color: (t.pnlTHB - t.fxContribTHB) >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtTHB(t.pnlTHB - t.fxContribTHB, { sign: true })}</div>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>asset appreciation</div>
          </div>
          <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>FX contribution</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 15, color: t.fxContribTHB >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtTHB(t.fxContribTHB, { sign: true })}</div>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>THB weak since deposit</div>
          </div>
          <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Total THB</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 15, color: t.pnlTHB >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtTHB(t.pnlTHB, { sign: true })}</div>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>what you actually gain</div>
          </div>
        </div>

        {/* CHART */}
        <div style={{ marginTop: 28 }}>
          <AreaChart
            data={SERIES}
            pickY={d => d[seriesField] * (currency === 'USDT' ? 1 / FX.USDTUSD : 1)}
            color={pnlCur >= 0 ? 'var(--up)' : 'var(--down)'}
            gradId="hero-grad-a"
            height={200}
            onHover={setHoverIdx}
            formatY={d => fmtMoney(d[seriesField] * (currency === 'USDT' ? 1 / FX.USDTUSD : 1), currency, { dp: currency === 'THB' ? 0 : 2 })}
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 8, justifyContent: 'center' }}>
            {['1W', '1M', '3M', '6M', '1Y', 'ALL'].map(r => (
              <button key={r} onClick={() => setRange(r)} className="pill" data-active={range === r}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* PLATFORMS */}
        <SectionHeader>Platforms</SectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {platforms.map(p => {
            const v = currency === 'THB' ? p.tot.marketTHB : p.tot.marketUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);
            const pnl = currency === 'THB' ? p.tot.pnlTHB : p.tot.pnlUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);
            const pct = p.tot.costUSD > 0 ? (p.tot.pnlUSD / p.tot.costUSD) * 100 : 0;
            return (
              <div key={p.key} className="row-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: p.color, opacity: 0.15, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: p.color, position: 'absolute', opacity: 1 }}>
                      {p.name[0]}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{p.sub} · {p.positions} {p.positions === 1 ? 'position' : 'positions'}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 500 }}>{privacy ? '•••••' : fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 })}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
                    {fmtMoney(pnl, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })} · {fmtPct(pct)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ALLOCATION */}
        <SectionHeader>Allocation</SectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 24, alignItems: 'center', padding: '20px 18px', background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)' }}>
          <Donut
            slices={[
              { value: TOTALS.dime.marketUSD, color: 'var(--accent)' },
              { value: TOTALS.binance.marketUSD, color: 'var(--accent-2)' },
              { value: TOTALS.bank.marketUSD, color: 'var(--muted-2)' },
            ]}
            size={160}
            thickness={20}
            centerLabel="Positions"
            centerValue={String(PORTFOLIO.dime.length + PORTFOLIO.binance.length + 1)}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {platforms.map(p => {
              const pct = (p.tot.marketUSD / TOTALS.all.marketUSD) * 100;
              return (
                <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                  <span style={{ fontSize: 13, flex: 1 }}>{p.name}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--muted)' }}>{pct.toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* HOLDINGS */}
        <SectionHeader action="See all">Top movers</SectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--border)', borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border)' }}>
          {[...PORTFOLIO.dime, ...PORTFOLIO.binance]
            .sort((a, b) => Math.abs(b.pnlPct) - Math.abs(a.pnlPct))
            .slice(0, 6)
            .map(p => {
              const v = currency === 'THB' ? p.marketTHB : p.marketUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);
              const pnl = currency === 'THB' ? p.pnlTHB : p.pnlUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);
              return (
                <div key={p.sym} className="holding-row row-clickable" onClick={() => setSelected({ ...p, plat: PORTFOLIO.dime.includes(p) ? 'DIME' : 'Binance' })} style={{ cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="symbol-chip">{p.sym}</div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                        {p.qty} @ {fmtUSD(p.avgUSD, { dp: p.priceUSD < 10 ? 3 : 2 })}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <Spark values={Array.from({ length: 20 }, (_, i) => p.avgUSD + (p.priceUSD - p.avgUSD) * (i / 19) + Math.sin(i * 0.7 + p.sym.charCodeAt(0)) * Math.abs(p.priceUSD - p.avgUSD) * 0.15)} color={p.pnlUSD >= 0 ? 'var(--up)' : 'var(--down)'} w={64} h={22} />
                    <div style={{ textAlign: 'right', minWidth: 90 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{privacy ? '•••' : fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 })}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtPct(p.pnlPct)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
        </div>

        {/* WINNERS/LOSERS */}
        <SectionHeader>Winners & losers</SectionHeader>
        <div style={{ padding: 20, background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)' }}>
          <WinLossBar rows={losersAndWinners} currency={currency} />
        </div>

        {/* FX */}
        <SectionHeader>THB / USD</SectionHeader>
        <div style={{ padding: 20, background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 500 }}>{FX.USDTHB.toFixed(2)}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Baht per dollar</div>
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--up)' }}>+1.22 (+3.4%) 6M</div>
          </div>
          <AreaChart
            data={FX_SERIES}
            pickY={d => d.rate}
            color="var(--muted-2)"
            gradId="fx-grad-a"
            height={110}
            fill={true}
            formatY={d => d.rate.toFixed(3)}
          />
        </div>

        {/* DIVIDENDS */}
        <SectionHeader>Dividend income · 12M</SectionHeader>
        <div style={{ padding: 20, background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 500 }}>{fmtMoney(DIVS.reduce((a, d) => a + d.v, 0) * (currency === 'THB' ? FX.USDTHB : 1), currency, { dp: currency === 'THB' ? 0 : 2 })}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>received</div>
          </div>
          <VerticalBars data={DIVS} height={100} color="var(--accent)" />
        </div>

        {/* RECENT */}
        <SectionHeader action="See all">Recent activity</SectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'hidden' }}>
          {TXS.slice(0, 6).map((t, i) => (
            <div key={i} className="tx-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: txTypeColor(t.type, 'bg'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ color: txTypeColor(t.type, 'fg'), fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}>{txIcon(t.type)}</span>
                </div>
                <div>
                  <div style={{ fontSize: 14 }}>
                    <span style={{ fontWeight: 500 }}>{t.type}</span>
                    <span style={{ color: 'var(--muted)' }}> · {t.sym}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{t.plat} · {t.d}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                  {t.type === 'DEPOSIT' ? fmtTHB(t.qty) : t.type === 'DIV' ? fmtUSD(t.priceUSD) : `${t.qty} × ${fmtUSD(t.priceUSD, { dp: t.priceUSD < 10 ? 3 : 2 })}`}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>FX {t.fx}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      {selected && <PriceHistoryModal position={selected} currency={currency} onClose={() => setSelected(null)} />}
    </div>
  );
}

function SectionHeader({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 40, marginBottom: 14 }}>
      <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.2 }}>{children}</div>
      {action && <div style={{ fontSize: 13, color: 'var(--accent)', cursor: 'pointer' }}>{action} →</div>}
    </div>
  );
}

function TopBar({ currency, setCurrency, variant }) {
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'color-mix(in oklab, var(--bg) 90%, transparent)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--border)' }}>
      <div style={{ maxWidth: variant === 'A' ? 720 : 1240, margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700 }}>∑</div>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: -0.2 }}>Consolidate</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6, fontFamily: 'var(--mono)' }}>
            {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · live
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 8 }}>
          {['USD', 'THB', 'USDT'].map(c => (
            <button key={c} onClick={() => setCurrency(c)}
              style={{
                padding: '5px 12px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                fontWeight: 600,
                border: 'none',
                borderRadius: 5,
                cursor: 'pointer',
                background: currency === c ? 'var(--surface)' : 'transparent',
                color: currency === c ? 'var(--text)' : 'var(--muted)',
                boxShadow: currency === c ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
              }}>{c}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function txTypeColor(type, which) {
  const m = {
    BUY:     { bg: 'color-mix(in oklab, var(--up) 18%, transparent)',  fg: 'var(--up)' },
    SELL:    { bg: 'color-mix(in oklab, var(--down) 18%, transparent)', fg: 'var(--down)' },
    DIV:     { bg: 'color-mix(in oklab, var(--accent) 18%, transparent)', fg: 'var(--accent)' },
    DEPOSIT: { bg: 'var(--surface-2)', fg: 'var(--muted)' },
  };
  return m[type][which];
}
function txIcon(type) {
  return { BUY: '↑', SELL: '↓', DIV: '$', DEPOSIT: '⇢' }[type] || '•';
}

function themeVars(dark) {
  if (dark) {
    return {
      '--bg': '#0b0c0f',
      '--surface': '#131519',
      '--surface-2': '#1b1e24',
      '--border': '#23262d',
      '--text': '#eef0f3',
      '--muted': '#8b8f97',
      '--muted-2': '#6b7280',
      '--accent':   'oklch(0.78 0.16 150)',
      '--accent-2': 'oklch(0.75 0.14 55)',
      '--up':       'oklch(0.82 0.19 145)',
      '--up-bg':    'color-mix(in oklab, oklch(0.82 0.19 145) 16%, transparent)',
      '--down':     'oklch(0.72 0.19 25)',
      '--down-bg':  'color-mix(in oklab, oklch(0.72 0.19 25) 16%, transparent)',
      '--mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      '--ui':   '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    };
  }
  return {
    '--bg': '#faf9f6',
    '--surface': '#ffffff',
    '--surface-2': '#f2f0ec',
    '--border': '#e7e4de',
    '--text': '#1a1a1a',
    '--muted': '#6b6b6b',
    '--muted-2': '#9a9a9a',
    '--accent':   'oklch(0.55 0.17 150)',
    '--accent-2': 'oklch(0.62 0.14 55)',
    '--up':       'oklch(0.52 0.19 145)',
    '--up-bg':    'color-mix(in oklab, oklch(0.52 0.19 145) 14%, transparent)',
    '--down':     'oklch(0.58 0.22 25)',
    '--down-bg':  'color-mix(in oklab, oklch(0.58 0.22 25) 14%, transparent)',
    '--mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    '--ui':   '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  };
}

function DualHeroCell({ label, tag, value, pnl, pct, primary, privacy, cur }) {
  return (
    <div style={{
      padding: '18px 20px',
      background: primary ? 'var(--surface)' : 'var(--surface-2)',
      borderRadius: 14,
      border: `1px solid ${primary ? 'var(--text)' : 'var(--border)'}`,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>
        <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', padding: '2px 6px', background: 'var(--bg)', borderRadius: 4, letterSpacing: 0.5 }}>{tag}</div>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 30, fontWeight: 400, letterSpacing: -0.8, lineHeight: 1.1 }}>
        {privacy ? '•••••••' : fmtMoney(value, cur, { dp: cur === 'THB' ? 0 : 2 })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
          {fmtMoney(pnl, cur, { sign: true, dp: cur === 'THB' ? 0 : 2 })}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '1px 6px', borderRadius: 3, color: pnl >= 0 ? 'var(--up)' : 'var(--down)', background: pnl >= 0 ? 'var(--up-bg)' : 'var(--down-bg)' }}>
          {fmtPct(pct)}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { VariationA, TopBar, SectionHeader, themeVars, txTypeColor, txIcon, DualHeroCell });
