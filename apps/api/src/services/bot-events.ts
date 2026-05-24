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
  GateStatus,
} from '@consolidate/shared';
import { pool } from '../db/client.js';

const HEALTHY_THRESHOLD_S = 60;      // heartbeat fresher than 60s → green
const STALE_THRESHOLD_S = 5 * 60;    // 60s–5min → yellow; older → red

// Heartbeats are LIVE STATE not history — store in-memory, not Postgres.
// The bot pushes a heartbeat every 30s; at 2 bots that's 172.8K inserts/month
// on Neon, blowing the compute-time quota. Keeping them in-memory drops DB
// writes by 99.9% while preserving every dashboard feature (lastHeartbeatTs,
// equity, gates) — those just read from this map instead of the DB.
//
// One snapshot per hour is still persisted (HEARTBEAT_SNAPSHOT_INTERVAL_MS)
// so we keep coarse equity history for charts.
//
// Tradeoff: on API restart the map is empty until the next heartbeat (~30s).
// Until then the dashboard shows the same "no heartbeat yet" state it does
// for a brand-new bot. That's the existing cold-start behavior — no new bug.
interface HeartbeatState {
  botTs: number;            // ms (bot's clock)
  receivedAt: number;       // ms (server's clock)
  equityUsd: number | null;
  gates: GateStatus | null;
  lastPersistedTs: number;  // ms, last time we INSERTed a snapshot to DB
}
const heartbeatCache = new Map<string, HeartbeatState>();
const HEARTBEAT_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour

// Returns a valid GateStatus only if every field the UI walks (gates_long,
// gates_short, missing_long, missing_short, values) is present with the
// expected shape. A partial / drifted payload becomes null so the dashboard
// hides the panel rather than crashing on .length or Object.entries.
function extractGates(raw: unknown): GateStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  const isStrBoolMap = (v: unknown): v is Record<string, boolean> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'boolean');
  const isStrArr = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (typeof g.strategy !== 'string') return null;
  if (!isStrBoolMap(g.gates_long)) return null;
  if (!isStrBoolMap(g.gates_short)) return null;
  if (!isStrArr(g.missing_long)) return null;
  if (!isStrArr(g.missing_short)) return null;
  if (g.values && (typeof g.values !== 'object' || Array.isArray(g.values))) return null;
  return g as unknown as GateStatus;
}

