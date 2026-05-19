// Bot event ingestion + status synthesis.
//
// Externally-running trading bots (currently just snapback-btc on a $4/mo
// DO droplet) POST events to /bot-event over HTTPS as they happen. We
// store them as-is and synthesize a "bot status" snapshot for the dashboard.
//
// We never poll the bot. The bot pushes. If the bot is down, push attempts
// queue in its local outbox and replay when it comes back — the dashboard
// shows "stale" or "down" based on heartbeat age.
//
// Dedup: (source, external_id) UNIQUE. The bot's outbox uses a monotonic
// id, so retries of the same event are no-ops on the API side.

import type {
  BotEventKind,
  BotEventPayload,
  BotEventRow,
  BotStatus,
} from '@consolidate/shared';
import { pool } from '../db/client.js';

const HEALTHY_THRESHOLD_S = 60;      // heartbeat fresher than 60s → green
const STALE_THRESHOLD_S = 5 * 60;    // 60s–5min → yellow; older → red

export async function insertBotEvent(p: BotEventPayload): Promise<{ inserted: boolean; id: number | null }> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO bot_events (
       source, external_id, bot_ts, received_at, kind,
       signal_id, strategy, side, qty, price_usd,
       notional_usd, equity_usd, payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING id`,
    [
      p.source,
      p.external_id,
      p.bot_ts_ms,
      Date.now(),
      p.kind,
      p.signal_id ?? null,
      p.strategy ?? null,
      p.side ?? null,
      p.qty ?? null,
      p.price_usd ?? null,
      p.notional_usd ?? null,
      p.equity_usd ?? null,
      JSON.stringify(p.payload ?? {}),
    ],
  );
  if (res.rowCount === 0) return { inserted: false, id: null };
  return { inserted: true, id: Number(res.rows[0].id) };
}

interface BotEventDbRow {
  id: string;
  source: string;
  external_id: string;
  bot_ts: string;
  received_at: string;
  kind: string;
  signal_id: string | null;
  strategy: string | null;
  side: string | null;
  qty: number | null;
  price_usd: number | null;
  notional_usd: number | null;
  equity_usd: number | null;
  payload: Record<string, unknown>;
}

function toRow(r: BotEventDbRow): BotEventRow {
  return {
    id: Number(r.id),
    source: r.source,
    external_id: r.external_id,
    bot_ts_ms: Number(r.bot_ts),
    received_at: Number(r.received_at),
    kind: r.kind as BotEventKind,
    signal_id: r.signal_id,
    strategy: r.strategy,
    side: (r.side as 'long' | 'short' | null) ?? null,
    qty: r.qty,
    price_usd: r.price_usd,
    notional_usd: r.notional_usd,
    equity_usd: r.equity_usd,
    payload: r.payload ?? {},
  };
}

export async function recentBotEvents(
  source: string,
  opts: { limit?: number; kind?: BotEventKind; since?: number } = {},
): Promise<BotEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const conditions: string[] = ['source = $1'];
  const args: (string | number)[] = [source];
  let nextArg = 2;
  if (opts.kind) {
    conditions.push(`kind = $${nextArg++}`);
    args.push(opts.kind);
  }
  if (opts.since) {
    conditions.push(`bot_ts > $${nextArg++}`);
    args.push(opts.since);
  }
  args.push(limit);
  const { rows } = await pool.query<BotEventDbRow>(
    `SELECT * FROM bot_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY bot_ts DESC
     LIMIT $${nextArg}`,
    args,
  );
  return rows.map(toRow);
}

export async function botStatus(source: string): Promise<BotStatus> {
  const now = Date.now();
  // Most recent boot event (one query)
  const { rows: bootRows } = await pool.query<BotEventDbRow>(
    `SELECT * FROM bot_events
     WHERE source = $1 AND kind = 'boot'
     ORDER BY bot_ts DESC LIMIT 1`,
    [source],
  );
  // Most recent heartbeat
  const { rows: hbRows } = await pool.query<BotEventDbRow>(
    `SELECT * FROM bot_events
     WHERE source = $1 AND kind = 'heartbeat'
     ORDER BY bot_ts DESC LIMIT 1`,
    [source],
  );
  // Most recent equity-bearing event (heartbeat OR entry OR kill_switch),
  // which carries equity_usd
  const { rows: eqRows } = await pool.query<BotEventDbRow>(
    `SELECT * FROM bot_events
     WHERE source = $1 AND equity_usd IS NOT NULL
     ORDER BY bot_ts DESC LIMIT 1`,
    [source],
  );
  // Most recent halt event since the last boot — tells us if the bot
  // is currently in HALT state (it stops responding after HALT but we
  // want the dashboard to surface why).
  const lastBootTs = bootRows[0] ? Number(bootRows[0].bot_ts) : 0;
  const { rows: haltRows } = await pool.query<BotEventDbRow>(
    `SELECT * FROM bot_events
     WHERE source = $1 AND kind IN ('halt', 'kill_switch') AND bot_ts > $2
     ORDER BY bot_ts DESC LIMIT 1`,
    [source, lastBootTs],
  );
  // Lifetime totals by kind
  const { rows: countRows } = await pool.query<{ kind: string; count: string }>(
    `SELECT kind, COUNT(*) AS count FROM bot_events
     WHERE source = $1 GROUP BY kind`,
    [source],
  );
  const counts: Record<string, number> = {};
  for (const r of countRows) counts[r.kind] = Number(r.count);

  // Recent events (mixed kinds) for the timeline.
  const recent = await recentBotEvents(source, { limit: 20 });

  const boot = bootRows[0];
  const hb = hbRows[0];
  const eq = eqRows[0];
  const halt = haltRows[0];

  const lastHeartbeatTs = hb ? Number(hb.bot_ts) : null;
  const heartbeatAgeS =
    lastHeartbeatTs != null ? Math.max(0, Math.floor((now - lastHeartbeatTs) / 1000)) : null;

  // Deploy-start equity comes from boot payload; current equity from the
  // most recent equity-bearing event.
  const bootPayload = (boot?.payload ?? {}) as Record<string, unknown>;
  const deployStartEquityUsd =
    typeof bootPayload.deploy_start_equity === 'number'
      ? (bootPayload.deploy_start_equity as number)
      : null;
  const killSwitchFraction =
    typeof bootPayload.kill_switch_fraction === 'number'
      ? (bootPayload.kill_switch_fraction as number)
      : null;
  const killSwitchLevelUsd =
    deployStartEquityUsd != null && killSwitchFraction != null
      ? deployStartEquityUsd * killSwitchFraction
      : null;
  const currentEquityUsd = eq?.equity_usd ?? null;
  const killSwitchHeadroomPct =
    currentEquityUsd != null && killSwitchLevelUsd != null && killSwitchLevelUsd > 0
      ? ((currentEquityUsd - killSwitchLevelUsd) / killSwitchLevelUsd) * 100
      : null;

  let health: BotStatus['health'];
  if (halt) {
    health = 'down';
  } else if (heartbeatAgeS == null) {
    health = 'unknown';
  } else if (heartbeatAgeS <= HEALTHY_THRESHOLD_S) {
    health = 'healthy';
  } else if (heartbeatAgeS <= STALE_THRESHOLD_S) {
    health = 'stale';
  } else {
    health = 'down';
  }

  return {
    source,
    boot: boot
      ? {
          ts: Number(boot.bot_ts),
          env: String(bootPayload.env ?? 'unknown'),
          dry_run: Boolean(bootPayload.dry_run),
          strategy_name:
            typeof bootPayload.strategy_name === 'string'
              ? (bootPayload.strategy_name as string)
              : null,
          commit:
            typeof bootPayload.commit === 'string'
              ? (bootPayload.commit as string)
              : null,
        }
      : null,
    lastHeartbeatTs,
    heartbeatAgeS,
    currentEquityUsd,
    deployStartEquityUsd,
    killSwitchLevelUsd,
    killSwitchHeadroomPct,
    health,
    isHalted: Boolean(halt),
    recentEvents: recent,
    totals: {
      entries: counts['entry'] ?? 0,
      exits: counts['exit'] ?? 0,
      dryRunSignals: counts['dry_run_signal'] ?? 0,
      killSwitchFires: counts['kill_switch'] ?? 0,
    },
  };
}
