// Shared "stable-coin" definitions for the Binance integration.
//
// Single source of truth: previously the same Set was redefined in
// binance.ts, binance-import.ts, and a hand-rolled OR chain in
// price-history.ts. Adding/removing a stable now happens in one place.

export const STABLES = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP']);

export function isStable(asset: string): boolean {
  return STABLES.has(asset);
}

// Quotes we probe for spot trades. Order matters for parseSymbolBaseQuote:
// the first candidate that suffix-matches a symbol wins.
export const QUOTE_CANDIDATES = ['USDT', 'BUSD', 'FDUSD', 'USDC', 'BTC', 'ETH', 'BNB', 'TUSD'];