export async function insertBotEvent(p: BotEventPayload): Promise<{ inserted: boolean; id: number | null }> {
  // Heartbeats: update in-memory cache. Persist one snapshot/hour for history.
  if (p.kind === 'heartbeat') {
    const cur = heartbeatCache.get(p.source);
    const payloadGates = (p.payload as Record<string, unknown> | undefined)?.gates;
    heartbeatCache.set(p.source, {
      botTs: p.bot_ts_ms,
      receivedAt: Date.now(),
      equityUsd: p.equity_usd ?? cur?.equityUsd ?? null,
      gates: extractGates(payloadGates) ?? cur?.gates ?? null,
      lastPersistedTs: cur?.lastPersistedTs ?? 0,
    });
    // Persist one heartbeat per hour as a snapshot — gives coarse equity
    // history for the dashboard's longer-range charts without exploding the
    // table again.
    const now = Date.now();
    const lastPersisted = cur?.lastPersistedTs ?? 0;
    if (now - lastPersisted < HEARTBEAT_SNAPSHOT_INTERVAL_MS) {
      // Outbox semantics: caller sees inserted=true so its cursor advances.
      // We return id=null because nothing was actually written.
      return { inserted: true, id: null };
    }
    // Otherwise fall through to the INSERT below. Update lastPersistedTs
    // first so concurrent heartbeats don't double-insert in the race window.
    heartbeatCache.set(p.source, {
      ...heartbeatCache.get(p.source)!,
      lastPersistedTs: now,
    });
    // Tag the persisted row as 'heartbeat_snapshot' (distinct from the bot's
    // wire kind 'heartbeat') so cleanup scripts can safely DELETE WHERE
    // kind='heartbeat' to purge legacy dead rows without nuking the new
    // hourly snapshots. The recentEvents feed also filters this kind out so
    // the dashboard's activity panel stays focused on real events.
    p = { ...p, kind: 'heartbeat_snapshot' };
  }
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
  } else {
    // Default feed excludes the hourly equity snapshots — those are stored
    // for charting only, not user-facing activity. Explicit kind override
    // (e.g. `kind: 'heartbeat_snapshot'`) still works for callers that want
    // them.
    conditions.push(`kind <> 'heartbeat_snapshot'`);
  }
  // Explicit null/undefined check — since=0 is a valid "give me everything
  // from epoch onward" timestamp (Sourcery flagged the falsy-guard bug).
  if (opts.since != null) {
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
  // Heartbeat fields (lastTs, equity, gates) come from the in-memory cache —
  // see heartbeatCache above. No DB query needed for live state. The DB is
  // only queried for events that have actual history: boot, halt, equity
  // snapshots (hourly heartbeat snapshot OR entry/exit), counts, recent events.
  const hb = heartbeatCache.get(source);

  // Parallelize the independent first-pass queries.
  const [
    { rows: bootRows },
    { rows: eqRows },
    { rows: countRows },
    recent,
  ] = await Promise.all([
    pool.query<BotEventDbRow>(
      `SELECT * FROM bot_events
       WHERE source = $1 AND kind = 'boot'
       ORDER BY bot_ts DESC LIMIT 1`,
      [source],
    ),
    pool.query<BotEventDbRow>(
      `SELECT * FROM bot_events
       WHERE source = $1 AND equity_usd IS NOT NULL
       ORDER BY bot_ts DESC LIMIT 1`,
      [source],
    ),
    pool.query<{ kind: string; count: string }>(
      `SELECT kind, COUNT(*) AS count FROM bot_events
       WHERE source = $1 GROUP BY kind`,
      [source],
    ),
    recentBotEvents(source, { limit: 20 }),
  ]);

  // Halt query depends on last-boot ts, so it runs after the first wave.
  const lastBootTs = bootRows[0] ? Number(bootRows[0].bot_ts) : 0;
  const { rows: haltRows } = await pool.query<BotEventDbRow>(
    `SELECT * FROM bot_events
     WHERE source = $1 AND kind IN ('halt', 'kill_switch') AND bot_ts > $2
     ORDER BY bot_ts DESC LIMIT 1`,
    [source, lastBootTs],
  );

  const counts: Record<string, number> = {};
  for (const r of countRows) counts[r.kind] = Number(r.count);

  const boot = bootRows[0];
  const eq = eqRows[0];
  const halt = haltRows[0];

  // Live heartbeat state comes from the in-memory cache. Fall back to null
  // if the cache is cold (e.g. just after API restart) — same UX as a brand-
  // new bot until the next heartbeat lands.
  const lastHeartbeatTs = hb?.botTs ?? null;
  const heartbeatAgeS =
    lastHeartbeatTs != null ? Math.max(0, Math.floor((now - lastHeartbeatTs) / 1000)) : null;

  // Deploy-start equity comes from boot payload; current equity prefers the
  // live heartbeat (always fresh) over the last persisted equity event.
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
  const currentEquityUsd = hb?.equityUsd ?? eq?.equity_usd ?? null;
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

  // Gates: pulled from the in-memory heartbeat cache (extracted+validated by
  // extractGates at write time). Always consistent with lastHeartbeatTs since
  // they come from the same cache entry.
  const gates = hb?.gates ?? null;

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
    gates,
    totals: {
      entries: counts['entry'] ?? 0,
      exits: counts['exit'] ?? 0,
      dryRunSignals: counts['dry_run_signal'] ?? 0,
      killSwitchFires: counts['kill_switch'] ?? 0,
    },
  };
}
