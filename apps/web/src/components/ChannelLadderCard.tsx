// ChannelLadderCard — "where does the trailing exit sit" for the donchian leg.
//
// The donchian-v3 leg places entry + SL and NO take-profit: it exits when a
// closed 4h bar closes beyond the 10-bar Donchian channel. So the dashboard has
// no TP price to show, and the honest substitute is this ladder — the level in
// force now, and where it ratchets next.
//
// THREE THINGS THE CARD MUST NOT LET THE READER MISBELIEVE
//  1. Only the first rung is fact. The rest assume price holds near the mark;
//     they are labelled as a projection, not a schedule of known levels.
//  2. Exiting AT the level is a best case. The exit fires on the first close
//     BEYOND it and fills at that close — which can be well past the level.
//  3. The channel is checked at bar close; the resting stop triggers intrabar.
//     A flush hits the stop, not the level here, even once the level is past it.
//
// Renders nothing at all when no channel-exit leg is open, which is the normal
// state ~95% of the time (the leg trades ~32×/yr, median hold under 2 days).

import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ChannelLadderState, ChannelLadderRow } from '@consolidate/shared';

const UP = 'var(--up, #3fb950)';
const DOWN = 'var(--down, #f85149)';
const MUTED = 'var(--muted, #8b949e)';

function usd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// Bangkok-local, matching every other bot-facing timestamp in the app.
function fmtBar(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'Asia/Bangkok', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// The first rung that flips each milestone gets the note — later rungs inherit
// the state and would just repeat it.
function milestones(rows: ChannelLadderRow[]): Map<number, string> {
  const out = new Map<number, string>();
  const sl = rows.findIndex((r) => r.clearsSl);
  const en = rows.findIndex((r) => r.crossesEntry);
  if (sl >= 0) out.set(sl, 'clears the stop');
  if (en >= 0) out.set(en, en === sl ? 'clears stop + entry' : 'past entry — no longer a loss');
  return out;
}

export function ChannelLadderCard({ privacy }: { privacy: boolean }) {
  const { data } = useQuery<ChannelLadderState>({
    queryKey: ['donchian-ladder'],
    queryFn: () => api.donchianLadder(),
    refetchInterval: 60_000,
  });

  if (!data?.available || !data.ladder) return null;
  const l = data.ladder;
  const marks = milestones(l.rows);
  const dirWord = l.side === 'long' ? 'below' : 'above';

  return (
    <div style={{ border: '1px solid var(--border, #30363d)', borderRadius: 8, padding: 16, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            Trailing exit ladder · {data.source?.replace('snapback-btc-', '') ?? 'donchian'}
          </div>
          <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>
            No TP order exists. The {l.side} closes on the first 4h close {dirWord}{' '}
            the {l.period}-bar Donchian level.
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 20, fontWeight: 600, color: l.side === 'long' ? UP : DOWN }}>
            {privacy ? '•••' : usd(l.nextLevelUsd)}
          </div>
          <div style={{ color: MUTED, fontSize: 11 }}>level in force next bar</div>
        </div>
      </div>

      <div style={{ color: MUTED, fontSize: 11, margin: '10px 0 6px' }}>
        mark {usd(l.markUsd)} · entry {usd(l.entryPriceUsd)} · stop {usd(l.slPriceUsd)}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['Bar closes (ICT)', 'Exit level', 'vs mark', ''].map((h) => (
                <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: MUTED, fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {l.rows.map((r, i) => (
              <tr key={r.barCloseMs} style={{ borderTop: '1px solid var(--border, #30363d)', opacity: r.projected ? 0.72 : 1 }}>
                <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                  {fmtBar(r.barCloseMs)}
                  {!r.projected && <span style={{ color: MUTED }}> · now</span>}
                </td>
                <td style={{ padding: '4px 8px', fontWeight: r.projected ? 400 : 600 }}>
                  {privacy ? '•••' : usd(r.exitLevelUsd)}
                </td>
                <td style={{ padding: '4px 8px', color: MUTED }}>{r.vsMarkPct.toFixed(1)}%</td>
                <td style={{ padding: '4px 8px', color: r.crossesEntry ? UP : MUTED, whiteSpace: 'nowrap' }}>
                  {marks.get(i) ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ color: MUTED, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
        Row 1 is fixed by bars that already closed. The rest assume every future bar
        closes near {usd(l.assumedCloseUsd)} — a projection, not a schedule. While the
        position stays open the level can only move toward price, never away.
        Exiting <i>at</i> a level is the best case: the trade closes on the first close
        beyond it, and fills at that close. The stop at {usd(l.slPriceUsd)} triggers
        intrabar, so a fast move exits there instead.
      </div>
    </div>
  );
}
