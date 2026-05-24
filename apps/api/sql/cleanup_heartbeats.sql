-- Cleanup LEGACY heartbeat rows from bot_events.
--
-- Run this AFTER deploying the in-memory heartbeat cache (services/bot-events.ts).
-- With the cache in place, the dashboard reads heartbeat state from API memory,
-- not the DB. Pre-cache rows with kind='heartbeat' are dead weight.
--
-- IMPORTANT: only purges kind='heartbeat' (the legacy 30s-cadence rows the
-- bot used to push). The new code stores the hourly equity-history rows as
-- kind='heartbeat_snapshot' — those are preserved. Keeps every other kind
-- intact: boot, entry, exit, halt, kill_switch, dry_run_signal, etc.
--
-- Can be run via Neon MCP (mcp__Neon__run_sql) or any psql client once the
-- compute quota allows DB queries again (resets 2026-06-01).
--
-- Safety: wrapped in a transaction; ROLLBACK if the count looks off.

BEGIN;

-- Sanity check: show what we're about to do
SELECT kind, COUNT(*) AS rows, pg_size_pretty(SUM(pg_column_size(payload))::bigint) AS payload_size
FROM bot_events
GROUP BY kind
ORDER BY rows DESC;

-- Delete every LEGACY heartbeat row (kind='heartbeat'). New code writes
-- hourly snapshots as kind='heartbeat_snapshot' — those stay intact.
DELETE FROM bot_events WHERE kind = 'heartbeat';

-- Show the result — should show heartbeat=0 (or absent) and heartbeat_snapshot
-- preserved at whatever it was before.
SELECT kind, COUNT(*) AS rows
FROM bot_events
GROUP BY kind
ORDER BY rows DESC;

-- Inspect & decide: COMMIT or ROLLBACK
-- COMMIT;
-- ROLLBACK;
