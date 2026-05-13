// Pure mappers from raw Binance API rows → our trades/deposits schema.
//
// These functions are intentionally side-effect-free w.r.t. the DB:
// they may call out for FX/price lookups (which themselves cache) but
// they do not write rows. Returning null/[] means "skip this row".

import type {
  RawSpotTrade,
  RawConvert,
  RawFiatPayment,
} from './binance-history.js';
import { getUSDTHBForTs } from './fx-history.js';
import { getPriceUSDTForTs } from './price-history.js';
import { isStable, QUOTE_CANDIDATES } from './binance-stables.js';

export interface TradeInsert {
  symbol: string;
  side: 'BUY' | 'SELL' | 'DIV';
  qty: number;
  price_usd: number;
  fx_at_trade: number;
  commission: number;
  ts: number;
  external_id: string;
  source: string;
}

export interface DepositInsert {
  platform: 'Binance';
  amount_thb: number;
  amount_usd: number;
  fx_locked: number;
  ts: number;
  note: string;
  source: string;
}

export type FiatPaymentMapped =
  | { kind: 'deposit'; row: DepositInsert }
  | { kind: 'trade'; row: TradeInsert };

export function parseSymbolBaseQuote(symbol: string): { base: string; quote: string } | null {
  for (const q of QUOTE_CANDIDATES) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { base: symbol.slice(0, -q.length), quote: q };
    }
  }
  return null;
}

export async function resolvePriceUSD(
  priceInQuote: number,
  quote: string,
  ts: number,
): Promise<number | null> {
  if (isStable(quote)) return priceInQuote;
  const quoteUSD = await getPriceUSDTForTs(quote, ts);
  if (quoteUSD == null) return null;
  return priceInQuote * quoteUSD;
}

// Binance's /myTrades returns `commission` denominated in `commissionAsset`,
// not in USD. The default fee currency depends on settings: BUYs pay the
// base asset (0.1%), SELLs pay the quote (0.1% of notional), and if BNB-pay
// is enabled the fee comes out in BNB at a 25% discount. cost-basis.ts
// expects commission in USD, so without conversion a BUY of 500k LUNC
// would store a "commission" of 500 (LUNC) and book a $500 phantom cost,
// inflating realized loss by ~$1k per closed position. Convert here.
export async function commissionToUSD(
  commQty: number,
  commissionAsset: string | undefined,
  base: string,
  quote: string,
  priceUSD: number,
  ts: number,
): Promise<number> {
  if (!(commQty > 0)) return 0;
  if (!commissionAsset) {
    // Old payload — assume USD-equivalent (lossy fallback, matches prior behavior).
    return commQty;
  }
  if (isStable(commissionAsset)) return commQty;
  if (commissionAsset === base) return commQty * priceUSD;
  if (commissionAsset === quote) {
    // priceUSD = priceInQuote × quoteUSD ⇒ quoteUSD = priceUSD / priceInQuote.
    // Already-stable quote was handled above; here quote is non-stable
    // (rare — e.g. BTC quote) and we re-resolve to USD via the same path.
    const quoteUSD = await getPriceUSDTForTs(commissionAsset, ts);
    return quoteUSD != null ? commQty * quoteUSD : 0;
  }
  // Third asset (typically BNB when BNB-pay is enabled).
  const feeAssetUSD = await getPriceUSDTForTs(commissionAsset, ts);
  return feeAssetUSD != null ? commQty * feeAssetUSD : 0;
}

export async function mapSpotTrade(
  t: RawSpotTrade,
  base: string,
  quote: string,
): Promise<TradeInsert | null> {
  const qty = Number(t.qty);
  const priceInQuote = Number(t.price);
  if (!(qty > 0) || !(priceInQuote > 0)) return null;
  const priceUSD = await resolvePriceUSD(priceInQuote, quote, t.time);
  if (priceUSD == null) return null;
  const fx = await getUSDTHBForTs(t.time);
  const commission = await commissionToUSD(
    Number(t.commission) || 0,
    t.commissionAsset,
    base,
    quote,
    priceUSD,
    t.time,
  );
  return {
    symbol: base,
    side: t.isBuyer ? 'BUY' : 'SELL',
    qty,
    price_usd: priceUSD,
    fx_at_trade: fx,
    commission,
    ts: t.time,
    external_id: `binance:trade:${t.id}`,
    source: 'api',
  };
}

