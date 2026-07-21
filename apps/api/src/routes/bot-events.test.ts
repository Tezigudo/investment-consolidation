/**
 * Unit tests for the bot-events POST_KIND validator and the migration SQL.
 *
 * These tests run without a live database — they validate the Zod schema
 * (which is the runtime gate that caused the poison-pill 400) and assert
 * that the migration SQL contains the full expected kind set.
 */

import { describe, it, expect } from 'vitest';
import { PG_MIGRATIONS } from '../db/pg-migrations.js';
import { POST_KIND } from './bot-events.js';

// ---------------------------------------------------------------------------
// POST_KIND validator
// ---------------------------------------------------------------------------

describe('POST_KIND validator', () => {
  // All kinds the bot can enqueue_bot_event() — the full reconciled set.
  const BOT_EMITTED_KINDS = [
    'boot',
    'boot_flatten',
    'heartbeat',
    'kill_switch',
    'halt',
    'exit',
    'dry_run_signal',
    'entry',
    'daily_loss_breaker',
  ] as const;

  it('accepts every kind the bot can emit', () => {
    for (const kind of BOT_EMITTED_KINDS) {
      const result = POST_KIND.safeParse(kind);
      expect(result.success, `POST_KIND rejects '${kind}' — would cause a batch 400`).toBe(true);
    }
  });

  it('accepts daily_loss_breaker specifically (the poison-pill kind)', () => {
    const result = POST_KIND.safeParse('daily_loss_breaker');
    expect(result.success).toBe(true);
    expect(result.data).toBe('daily_loss_breaker');
  });

  it('rejects heartbeat_snapshot (API-internal kind — bot must not POST it)', () => {
    const result = POST_KIND.safeParse('heartbeat_snapshot');
    expect(result.success).toBe(false);
  });

  it('rejects unknown kinds', () => {
    for (const kind of ['unknown_kind', '', 'BOOT', 'Heartbeat']) {
      expect(POST_KIND.safeParse(kind).success, `'${kind}' should be rejected`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 16 — bot_events_kind_add_daily_loss_breaker
// ---------------------------------------------------------------------------

describe('migration 16 — bot_events_kind_add_daily_loss_breaker', () => {
  const MIGRATION_NAME = 'bot_events_kind_add_daily_loss_breaker';

  it('exists in PG_MIGRATIONS with version 16', () => {
    const m = PG_MIGRATIONS.find((x) => x.version === 16);
    expect(m).toBeDefined();
    expect(m?.name).toBe(MIGRATION_NAME);
  });

  it('comes after migration 15 (futures_analytics) in array order', () => {
    const idx14 = PG_MIGRATIONS.findIndex((x) => x.version === 14);
    const idx15 = PG_MIGRATIONS.findIndex((x) => x.version === 15);
    const idx16 = PG_MIGRATIONS.findIndex((x) => x.version === 16);
    expect(idx16).toBeGreaterThan(idx15);
    expect(idx15).toBeGreaterThan(idx14);
  });

  it('migration SQL drops the old constraint before adding the new one', () => {
    const m = PG_MIGRATIONS.find((x) => x.version === 16)!;
    expect(m.up).toContain('DROP CONSTRAINT IF EXISTS bot_events_kind_check');
    expect(m.up).toContain('ADD CONSTRAINT bot_events_kind_check');
  });

  it('migration SQL includes daily_loss_breaker in the CHECK set', () => {
    const m = PG_MIGRATIONS.find((x) => x.version === 16)!;
    expect(m.up).toContain("'daily_loss_breaker'");
  });

  it('migration SQL includes all previously allowed kinds (no regression)', () => {
    const m = PG_MIGRATIONS.find((x) => x.version === 16)!;
    // Every kind that was valid after migration 14 must remain valid after 16.
    const expectedKinds = [
      'boot', 'heartbeat', 'heartbeat_snapshot', 'dry_run_signal',
      'entry', 'exit', 'kill_switch', 'halt', 'boot_flatten',
      'order_failed', 'signal_skipped',
    ];
    for (const kind of expectedKinds) {
      expect(m.up, `migration 16 SQL is missing previously-valid kind '${kind}'`)
        .toContain(`'${kind}'`);
    }
  });

  it('migration SQL is idempotent via IF EXISTS on DROP', () => {
    const m = PG_MIGRATIONS.find((x) => x.version === 16)!;
    // IF EXISTS means a second run of the DROP is safe (won't error if
    // constraint was already removed by a prior partial run).
    expect(m.up).toContain('IF EXISTS');
  });
});
