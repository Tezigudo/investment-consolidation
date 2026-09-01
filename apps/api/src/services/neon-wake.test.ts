// Every scheduled write must ride one of two wakes an hour.
//
// Neon suspends a compute after ~5 min idle, so each DISTINCT minute-mark costs
// ~5 min of active time regardless of how long the job runs. Until 2026-09 the
// crons were spread over :00, :07, :15, :17, :37 and each leg's hourly heartbeat
// snapshot landed on an arbitrary minute of its own. August burned 427 h, the
// free-tier quota was exhausted on 31 Aug, and every DB-backed route returned
// 500 (Postgres 53000) for days.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { onCronWake } from './bot-events.js';

const AT = (m: number) => Date.UTC(2026, 8, 1, 12, m, 0);

describe('onCronWake — heartbeat snapshots ride the cron wake', () => {
  it('persists inside the :07 and :37 windows', () => {
    for (const m of [7, 9, 11, 37, 39, 41]) expect(onCronWake(AT(m))).toBe(true);
  });

  it('refuses every other minute — those would be a wake of their own', () => {
    for (const m of [0, 6, 12, 15, 17, 30, 36, 42, 59]) {
      expect(onCronWake(AT(m))).toBe(false);
    }
  });

  it('is UTC-derived, matching the cron marks', () => {
    // 12:07 UTC is inside; the same wall-clock minute in another hour also is.
    expect(onCronWake(Date.UTC(2026, 8, 1, 0, 8, 0))).toBe(true);
    expect(onCronWake(Date.UTC(2026, 8, 1, 23, 8, 0))).toBe(true);
  });
});

describe('scheduler cron marks', () => {
  const src = readFileSync(
    new URL('../jobs/scheduler.ts', import.meta.url), 'utf8');

  it('declares no cron on a minute other than :07/:37', () => {
    // Inline expressions only — the named constants are asserted below.
    const inline = [...src.matchAll(/cron\.schedule\('([^']+)'/g)].map((m) => m[1]);
    for (const expr of inline) {
      const minute = expr.split(' ')[0];
      expect(minute, `cron '${expr}' is off-mark and costs its own ~5 min wake`)
        .toMatch(/^(7|7,37)$/);
    }
  });

  it('pins the three shared cron constants to the marks', () => {
    expect(src).toContain("const FAST_CRON = '7,37 * * * *';");
    expect(src).toContain("const HOURLY_CRON = '7 * * * *';");
    expect(src).toContain("const SIX_HOURLY_CRON = '7 */6 * * *';");
  });

  it('leaves no unaligned legacy schedules behind', () => {
    for (const bad of ["'0 * * * *'", "'15 * * * *'", "'17 * * * *'",
                       "'30 2 * * *'", "'0 */6 * * *'"]) {
      expect(src).not.toContain(`cron.schedule(${bad}`);
    }
  });
});
