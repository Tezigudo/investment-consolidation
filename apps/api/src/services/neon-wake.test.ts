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

const MARKS = /^(7|7,37)$/;

// Pinned to the SOURCE file deliberately. apps/api/dist/ still holds the
// pre-2026-09 build with every legacy mark in it, so a glob over the workspace
// would read stale output and fail bewilderingly.
//
// Comments are stripped so a temporarily commented-out job neither fails the
// mark check nor hides a call from it. scheduler.ts has no block comments and
// no `//` inside a string literal, so a line-wise strip is exact.
const src = readFileSync(new URL('../jobs/scheduler.ts', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

/** The first argument of every `cron.schedule(...)` call, verbatim. */
function scheduleArgs(source: string): string[] {
  const args: string[] = [];
  for (const m of source.matchAll(/cron\.schedule\(\s*/g)) {
    const rest = source.slice((m.index ?? 0) + m[0].length);
    // Read the argument by SHAPE, not up to the next comma — the twice-hourly
    // expression `'7,37 * * * *'` carries a comma inside the literal.
    const quoted = rest.match(/^(['"`])[^'"`]*\1/);
    const ident = rest.match(/^[A-Za-z_$][\w$]*/);
    args.push(quoted?.[0] ?? ident?.[0] ?? (rest.split(/[,\n]/)[0] ?? rest).trim());
  }
  return args;
}

/** The cron expression an argument denotes, or null if it cannot be resolved. */
function resolveSchedule(arg: string, source: string): string | null {
  const literal = arg.match(/^(['"`])([^'"`]*)\1$/);
  if (literal) return literal[2] ?? null;
  // Prove it is a plain identifier BEFORE interpolating it into a pattern —
  // never build a RegExp out of unvalidated text.
  if (!/^[A-Za-z_$][\w$]*$/.test(arg)) return null;
  const decl = source.match(
    new RegExp(`\\b(?:const|let|var)\\s+${arg}\\s*=\\s*['"\`]([^'"\`]*)['"\`]`),
  );
  return decl?.[1] ?? null;
}

describe('scheduler cron marks', () => {
  it('resolves every cron.schedule argument to a mark', () => {
    const args = scheduleArgs(src);
    expect(args.length, 'no cron.schedule calls found — has the call shape changed?')
      .toBeGreaterThan(0);
    for (const arg of args) {
      const expr = resolveSchedule(arg, src);
      expect(
        expr,
        `cron.schedule(${arg}) does not resolve to a literal schedule — inline it `
          + 'or bind it to a const so this guard can read the minute',
      ).not.toBeNull();
      expect(
        (expr as string).trim().split(/\s+/)[0],
        `cron '${expr}' (passed as ${arg}) is off-mark and costs its own ~5 min wake`,
      ).toMatch(MARKS);
    }
  });

  it('sees every schedule() call in the file', () => {
    // A destructured `import { schedule } from 'node-cron'` would register crons
    // the extractor above never looks at, and the guard would pass vacuously.
    const unseen: string[] = [];
    for (const m of src.matchAll(/\bschedule\s*\(/g)) {
      const before = src.slice(0, m.index ?? 0);
      if (/cron\.$/.test(before)) continue;
      unseen.push(src.slice(before.lastIndexOf('\n') + 1).split('\n')[0]?.trim() ?? '');
    }
    expect(unseen, 'schedule() call(s) this guard cannot read').toEqual([]);
  });

  it('reads a schedule whose literal contains a comma', () => {
    // `'7,37 * * * *'` must not be truncated at the comma. A "just split on the
    // next comma" simplification would silently halve what this guard checks.
    expect(scheduleArgs("cron.schedule('7,37 * * * *', fn)")).toEqual(["'7,37 * * * *'"]);
    expect(resolveSchedule('FAST_CRON', src)).toBe('7,37 * * * *');
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
