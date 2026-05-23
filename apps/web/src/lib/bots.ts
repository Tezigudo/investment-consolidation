// Canonical list of bot sources that push events to the API.
// Used by both desktop (Dashboard.tsx) and mobile (Overview.tsx) so the two
// views can't drift when bots are added/removed.
//
// The string must match what the bot sends via `consolidate_push.py` (env
// `CONSOLIDATE_SOURCE`) — currently the v1 leg uses the default 'snapback-btc'
// and the Donchian leg sets 'snapback-btc-donchian' in its systemd env.

export type BotSource = 'snapback-btc' | 'snapback-btc-donchian';

export const BOT_SOURCES: readonly BotSource[] = [
  'snapback-btc',
  'snapback-btc-donchian',
] as const;
