// Canonical list of bot sources that push events to the API.
// Used by both desktop (Dashboard.tsx) and mobile (Overview.tsx) so the two
// views can't drift when bots are added/removed.
//
// The string must match what the bot sends via `consolidate_push.py` (env
// `CONSOLIDATE_SOURCE`). Current legs:
//   - v1            → default 'snapback-btc'
//   - Donchian-v3   → 'snapback-btc-donchian'
//   - SOL Supertrend → 'snapback-sol-supertrend'    (deployed 2026-07-25)
//
// REMOVED 2026-07-25: 'snapback-btc-cnh-short'. That leg was never funded or
// keyed (no .env.cnh_short ever existed, its systemd unit never ran) so it
// pushed ZERO events and its card was permanently empty; the sol_supertrend leg
// took over its slot. Nothing is hidden by dropping it — verified against
// /futures/analytics?range=730, which had only ever seen 'snapback-btc'.
// Re-add it here if the leg is ever brought back.
//
// NOTE: the API does NOT validate this value — `apps/api/src/routes/bot-events.ts`
// takes `source: z.string().min(1).max(64)`. So a leg missing from this list is
// still ingested and stored; it is just invisible in the UI, because Dashboard
// and mobile Overview render by mapping over BOT_SOURCES. Add a leg here the
// same day it starts pushing, or its telemetry silently goes nowhere on screen.
// The converse also holds: removing a source here only hides its card, it never
// deletes stored events.

export type BotSource =
  | 'snapback-btc'
  | 'snapback-btc-donchian'
  | 'snapback-sol-supertrend';

export const BOT_SOURCES: readonly BotSource[] = [
  'snapback-btc',
  'snapback-btc-donchian',
  'snapback-sol-supertrend',
] as const;
