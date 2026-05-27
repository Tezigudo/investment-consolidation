// Canonical list of bot sources that push events to the API.
// Used by both desktop (Dashboard.tsx) and mobile (Overview.tsx) so the two
// views can't drift when bots are added/removed.
//
// The string must match what the bot sends via `consolidate_push.py` (env
// `CONSOLIDATE_SOURCE`). Current legs:
//   - v1            → default 'snapback-btc'
//   - Donchian-v3   → 'snapback-btc-donchian'
//   - CnH HYBRID-short → 'snapback-btc-cnh-short'

export type BotSource =
  | 'snapback-btc'
  | 'snapback-btc-donchian'
  | 'snapback-btc-cnh-short';

export const BOT_SOURCES: readonly BotSource[] = [
  'snapback-btc',
  'snapback-btc-donchian',
  'snapback-btc-cnh-short',
] as const;
