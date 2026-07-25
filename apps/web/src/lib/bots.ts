// Canonical list of bot sources that push events to the API.
// Used by both desktop (Dashboard.tsx) and mobile (Overview.tsx) so the two
// views can't drift when bots are added/removed.
//
// The string must match what the bot sends via `consolidate_push.py` (env
// `CONSOLIDATE_SOURCE`). Current legs:
//   - v1            → default 'snapback-btc'
//   - Donchian-v3   → 'snapback-btc-donchian'
//   - CnH HYBRID-short → 'snapback-btc-cnh-short'   (never funded/keyed; no events)
//   - SOL Supertrend → 'snapback-sol-supertrend'    (deployed 2026-07-25)
//
// NOTE: the API does NOT validate this value — `apps/api/src/routes/bot-events.ts`
// takes `source: z.string().min(1).max(64)`. So a leg missing from this list is
// still ingested and stored; it is just invisible in the UI, because Dashboard
// and mobile Overview render by mapping over BOT_SOURCES. Add a leg here the
// same day it starts pushing, or its telemetry silently goes nowhere on screen.

export type BotSource =
  | 'snapback-btc'
  | 'snapback-btc-donchian'
  | 'snapback-btc-cnh-short'
  | 'snapback-sol-supertrend';

export const BOT_SOURCES: readonly BotSource[] = [
  'snapback-btc',
  'snapback-btc-donchian',
  'snapback-btc-cnh-short',
  'snapback-sol-supertrend',
] as const;
