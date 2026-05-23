// BotStatusCard — surfaces the snapback-btc bot's state in the dashboard.
//
// The bot is a self-contained Python daemon on a $4/mo DO droplet. It POSTs
// events to /bot-event on this API as they happen (boot, heartbeat, dry-run
// signals, live entries/exits, kill-switch fires). This card just reads the
// computed snapshot from /bot-status.
//
// Health rule:
//   healthy  — heartbeat ≤ 60s old, no HALT
//   stale    — heartbeat 60s–5min old
//   down     — heartbeat > 5min old OR HALT/kill-switch fired since last boot
//   unknown  — no heartbeat ever received (bot hasn't deployed bot-side yet)

import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { BotStatus, BotEventRow, GateStatus } from '@consolidate/shared';
import { gateLabel, fmtGateValue } from '../lib/gates';

const STATUS_COLOR: Record<BotStatus['health'], string> = {
  healthy: 'var(--up, #3fb950)',
  stale: '#d4a017',
  down: 'var(--down, #f85149)',
  unknown: 'var(--muted, #8b949e)',
};

const STATUS_LABEL: Record<BotStatus['health'], string> = {
  healthy: 'ALIVE',
  stale: 'STALE',
  down: 'DOWN',
  unknown: 'NO DATA',
};

function fmtAge(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h ago`;
  return `${(seconds / 86400).toFixed(1)}d ago`;
}

function fmtUsd(v: number | null): string {
  if (v == null) return '—';
  return `$${v.toFixed(2)}`;
}

function fmtBotTs(ms: number): string {
  // Bangkok-local for the user. GMT+7 is the bot console default too.
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'Asia/Bangkok',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function eventSummary(ev: BotEventRow): string {
  switch (ev.kind) {
    case 'boot':
      return `boot · ${(ev.payload?.env as string | undefined) ?? '?'}${ev.payload?.dry_run ? ' · DRY-RUN' : ''}`;
    case 'heartbeat':
      return `heartbeat${ev.equity_usd != null ? ` · eq $${ev.equity_usd.toFixed(2)}` : ''}`;
    case 'dry_run_signal':
      return `dry signal ${ev.side ?? '?'} @ ${ev.price_usd?.toFixed(0) ?? '?'} (would-trade)`;
    case 'entry':
      return `${ev.side ?? '?'} entry ${ev.qty?.toFixed(4) ?? '?'} @ ${ev.price_usd?.toFixed(0) ?? '?'}`;
    case 'exit':
      return `exit · ${(ev.payload?.reason as string | undefined) ?? '?'}`;
    case 'kill_switch':
      return 'KILL SWITCH fired';
    case 'halt':
      return 'HALT';
    case 'boot_flatten':
      return 'boot-flatten (stale position)';
    case 'order_failed':
      return `order failed: ${(ev.payload?.message as string | undefined) ?? 'unknown'}`;
    case 'signal_skipped':
      return `signal skipped: ${(ev.payload?.reason as string | undefined) ?? '?'}`;
  }
}

interface Props {
  source?: string;
}

export function BotStatusCard({ source = 'snapback-btc' }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['bot-status', source],
    queryFn: () => api.botStatus(source),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  if (isLoading) {
    return <Shell><div style={{ color: 'var(--muted)' }}>Loading bot status…</div></Shell>;
  }
  if (error || !data) {
    return (
      <Shell>
        <Header source={source} data={null} />
        <div style={{ color: 'var(--down)', fontSize: 13, marginTop: 6 }}>
          Failed to load bot status
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
          {(error as Error)?.message ?? 'no data'}
        </div>
      </Shell>
    );
  }

  // Empty state: dashboard is mounted but the bot has never pushed an event.
  // Hide the empty 8-stat grid; show a hint of what's coming instead.
  const hasAnyData = data.boot != null || data.recentEvents.length > 0;
  if (!hasAnyData) {
    return (
      <Shell>
        <Header source={source} data={data} />
        <div style={{
          marginTop: 12, padding: '14px 16px',
          background: 'var(--surface-2, rgba(255,255,255,0.02))',
          border: '1px dashed var(--border)',
          borderRadius: 8, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5,
        }}>
          Waiting for the first event from <code style={{ fontFamily: 'var(--mono)' }}>{source}</code>.
          Status will populate once the bot's <code style={{ fontFamily: 'var(--mono)' }}>.env</code> has
          {' '}<code style={{ fontFamily: 'var(--mono)' }}>CONSOLIDATE_API_URL</code> and
          {' '}<code style={{ fontFamily: 'var(--mono)' }}>CONSOLIDATE_API_TOKEN</code> set,
          and the bot restarts.
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Header source={source} data={data} />

      <Grid style={{ marginTop: 14 }}>
        <Stat label="Strategy" value={data.boot?.strategy_name ?? '—'} />
        <Stat label="Env" value={data.boot?.env ?? '—'} />
        <Stat label="Equity" value={fmtUsd(data.currentEquityUsd)} />
        <Stat
          label="Kill switch"
          value={fmtUsd(data.killSwitchLevelUsd)}
          sub={
            data.killSwitchHeadroomPct != null
              ? `${data.killSwitchHeadroomPct >= 0 ? '+' : ''}${data.killSwitchHeadroomPct.toFixed(1)}% headroom`
              : undefined
          }
        />
        <Stat label="Live entries" value={String(data.totals.entries)} />
        <Stat label="Exits" value={String(data.totals.exits)} />
        <Stat label="Dry signals" value={String(data.totals.dryRunSignals)} />
        <Stat label="Kill fires" value={String(data.totals.killSwitchFires)} />
      </Grid>

      {data.gates && <GatesPanel gates={data.gates} />}

      <div style={{ marginTop: 18 }}>
        <div style={{
          fontSize: 11, color: 'var(--muted)',
          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
        }}>
          Recent events
        </div>
        {data.recentEvents.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>No events yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.recentEvents.slice(0, 8).map((ev) => (
              <div
                key={ev.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '130px 1fr',
                  fontSize: 12.5, color: 'var(--text)', gap: 12,
                  paddingBottom: 4, borderBottom: '1px solid var(--border)',
                }}
              >
                <span style={{
                  color: 'var(--muted)',
                  fontFamily: 'var(--mono)',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {fmtBotTs(ev.bot_ts_ms)}
                </span>
                <span>{eventSummary(ev)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Header({ source, data }: { source: string; data: BotStatus | null }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Pill color={STATUS_COLOR[data?.health ?? 'unknown']}
              label={STATUS_LABEL[data?.health ?? 'unknown']} />
        <h3 style={{ fontSize: 15, margin: 0, fontWeight: 600, color: 'var(--text)' }}>
          {source}
        </h3>
        {data?.boot?.dry_run && <Pill color="var(--muted)" label="DRY-RUN" small />}
        {data?.isHalted && <Pill color="var(--down)" label="HALTED" small />}
      </div>
      {data && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          heartbeat {fmtAge(data.heartbeatAgeS)}
        </div>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  // Match the project's other widgets: .widget class + 22px 24px padding.
  return (
    <div className="widget" style={{ padding: '22px 24px', marginBottom: 16 }}>
      {children}
    </div>
  );
}

function Pill({ color, label, small }: { color: string; label: string; small?: boolean }) {
  return (
    <span
      style={{
        background: 'transparent',
        border: `1px solid ${color}`,
        color,
        padding: small ? '2px 8px' : '3px 10px',
        borderRadius: 999,
        fontSize: small ? 10 : 11,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        fontFamily: 'var(--mono, monospace)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function Grid({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  // 4 columns on wide screens, 2 on narrow — autofit prevents the empty
  // dashboard from spreading each stat 400px apart.
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: '16px 28px',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{
        fontSize: 10.5, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: 0.6,
        marginBottom: 4,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 16, fontWeight: 600, color: 'var(--text)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 1.2,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

function GatesPanel({ gates }: { gates: GateStatus }) {
  // Defensive: the bot has a single producer that always builds all four
  // fields, but if the contract ever drifts we don't want the whole card
  // to crash. Treat missing arrays/objects as empty so the panel still
  // renders (just with no rows).
  const gatesLong = gates.gates_long ?? {};
  const gatesShort = gates.gates_short ?? {};
  const missingLong = gates.missing_long ?? [];
  const missingShort = gates.missing_short ?? [];
  const values = gates.values ?? {};
  const longReady = missingLong.length === 0;
  const shortReady = missingShort.length === 0;
  const fired = gates.would_fire;
  // would_fire color: green for long, red for short. Used in both the panel
  // header and the column header so the visual story matches itself.
  const firedColor = fired === 'long' ? 'var(--up, #3fb950)' : 'var(--down, #f85149)';

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{
        fontSize: 11, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
        display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
      }}>
        <span>Signal gates</span>
        {fired ? (
          <span style={{ color: firedColor, fontWeight: 700, fontSize: 11 }}>
            FIRED: {fired.toUpperCase()}
          </span>
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'none' }}>
            {gates.waiting_for ?? (
              longReady && shortReady ? 'long+short ready' :
              longReady ? 'long-ready' :
              shortReady ? 'short-ready' :
              'waiting'
            )}
          </span>
        )}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 14,
        fontSize: 12.5,
      }}>
        <GateColumn
          title="LONG gates" gates={gatesLong} ready={longReady}
          fired={fired === 'long'} side="long" />
        <GateColumn
          title="SHORT gates" gates={gatesShort} ready={shortReady}
          fired={fired === 'short'} side="short" />
        <div>
          <div style={{
            fontSize: 10.5, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6,
          }}>
            Values
          </div>
          {Object.entries(values).map(([k, v]) => (
            <div key={k} style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 12, paddingBottom: 3,
              color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
            }}>
              <span style={{ color: 'var(--muted)' }}>{k}</span>
              <span>{fmtGateValue(k, v)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GateColumn({ title, gates, ready, fired, side }: {
  title: string;
  gates: Record<string, boolean>;
  ready: boolean;
  fired: boolean;
  side: 'long' | 'short';
}) {
  // Color logic: when this column's side is FIRING, match the panel
  // header (green for long, red for short — bullish vs bearish convention).
  // When merely "ready" but not fired, use green for both (positive signal
  // pending). When neither, muted.
  const sideColor = side === 'long' ? 'var(--up, #3fb950)' : 'var(--down, #f85149)';
  const titleColor = fired ? sideColor : ready ? 'var(--up, #3fb950)' : 'var(--muted)';
  return (
    <div>
      <div style={{
        fontSize: 10.5, color: titleColor,
        textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6,
        fontWeight: ready ? 700 : 500,
      }}>
        {title}{ready ? ' ✓' : ''}
      </div>
      {Object.entries(gates).map(([k, ok]) => (
        <div key={k} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12, paddingBottom: 3,
        }}>
          <span style={{
            width: 14, height: 14, borderRadius: 3,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: '#fff',
            background: ok ? 'var(--up, #3fb950)' : 'var(--down, #f85149)',
            flexShrink: 0,
          }}>{ok ? '✓' : '✗'}</span>
          <span style={{
            color: ok ? 'var(--text)' : 'var(--muted)',
            fontSize: 12,
          }}>{gateLabel(k)}</span>
        </div>
      ))}
    </div>
  );
}
