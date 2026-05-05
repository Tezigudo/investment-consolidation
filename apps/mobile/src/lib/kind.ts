import type { Platform } from '@consolidate/shared';

// Same logic as PriceModal: only DIME holdings are stocks; everything
// else (Binance, OnChain crypto) lives in Binance kline-land. Bank cash
// has no chart so the caller should skip the modal entirely.
export function priceKind(platform: Platform): 'stock' | 'crypto' {
  return platform === 'DIME' ? 'stock' : 'crypto';
}
