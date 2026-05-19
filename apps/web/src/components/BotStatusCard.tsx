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
import type { BotStatus, BotEventRow } from '@consolidate/shared';

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
        <div style={{ color: 'var(--down)' }}>Failed to load bot status</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {(error as Error)?.message ?? 'no data'}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Pill color={STATUS_COLOR[data.health]} label={STATUS_LABEL[data.health]} />
          <h3 style={{ fontSize: 14, margin: 0, color: 'var(--text)' }}>
            {source}
          </h3>
          {data.boot?.dry_run && <Pill color="var(--muted)" label="DRY-RUN" small />}
          {data.isHalted && <Pill color="var(--down)" label="HALTED" small />}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          hb {fmtAge(data.heartbeatAgeS)}
        </div>
      </div>

      <Grid>
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
      </Grid>

      <Grid style={{ marginTop: 10 }}>
        <Stat label="Live entries" value={String(data.totals.entries)} />
        <Stat label="Exits" value={String(data.totals.exits)} />
        <Stat label="Dry signals" value={String(data.totals.dryRunSignals)} />
        <Stat label="Kill fires" value={String(data.totals.killSwitchFires)} />
      </Grid>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Recent events
        </div>
        {data.recentEvents.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>No events yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.recentEvents.slice(0, 8).map((ev) => (
              <div
                key={ev.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 1fr',
                  fontSize: 12,
                  color: 'var(--text)',
                  gap: 8,
                }}
              >
                <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '14px 16px',
        marginTop: 14,
      }}
    >
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
        padding: small ? '1px 6px' : '2px 8px',
        borderRadius: 12,
        fontSize: small ? 10 : 11,
        fontWeight: 600,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  );
}

function Grid({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 10,
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
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'var(--muted)' }}>{sub}</div>
      )}
    </div>
  );
}
