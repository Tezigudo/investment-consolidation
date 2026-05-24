-- Cleanup heartbeat rows from bot_events.
--
-- Run this AFTER deploying the in-memory heartbeat cache (services/bot-events.ts).
-- With the cache in place, the dashboard reads heartbeat state from API memory,
-- not the DB. Existing heartbeat rows in the DB are dead weight.
--
-- Can be run via Neon MCP (mcp__Neon__run_sql) or any psql client once the
-- compute quota allows DB queries again (resets 2026-06-01).
--
-- Safety:
--   - ONLY deletes kind='heartbeat'. Keeps boot/halt/entry/exit/kill_switch/dry_run_signal.
--   - Wrap in a transaction; ROLLBACK if the count looks off.

BEGIN;

-- Sanity check: show what we're about to do
SELECT kind, COUNT(*) AS rows, pg_size_pretty(SUM(pg_column_size(payload))::bigint) AS payload_size
FROM bot_events
GROUP BY kind
ORDER BY rows DESC;

-- Delete every heartbeat row
DELETE FROM bot_events WHERE kind = 'heartbeat';

-- Show the result
SELECT kind, COUNT(*) AS rows
FROM bot_events
GROUP BY kind
ORDER BY rows DESC;

-- Inspect & decide: COMMIT or ROLLBACK
-- COMMIT;
-- ROLLBACK;
