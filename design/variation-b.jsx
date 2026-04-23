// Variation B — Wealthfront-style: multi-widget grid, allocation-forward.
// Dense dashboard with many simultaneous widgets. Same data model as A.

function VariationB({ currency, setCurrency, dark, privacy }) {
  const [selected, setSelected] = React.useState(null);
  const t = TOTALS.all;
  const valCur = currency === 'THB' ? t.marketTHB : currency === 'USDT' ? t.marketUSD / FX.USDTUSD : t.marketUSD;
  const pnlCur = currency === 'THB' ? t.pnlTHB : currency === 'USDT' ? t.pnlUSD / FX.USDTUSD : t.pnlUSD;
  const pnlPct = (pnlCur / (currency === 'THB' ? t.costTHB : t.costUSD / (currency === 'USDT' ? FX.USDTUSD : 1))) * 100;
  const seriesField = currency === 'THB' ? 'thb' : 'usd';

  // Build asset-class allocation
  const allPositions = [...PORTFOLIO.dime, ...PORTFOLIO.binance];
  const bySector = {};
  allPositions.forEach(p => {
    bySector[p.sector] = (bySector[p.sector] || 0) + p.marketUSD;
  });
  bySector['THB Cash'] = TOTALS.bank.marketUSD;

  const sectorColors = {
    Tech: 'oklch(0.72 0.15 250)',
    Semis: 'oklch(0.78 0.16 150)',
    Auto: 'oklch(0.75 0.14 55)',
    Retail: 'oklch(0.70 0.16 340)',
    ETF: 'oklch(0.68 0.10 200)',
    Crypto: 'oklch(0.75 0.16 80)',
    Stable: 'oklch(0.65 0.08 160)',
    'THB Cash': 'oklch(0.60 0.04 80)',
  };

  const sectorSlices = Object.entries(bySector).map(([k, v]) => ({ label: k, value: v, color: sectorColors[k] || 'var(--muted-2)' }));

  return (
    <div className="var-b" style={{ ...themeVars(dark), background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--ui)', width: '100%', minHeight: '100%' }}>
      <TopBar currency={currency} setCurrency={setCurrency} variant="B" />

      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 28px 120px' }}>

        {/* TOP ROW: Hero + Platform breakdown */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16, marginBottom: 16 }}>
          {/* Hero card — DUAL CURRENCY side-by-side */}
          <div className="widget" style={{ padding: '22px 26px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>Net Worth · both currencies</div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>Today</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--up)' }}>+1.23%</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <DualHeroCell label="Thai Baht" tag="THB · true"   value={t.marketTHB} pnl={t.pnlTHB} pct={(t.pnlTHB / t.costTHB) * 100} primary={currency === 'THB'} privacy={privacy} cur="THB" />
              <DualHeroCell label="US Dollar" tag="USD · market" value={t.marketUSD} pnl={t.pnlUSD} pct={(t.pnlUSD / t.costUSD) * 100} primary={currency === 'USD'} privacy={privacy} cur="USD" />
            </div>
            <div style={{ marginTop: 16 }}>
              <AreaChart
                data={SERIES}
                pickY={d => d[seriesField] * (currency === 'USDT' ? 1 / FX.USDTUSD : 1)}
                color={pnlCur >= 0 ? 'var(--up)' : 'var(--down)'}
                gradId="hero-grad-b"
                height={110}
                formatY={d => fmtMoney(d[seriesField] * (currency === 'USDT' ? 1 / FX.USDTUSD : 1), currency, { dp: currency === 'THB' ? 0 : 2 })}
              />
            </div>
          </div>

          {/* THB true-PNL card (prominent) */}
          <div className="widget" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 10 }}>True PNL · breakdown</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Market PNL</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, color: 'var(--up)' }}>{fmtTHB(t.pnlTHB - t.fxContribTHB, { sign: true })}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>{fmtUSD(t.pnlUSD, { sign: true })} · asset appreciation</div>
              </div>
              <div style={{ height: 1, background: 'var(--border)' }} />
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>FX contribution</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, color: t.fxContribTHB >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtTHB(t.fxContribTHB, { sign: true })}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>Avg FX in: 35.42 · now {FX.USDTHB.toFixed(2)}</div>
              </div>
              <div style={{ height: 1, background: 'var(--border)' }} />
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Total THB PNL</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 500, color: t.pnlTHB >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtTHB(t.pnlTHB, { sign: true })}</div>
              </div>
            </div>
          </div>
        </div>

        {/* 2nd ROW: THB vs USD PNL dual line + Allocation donut + Platforms stacked */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="PNL — THB vs USD" sub="Indexed to start, last 180 days" />
            <DualLine data={SERIES} height={180} />
            <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 11 }}>
              <LegendDot color="var(--accent)" label="THB" />
              <LegendDot color="var(--accent-2)" label="USD" />
              <div style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                THB outperforms by +3.4pp (FX tailwind)
              </div>
            </div>
          </div>

          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="By asset class" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Donut slices={sectorSlices} size={140} thickness={18} centerLabel="Classes" centerValue={String(sectorSlices.length)} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, fontSize: 11 }}>
                {sectorSlices.sort((a, b) => b.value - a.value).slice(0, 6).map(s => (
                  <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: s.color }} />
                    <span style={{ flex: 1 }}>{s.label}</span>
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{((s.value / TOTALS.all.marketUSD) * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="By platform" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 4 }}>
              {[
                { key: 'dime', name: 'DIME', sub: 'US stocks', color: 'var(--accent)', tot: TOTALS.dime },
                { key: 'binance', name: 'Binance', sub: 'Crypto', color: 'var(--accent-2)', tot: TOTALS.binance },
                { key: 'bank', name: 'Bank', sub: 'THB cash', color: 'var(--muted-2)', tot: TOTALS.bank },
              ].map(p => {
                const v = currency === 'THB' ? p.tot.marketTHB : p.tot.marketUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);
                const pct = (p.tot.marketUSD / TOTALS.all.marketUSD) * 100;
                const pnl = currency === 'THB' ? p.tot.pnlTHB : p.tot.pnlUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);
                return (
                  <div key={p.key}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{p.sub}</span>
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>{pct.toFixed(1)}%</div>
                    </div>
                    <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: p.color, opacity: 0.85 }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{privacy ? '•••' : fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 })}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtMoney(pnl, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 3rd ROW: FX + Dividends + Winners */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: 16, marginBottom: 16 }}>
          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="THB / USD rate" sub="6-month trend" />
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 500 }}>{FX.USDTHB.toFixed(2)}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--up)' }}>+3.4%</div>
            </div>
            <AreaChart data={FX_SERIES} pickY={d => d.rate} color="var(--muted-2)" gradId="fx-grad-b" height={100} formatY={d => d.rate.toFixed(3)} />
          </div>

          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="Dividends · 12M" sub={`${fmtUSD(DIVS.reduce((a, d) => a + d.v, 0))} received`} />
            <VerticalBars data={DIVS} height={130} color="var(--accent)" />
          </div>

          <div className="widget" style={{ padding: '18px 20px' }}>
            <WidgetHeader title="Top movers" sub="By absolute PNL" />
            <WinLossBar
              rows={[...PORTFOLIO.dime, ...PORTFOLIO.binance]
                .sort((a, b) => Math.abs(currency === 'THB' ? b.pnlTHB : b.pnlUSD) - Math.abs(currency === 'THB' ? a.pnlTHB : a.pnlUSD))
                .slice(0, 6)
                .map(p => ({ sym: p.sym, pnl: currency === 'THB' ? p.pnlTHB : p.pnlUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1) }))}
              currency={currency}
            />
          </div>
        </div>

        {/* HOLDINGS TABLE */}
        <div className="widget" style={{ padding: 0, marginBottom: 16 }}>
          <div style={{ padding: '18px 24px 14px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Holdings</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{PORTFOLIO.dime.length + PORTFOLIO.binance.length} positions across DIME & Binance</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="pill" data-active="true">All</button>
              <button className="pill">DIME</button>
              <button className="pill">Binance</button>
            </div>
          </div>
          <table className="holdings-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Symbol</th>
                <th>Platform</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Avg cost</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th style={{ textAlign: 'right' }}>Market</th>
                <th style={{ textAlign: 'right' }}>PNL ({currency})</th>
                <th style={{ textAlign: 'right' }}>%</th>
                <th style={{ textAlign: 'right' }}>FX locked</th>
              </tr>
            </thead>
            <tbody>
              {[...PORTFOLIO.dime.map(p => ({ ...p, plat: 'DIME' })), ...PORTFOLIO.binance.map(p => ({ ...p, plat: 'Binance' }))]
                .sort((a, b) => b.marketUSD - a.marketUSD)
                .map(p => {
                  const v = currency === 'THB' ? p.marketTHB : p.marketUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);
                  const pnl = currency === 'THB' ? p.pnlTHB : p.pnlUSD * (currency === 'USDT' ? 1 / FX.USDTUSD : 1);
                  return (
                    <tr key={p.sym + p.plat} onClick={() => setSelected(p)} style={{ cursor: 'pointer' }} className="row-clickable">
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="symbol-chip">{p.sym}</div>
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{p.name}</div>
                        </div>
                      </td>
                      <td><span className="plat-tag" data-plat={p.plat}>{p.plat}</span></td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{p.qty}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{fmtUSD(p.avgUSD, { dp: p.avgUSD < 10 ? 3 : 2 })}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtUSD(p.priceUSD, { dp: p.priceUSD < 10 ? 3 : 2 })}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{privacy ? '•••' : fmtMoney(v, currency, { dp: currency === 'THB' ? 0 : 2 })}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtMoney(pnl, currency, { sign: true, dp: currency === 'THB' ? 0 : 2 })}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: p.pnlPct >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtPct(p.pnlPct)}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{p.fxLocked.toFixed(2)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {/* BOTTOM: Transactions + Import */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
          <div className="widget" style={{ padding: 0 }}>
            <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Recent transactions</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Aggregated across platforms</div>
            </div>
            {TXS.slice(0, 8).map((tx, i) => (
              <div key={i} className="tx-row" style={{ borderBottom: i === 7 ? 'none' : '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 7, background: txTypeColor(tx.type, 'bg'), display: 'flex', alignItems: 'center', justifyContent: 'center', color: txTypeColor(tx.type, 'fg'), fontSize: 11, fontWeight: 700 }}>
                    {txIcon(tx.type)}
                  </div>
                  <div>
                    <div style={{ fontSize: 13 }}><span style={{ fontWeight: 500 }}>{tx.type}</span> <span style={{ color: 'var(--muted)' }}>· {tx.sym}</span></div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{tx.plat} · {tx.d}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {tx.type === 'DEPOSIT' ? fmtTHB(tx.qty) : tx.type === 'DIV' ? fmtUSD(tx.priceUSD) : `${tx.qty} × ${fmtUSD(tx.priceUSD, { dp: tx.priceUSD < 10 ? 3 : 2 })}`}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>FX {tx.fx}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="widget" style={{ padding: '20px 22px' }}>
            <WidgetHeader title="Data sources" sub="Sync & import" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
              <SourceRow name="Binance" sub="API · read-only key" status="connected" detail="Last sync: 2m ago" />
              <SourceRow name="DIME email parser" sub="Monthly confirmations → mailbox" status="connected" detail="12 notes parsed" />
              <SourceRow name="Manual PDF upload" sub="Drag-drop confirmation notes" status="idle" detail="Last: 2026-04-13" />
              <SourceRow name="Gmail forward hook" sub="Auto-ingest forwarded emails" status="idle" detail="Rule configured" />
            </div>
            <div style={{ marginTop: 14, padding: 14, background: 'var(--surface-2)', borderRadius: 10, border: '1px dashed var(--border)', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              ⇡ Drop DIME confirmation PDF here
            </div>
          </div>
        </div>

      </div>
      {selected && <PriceHistoryModal position={selected} currency={currency} onClose={() => setSelected(null)} />}
    </div>
  );
}

function WidgetHeader({ title, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.1 }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 8, height: 2, background: color, borderRadius: 1 }} />
      <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{label}</span>
    </div>
  );
}

function SourceRow({ name, sub, status, detail }) {
  const color = status === 'connected' ? 'var(--up)' : 'var(--muted)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 10 }}>
      <div style={{ width: 8, height: 8, borderRadius: 4, background: color, boxShadow: status === 'connected' ? `0 0 0 3px color-mix(in oklab, ${color} 20%, transparent)` : 'none' }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{name}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{sub}</div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{detail}</div>
    </div>
  );
}

Object.assign(window, { VariationB });
