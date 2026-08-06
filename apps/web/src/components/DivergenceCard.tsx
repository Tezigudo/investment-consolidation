// DivergenceCard — RSI divergence across 4h / 1D / 1W for BTC.
//
// CONTEXT, NOT A SIGNAL. This is a port of TradingView's built-in Divergence
// Indicator, measured on BTC 2019-2026 and found to have NO tradable edge:
// best z = +1.80 on n=6 against a 1.96 threshold, and every timeframe shows
// hit-rate marginally above the base rate while AVERAGE RETURN IS NEGATIVE
// (right slightly more often, more expensive when wrong).
//
// It earns its place as situational awareness — "BTC is stretched on the
// daily" — not as a reason to trade. The card says so on its face, on purpose:
// an unlabelled indicator on a money dashboard invites exactly the mistake the
// measurement rules out. Signal rates are ~28/yr on 4h, ~6/yr on 1D, ~1/yr on 1W,
// so "none in window" is the normal resting state, not a fault.

import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { DivergenceFrame } from '@consolidate/shared';

const BULL = 'var(--up, #3fb950)';
const BEAR = 'var(--down, #f85149)';
const MUTED = 'var(--muted, #8b949e)';

function rsiTone(rsi: number | null): string {
  if (rsi == null) return MUTED;
  if (rsi <= 30) return BULL;      // oversold
  if (rsi >= 70) return BEAR;      // overbought
  return 'inherit';
}

function fmtAgo(barsAgo: number | null, tf: string): string {
  if (barsAgo == null) return '';
  if (barsAgo === 0) return 'this bar';
  const unit = tf === '4h' ? 'bar' : tf === '1D' ? 'day' : 'wk';
  return `${barsAgo} ${unit}${barsAgo === 1 ? '' : 's'} ago`;
}

function FrameRow({ f }: { f: DivergenceFrame }) {
  const last = f.last;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '3rem 4.5rem 1fr',
        alignItems: 'baseline',
        gap: '0.5rem',
        padding: '0.35rem 0',
        borderTop: '1px solid var(--border, #30363d)',
      }}
    >
      <span style={{ fontWeight: 600 }}>{f.tf}</span>
      <span style={{ color: rsiTone(f.rsi), fontVariantNumeric: 'tabular-nums' }}>
        RSI {f.rsi ?? '—'}
      </span>
      {last ? (
        <span style={{ color: last.kind === 'bull' ? BULL : BEAR, fontSize: '0.85em' }}>
          {last.kind === 'bull' ? '▲ Bull' : '▼ Bear'}
          <span style={{ color: MUTED }}>
            {' '}@ RSI {last.rsi} · {fmtAgo(last.barsAgo, f.tf)}
          </span>
        </span>
      ) : (
        <span style={{ color: MUTED, fontSize: '0.85em' }}>none in window</span>
      )}
    </div>
  );
}

export function DivergenceCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['divergence'],
    queryFn: () => api.divergence(),
    // Server caches 5 min; weekly candles move once a week. Don't hammer it.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  return (
    // Same .widget shell + padding as BotStatusCard so this reads as part of
    // the dashboard rather than a bolt-on. marginBottom is supplied by the
    // wrapper in Dashboard.tsx.
    <section className="widget" style={{ padding: '22px 24px' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: '0.5rem',
          marginBottom: '0.25rem',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>
          BTC RSI Divergence
        </h3>
        <span
          title="Measured on BTC 2019-2026: no tradable edge (best z=+1.80, n=6). Shown for situational awareness only."
          style={{
            color: MUTED,
            fontSize: '0.7rem',
            border: `1px solid ${MUTED}`,
            borderRadius: 4,
            padding: '0 0.35rem',
            whiteSpace: 'nowrap',
          }}
        >
          CONTEXT — NOT A SIGNAL
        </span>
      </header>

      {isLoading && <div style={{ color: MUTED, fontSize: '0.85em' }}>loading…</div>}
      {isError && (
        <div style={{ color: BEAR, fontSize: '0.85em' }}>divergence unavailable</div>
      )}
      {data?.frames.map((f) => <FrameRow key={f.tf} f={f} />)}
    </section>
  );
}
