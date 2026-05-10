import { useMemo, useState } from 'react';
import type { Currency, Totals } from '@consolidate/shared';
import { fmtMoney } from '../lib/format';

interface Props {
  currentFX: number;
  totals: Totals;
  bankUSD: number;
  currency: Currency;
}

// Slider domain. Wide enough to cover historical USDTHB swings
// (~28 in 2013, ~38 in 2022) without being absurd. Step 0.05 keeps
// drag interaction smooth without quantisation noise.
const FX_MIN = 28;
const FX_MAX = 40;
const FX_STEP = 0.05;

// Compact "what if USDTHB → X" panel that re-prices the user's net
// worth at a hypothetical rate. Math is THB-native (an FX scenario is
// inherently a THB question — the USD value of the foreign-denominated
// portion doesn't move when only USDTHB changes), then we convert the
// shown values back to whatever currency is on the toggle.
//
//   foreignUSD     = totals.marketUSD − bankUSD            (THB cash unchanged)
//   ΔNW_THB        = (sliderFX − currentFX) × foreignUSD
//   marketPNL(S)   = pnlUSD × S                            (asset appreciation in THB)
//   fxContrib(S)   = costUSD × (S − fxLockedAvg)
//   totalPNL(S)    = marketPNL(S) + fxContrib(S)           ( = pnlTHB at S )
// Realized PNL is unaffected — already booked at sell-time FX.
export function FxScenario({ currentFX, totals, bankUSD, currency }: Props) {
  const [fx, setFx] = useState(currentFX);

  const fxLockedAvg = totals.costUSD > 0 ? totals.costTHB / totals.costUSD : currentFX;
  const foreignUSD = Math.max(0, totals.marketUSD - bankUSD);

  const scenario = useMemo(() => {
    const deltaTHB = (fx - currentFX) * foreignUSD;
    const nwTHB = totals.marketTHB + deltaTHB;
    const marketPnlTHB = totals.pnlUSD * fx;
    const fxContribTHB = totals.costUSD * (fx - fxLockedAvg);
    const totalUnrealizedTHB = marketPnlTHB + fxContribTHB;
    // Convert back to display currency. Use the *scenario* FX for the
    // currency conversion when target is USD/USDT — i.e. "if FX were S,
    // what would my USD-equivalent NW be?" That's the consistent answer.
    const div = currency === 'THB' ? 1 : fx > 0 ? fx : 1;
    return {
      deltaTHB,
      deltaDisplay: deltaTHB / div,
      nwDisplay: nwTHB / div,
      marketPnlDisplay: marketPnlTHB / div,
      fxContribDisplay: fxContribTHB / div,
      totalUnrealizedDisplay: totalUnrealizedTHB / div,
    };
  }, [fx, currentFX, foreignUSD, totals.marketTHB, totals.pnlUSD, totals.costUSD, fxLockedAvg, currency]);

  const fmt = (n: number, opts?: { sign?: boolean }) =>
    fmtMoney(n, currency, { ...opts, dp: currency === 'THB' ? 0 : 2 });

  // Position the "now" tick on the slider track so the user sees where
  // their reference point sits inside the scenario range.
  const nowPct = ((currentFX - FX_MIN) / (FX_MAX - FX_MIN)) * 100;
  const lockedPct = ((fxLockedAvg - FX_MIN) / (FX_MAX - FX_MIN)) * 100;

  const isAtNow = Math.abs(fx - currentFX) < 0.01;
  const deltaSign = scenario.deltaTHB >= 0 ? 'up' : 'down';

  return (
    <div style={{ paddingTop: 14, marginTop: 6, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4, textTransform: 'uppercase' }}>
          What if USDTHB →
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 600, color: 'var(--text)' }}>
            {fx.toFixed(2)}
          </span>
          {!isAtNow && (
            <button
              onClick={() => setFx(currentFX)}
              title="Reset to current rate"
              style={{
                fontSize: 10,
                padding: '2px 6px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--muted)',
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
              }}
            >
              reset
            </button>
          )}
        </div>
      </div>

      <div style={{ position: 'relative', padding: '4px 0 18px' }}>
        <input
          type="range"
          min={FX_MIN}
          max={FX_MAX}
          step={FX_STEP}
          value={fx}
          onChange={(e) => setFx(Number(e.target.value))}
          style={{
            width: '100%',
            accentColor: 'var(--accent)',
            cursor: 'pointer',
            margin: 0,
          }}
        />
        {/* "now" + "fxLocked avg" tick markers under the track */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 22, height: 14, pointerEvents: 'none' }}>
          <div
            style={{
              position: 'absolute',
              left: `calc(${nowPct}% - 18px)`,
              fontSize: 9,
              color: 'var(--muted)',
              fontFamily: 'var(--mono)',
              whiteSpace: 'nowrap',
            }}
          >
            ↑ now {currentFX.toFixed(2)}
          </div>
          {Math.abs(lockedPct - nowPct) > 8 && fxLockedAvg >= FX_MIN && fxLockedAvg <= FX_MAX && (
            <div
              style={{
                position: 'absolute',
                left: `calc(${lockedPct}% - 22px)`,
                fontSize: 9,
                color: 'var(--muted-2)',
                fontFamily: 'var(--mono)',
                whiteSpace: 'nowrap',
              }}
            >
              avg {fxLockedAvg.toFixed(2)}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <ScenarioStat
          label={`Net worth (${currency})`}
          value={fmt(scenario.nwDisplay)}
          delta={isAtNow ? null : `${fmt(scenario.deltaDisplay, { sign: true })} vs now`}
          tone={isAtNow ? 'neutral' : deltaSign}
        />
        <ScenarioStat
          label={`Total unrealized PNL (${currency})`}
          value={fmt(scenario.totalUnrealizedDisplay, { sign: true })}
          delta={`mkt ${fmt(scenario.marketPnlDisplay, { sign: true })} · fx ${fmt(
            scenario.fxContribDisplay,
            { sign: true },
          )}`}
          tone={scenario.totalUnrealizedDisplay >= 0 ? 'up' : 'down'}
        />
      </div>
    </div>
  );
}

function ScenarioStat({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: string;
  delta: string | null;
  tone: 'up' | 'down' | 'neutral';
}) {
  const color = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : 'var(--text)';
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 500, color }}>{value}</div>
      {delta && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
          {delta}
        </div>
      )}
    </div>
  );
}
