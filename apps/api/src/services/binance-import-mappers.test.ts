import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseSymbolBaseQuote,
  resolvePriceUSD,
  mapSpotTrade,
  mapConvert,
  mapFiatPayment,
} from './binance-import-mappers.js';
import type { RawSpotTrade, RawConvert, RawFiatPayment } from './binance-history.js';

// Network-touching helpers are mocked. Mappers must not call the real
// FX/price lookups in tests.
vi.mock('./fx-history.js', () => ({
  getUSDTHBForTs: vi.fn(),
}));
vi.mock('./price-history.js', () => ({
  getPriceUSDTForTs: vi.fn(),
}));

import { getUSDTHBForTs } from './fx-history.js';
import { getPriceUSDTForTs } from './price-history.js';

const mockedFx = vi.mocked(getUSDTHBForTs);
const mockedPrice = vi.mocked(getPriceUSDTForTs);

beforeEach(() => {
  mockedFx.mockReset();
  mockedPrice.mockReset();
});

describe('parseSymbolBaseQuote', () => {
  it('splits BTCUSDT into base=BTC quote=USDT', () => {
    expect(parseSymbolBaseQuote('BTCUSDT')).toEqual({ base: 'BTC', quote: 'USDT' });
  });

  it('prefers USDT over BTC suffix when both match (BTCBTC is degenerate but ETHBTC is real)', () => {
    // QUOTE_CANDIDATES order is USDT, BUSD, FDUSD, USDC, BTC, ETH, BNB, TUSD
    // ETHBTC ends with BTC → quote=BTC
    expect(parseSymbolBaseQuote('ETHBTC')).toEqual({ base: 'ETH', quote: 'BTC' });
  });

  it('returns null when no candidate quote suffix matches', () => {
    expect(parseSymbolBaseQuote('FOOBARXYZ')).toBeNull();
  });

  it('returns null when symbol equals the quote (no base left)', () => {
    expect(parseSymbolBaseQuote('USDT')).toBeNull();
  });
});