// A convert {from A to B} is a SELL of A and a BUY of B. We record it
// from the perspective of whichever side is the "asset" (non-stable).
// If both are non-stable (e.g. BTC→ETH), both legs are recorded. If
// both are stables, we skip (USDT→BUSD is a non-event).
export async function mapConvert(c: RawConvert): Promise<TradeInsert[]> {
  const fromAmt = Number(c.fromAmount);
  const toAmt = Number(c.toAmount);
  if (!(fromAmt > 0) || !(toAmt > 0)) return [];

  const fromIsStable = isStable(c.fromAsset);
  const toIsStable = isStable(c.toAsset);
  // Skip stable↔stable BEFORE any I/O — no FX or price lookup needed.
  if (fromIsStable && toIsStable) return [];

  const ts = c.createTime;
  const fx = await getUSDTHBForTs(ts);
  const out: TradeInsert[] = [];

  // Total USD value of each side at convert time. For stables this is
  // just the amount; for non-stables it's amount × price-per-unit. The
  // earlier version dropped the amount factor for non-stables, which
  // mis-priced non-stable→non-stable converts (caught by mapper tests).
  let fromUsdTotal = 0;
  if (fromIsStable) {
    fromUsdTotal = fromAmt;
  } else {
    const p = await getPriceUSDTForTs(c.fromAsset, ts);
    if (p != null && p > 0) fromUsdTotal = fromAmt * p;
  }
  let toUsdTotal = 0;
  if (toIsStable) {
    toUsdTotal = toAmt;
  } else {
    const p = await getPriceUSDTForTs(c.toAsset, ts);
    if (p != null && p > 0) toUsdTotal = toAmt * p;
  }

  if (!toIsStable && fromUsdTotal > 0) {
    // Effectively bought `toAsset` with `fromAsset`.
    const priceUSD = fromUsdTotal / toAmt;
    out.push({
      symbol: c.toAsset,
      side: 'BUY',
      qty: toAmt,
      price_usd: priceUSD,
      fx_at_trade: fx,
      commission: 0,
      ts,
      external_id: `binance:convert:buy:${c.orderId}`,
      source: 'api',
    });
  }

  if (!fromIsStable && toUsdTotal > 0) {
    // Effectively sold `fromAsset` for `toAsset`.
    const priceUSD = toUsdTotal / fromAmt;
    out.push({
      symbol: c.fromAsset,
      side: 'SELL',
      qty: fromAmt,
      price_usd: priceUSD,
      fx_at_trade: fx,
      commission: 0,
      ts,
      external_id: `binance:convert:sell:${c.orderId}`,
      source: 'api',
    });
  }

  return out;
}

// "Buy crypto with card/bank" — a real THB→crypto trade with a known
// THB cost. Stable output → deposit row (USD wallet credit). Non-stable
// output → trade row with implied fx_at_trade = fiat / (qty × priceUSD).
export async function mapFiatPayment(
  p: RawFiatPayment & { transactionType: 0 | 1 },
): Promise<FiatPaymentMapped | null> {
  const fiat = Number(p.sourceAmount);
  const crypto = Number(p.obtainAmount);
  if (!(fiat > 0) || !(crypto > 0) || p.fiatCurrency !== 'THB') return null;

  if (isStable(p.cryptoCurrency)) {
    return {
      kind: 'deposit',
      row: {
        platform: 'Binance',
        amount_thb: p.transactionType === 0 ? fiat : -fiat,
        amount_usd: p.transactionType === 0 ? crypto : -crypto,
        fx_locked: fiat / crypto,
        ts: p.createTime,
        note: `fiat-pay ${p.cryptoCurrency} qty=${crypto} for ${fiat} THB`,
        source: `api-fiat-pay:${p.orderNo}`,
      },
    };
  }

  const priceUSD = await getPriceUSDTForTs(p.cryptoCurrency, p.createTime);
  if (priceUSD == null) return null;
  const fxImplied = fiat / (crypto * priceUSD);
  return {
    kind: 'trade',
    row: {
      symbol: p.cryptoCurrency,
      side: p.transactionType === 0 ? 'BUY' : 'SELL',
      qty: crypto,
      price_usd: priceUSD,
      fx_at_trade: fxImplied,
      commission: Number(p.totalFee) || 0,
      ts: p.createTime,
      external_id: `binance:fiat-pay:${p.orderNo}`,
      source: 'api-fiat-pay',
    },
  };
}