describe('resolvePriceUSD', () => {
  it('returns the input price unchanged when quote is a stable', async () => {
    const out = await resolvePriceUSD(50, 'USDT', 1700000000000);
    expect(out).toBe(50);
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('multiplies by the quote-asset price when quote is non-stable', async () => {
    mockedPrice.mockResolvedValueOnce(40000); // BTC = $40k
    const out = await resolvePriceUSD(0.05, 'BTC', 1700000000000); // 0.05 BTC = $2000
    expect(out).toBeCloseTo(2000, 6);
    expect(mockedPrice).toHaveBeenCalledWith('BTC', 1700000000000);
  });

  it('returns null when the quote-asset price lookup misses', async () => {
    mockedPrice.mockResolvedValueOnce(null);
    const out = await resolvePriceUSD(0.05, 'BTC', 1700000000000);
    expect(out).toBeNull();
  });
});

describe('mapSpotTrade', () => {
  function rawTrade(p: Partial<RawSpotTrade>): RawSpotTrade {
    return {
      id: 1,
      symbol: 'BTCUSDT',
      orderId: 1,
      price: '40000',
      qty: '0.001',
      quoteQty: '40',
      commission: '0.04',
      commissionAsset: 'USDT',
      time: 1700000000000,
      isBuyer: true,
      isMaker: false,
      ...p,
    };
  }

  it('maps a stable-quote BUY trade to BUY/USD-priced row', async () => {
    mockedFx.mockResolvedValueOnce(35);
    const out = await mapSpotTrade(rawTrade({}), 'BTC', 'USDT');
    expect(out).toEqual({
      symbol: 'BTC',
      side: 'BUY',
      qty: 0.001,
      price_usd: 40000,
      fx_at_trade: 35,
      commission: 0.04,
      ts: 1700000000000,
      external_id: 'binance:trade:1',
      source: 'api',
    });
  });

  it('maps a non-stable-quote SELL via resolvePriceUSD', async () => {
    mockedPrice.mockResolvedValueOnce(40000); // BTC = $40k → ETHBTC → USD
    mockedFx.mockResolvedValueOnce(36);
    const out = await mapSpotTrade(
      rawTrade({ id: 7, isBuyer: false, price: '0.05', qty: '2', symbol: 'ETHBTC' }),
      'ETH',
      'BTC',
    );
    expect(out?.side).toBe('SELL');
    expect(out?.price_usd).toBeCloseTo(0.05 * 40000, 6);
    expect(out?.fx_at_trade).toBe(36);
    expect(out?.external_id).toBe('binance:trade:7');
  });

  it('returns null when qty or price is non-positive', async () => {
    expect(await mapSpotTrade(rawTrade({ qty: '0' }), 'BTC', 'USDT')).toBeNull();
    expect(await mapSpotTrade(rawTrade({ price: '0' }), 'BTC', 'USDT')).toBeNull();
  });

  it('returns null when the non-stable quote price is unknown', async () => {
    mockedPrice.mockResolvedValueOnce(null);
    const out = await mapSpotTrade(
      rawTrade({ symbol: 'ETHBTC', price: '0.05', qty: '2' }),
      'ETH',
      'BTC',
    );
    expect(out).toBeNull();
  });
});

describe('mapConvert', () => {
  function rawConvert(p: Partial<RawConvert> = {}): RawConvert {
    return {
      quoteId: 'q',
      orderId: 999,
      orderStatus: 'SUCCESS',
      fromAsset: 'USDT',
      fromAmount: '100',
      toAsset: 'BTC',
      toAmount: '0.0025',
      ratio: '40000',
      inverseRatio: '0.000025',
      createTime: 1700000000000,
      ...p,
    };
  }

  it('stable→non-stable produces a single BUY for the non-stable side', async () => {
    mockedFx.mockResolvedValueOnce(35);
    const rows = await mapConvert(rawConvert());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: 'BTC',
      side: 'BUY',
      qty: 0.0025,
      fx_at_trade: 35,
      external_id: 'binance:convert:buy:999',
      source: 'api',
    });
    // priceUSD = fromAmt / toAmt = 100 / 0.0025 = 40000
    expect(rows[0].price_usd).toBeCloseTo(40000, 6);
  });

  it('non-stable→stable produces a single SELL for the non-stable side', async () => {
    mockedFx.mockResolvedValueOnce(36);
    const rows = await mapConvert(
      rawConvert({
        fromAsset: 'BTC',
        fromAmount: '0.001',
        toAsset: 'USDT',
        toAmount: '42',
        orderId: 555,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: 'BTC',
      side: 'SELL',
      qty: 0.001,
      fx_at_trade: 36,
      external_id: 'binance:convert:sell:555',
    });
    // priceUSD = toUSD / fromAmt = 42 / 0.001 = 42000
    expect(rows[0].price_usd).toBeCloseTo(42000, 6);
  });

  it('non-stable→non-stable (ETH→BTC) records both legs with USD-equivalent prices', async () => {
    // resolve fromUSD=ETH→USDT then toUSD=BTC→USDT
    mockedFx.mockResolvedValueOnce(35);
    mockedPrice
      .mockResolvedValueOnce(2000)  // ETH = $2000  (called for !toIsStable BUY leg: fromUSD)
      .mockResolvedValueOnce(40000); // BTC = $40k  (called for !fromIsStable SELL leg: toUSD)
    const rows = await mapConvert(
      rawConvert({
        fromAsset: 'ETH',
        fromAmount: '1',
        toAsset: 'BTC',
        toAmount: '0.05',
        orderId: 777,
      }),
    );
    expect(rows).toHaveLength(2);
    const buy = rows.find((r) => r.side === 'BUY');
    const sell = rows.find((r) => r.side === 'SELL');
    expect(buy).toMatchObject({
      symbol: 'BTC',
      qty: 0.05,
      external_id: 'binance:convert:buy:777',
    });
    // BUY price = fromUSD * 1 / toAmt = 2000 / 0.05 = 40000
    expect(buy?.price_usd).toBeCloseTo(40000, 6);
    expect(sell).toMatchObject({
      symbol: 'ETH',
      qty: 1,
      external_id: 'binance:convert:sell:777',
    });
    // SELL price = toUSD / fromAmt = 40000*0.05 / 1 = 2000
    expect(sell?.price_usd).toBeCloseTo(2000, 6);
  });

  it('stable→stable is a no-op (USDT→BUSD is not a trade)', async () => {
    const rows = await mapConvert(
      rawConvert({ fromAsset: 'USDT', toAsset: 'BUSD', toAmount: '100' }),
    );
    expect(rows).toEqual([]);
    expect(mockedFx).not.toHaveBeenCalled();
  });

  it('returns [] when amounts are non-positive', async () => {
    expect(
      await mapConvert(rawConvert({ fromAmount: '0', toAmount: '0.0025' })),
    ).toEqual([]);
    expect(
      await mapConvert(rawConvert({ fromAmount: '100', toAmount: '0' })),
    ).toEqual([]);
  });
});

describe('mapFiatPayment', () => {
  function rawFiat(p: Partial<RawFiatPayment & { transactionType: 0 | 1 }> = {}): RawFiatPayment & { transactionType: 0 | 1 } {
    return {
      orderNo: 'ord-1',
      sourceAmount: '3500', // 3500 THB
      fiatCurrency: 'THB',
      obtainAmount: '100', // 100 USDT
      cryptoCurrency: 'USDT',
      totalFee: '5',
      price: '35',
      status: 'Completed',
      createTime: 1700000000000,
      transactionType: 0,
      ...p,
    };
  }

  it('THB → stable (USDT) becomes a deposit row with implied fx', async () => {
    const out = await mapFiatPayment(rawFiat());
    expect(out?.kind).toBe('deposit');
    if (out?.kind !== 'deposit') return;
    expect(out.row).toMatchObject({
      platform: 'Binance',
      amount_thb: 3500,
      amount_usd: 100,
      ts: 1700000000000,
      source: 'api-fiat-pay:ord-1',
    });
    expect(out.row.fx_locked).toBeCloseTo(3500 / 100, 6); // 35
  });

  it('THB SELL → stable inverts signs (transactionType=1)', async () => {
    const out = await mapFiatPayment(rawFiat({ transactionType: 1 }));
    expect(out?.kind).toBe('deposit');
    if (out?.kind !== 'deposit') return;
    expect(out.row.amount_thb).toBe(-3500);
    expect(out.row.amount_usd).toBe(-100);
  });

  it('THB → non-stable (BTC) becomes a trade with implied fx_at_trade', async () => {
    mockedPrice.mockResolvedValueOnce(40000); // BTC priced at $40k
    const out = await mapFiatPayment(
      rawFiat({
        sourceAmount: '14000', // 14000 THB
        obtainAmount: '0.01', // 0.01 BTC
        cryptoCurrency: 'BTC',
        orderNo: 'ord-7',
      }),
    );
    expect(out?.kind).toBe('trade');
    if (out?.kind !== 'trade') return;
    expect(out.row).toMatchObject({
      symbol: 'BTC',
      side: 'BUY',
      qty: 0.01,
      price_usd: 40000,
      external_id: 'binance:fiat-pay:ord-7',
      source: 'api-fiat-pay',
    });
    // implied fx = 14000 / (0.01 × 40000) = 14000 / 400 = 35
    expect(out.row.fx_at_trade).toBeCloseTo(35, 6);
  });

  it('non-THB fiat is ignored', async () => {
    const out = await mapFiatPayment(rawFiat({ fiatCurrency: 'USD' }));
    expect(out).toBeNull();
  });

  it('returns null when the non-stable price lookup misses', async () => {
    mockedPrice.mockResolvedValueOnce(null);
    const out = await mapFiatPayment(rawFiat({ cryptoCurrency: 'BTC', obtainAmount: '0.01' }));
    expect(out).toBeNull();
  });
});
