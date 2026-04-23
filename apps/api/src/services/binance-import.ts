// Binance history importer.
//
// Pulls every record the SAPI + public APIs will give us — myTrades,
// deposits, withdrawals, convert, P2P, fiat orders/payments, earn &
// staking rewards — and maps them into our trades/deposits schema
// with fx_at_trade stamped per record.
//
// Cursors are persisted in binance_sync_state so reruns are
// incremental: the first run might take a few minutes (5-year
// backfill), subsequent runs are seconds.

import { db } from '../db/client.js';
import {
  walkMyTrades,
  walkDeposits,
  walkWithdrawals,
  walkConverts,
  walkFlexibleRewards,
  walkLockedRewards,
  walkStakingRewards,
  walkP2POrders,
  walkFiatOrders,
  walkFiatPayments,
  type RawSpotTrade,
  type RawConvert,
  type RawEarnReward,
  type RawStakingInterest,
  type RawP2POrder,
  type RawFiatPayment,
} from './binance-history.js';
import { fetchAllBinanceBalances } from './binance.js';
import { backfillUSDTHB, getUSDTHBForTs } from './fx-history.js';
import { getPriceUSDTForTs } from './price-history.js';

const BINANCE_LAUNCH_MS = Date.parse('2017-07-01T00:00:00Z'); // safe lower bound

// ──────────────────────────────────────────────────────────────
// Cursor helpers
// ──────────────────────────────────────────────────────────────

interface Cursor {
  last_id: number | null;
  last_ts: number | null;
}

function readCursor(endpoint: string): Cursor {
  const row = db
    .prepare('SELECT last_id, last_ts FROM binance_sync_state WHERE endpoint = ?')
    .get(endpoint) as Cursor | undefined;
  return row ?? { last_id: null, last_ts: null };
}

function writeCursor(endpoint: string, c: Partial<Cursor>): void {
  const existing = readCursor(endpoint);
  const next = {
    last_id: c.last_id ?? existing.last_id,
    last_ts: c.last_ts ?? existing.last_ts,
  };
  db.prepare(
    `INSERT INTO binance_sync_state(endpoint, last_id, last_ts, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       last_id = excluded.last_id,
       last_ts = excluded.last_ts,
       updated_at = excluded.updated_at`,
  ).run(endpoint, next.last_id, next.last_ts, Date.now());
}

// ──────────────────────────────────────────────────────────────
// Symbol universe discovery
// ──────────────────────────────────────────────────────────────

const QUOTE_CANDIDATES = ['USDT', 'BUSD', 'FDUSD', 'USDC', 'BTC', 'ETH', 'BNB', 'TUSD'];
const STABLES = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP']);

async function discoverAssetUniverse(seed: Set<string>): Promise<Set<string>> {
  const assets = new Set<string>(seed);
  // 1. Current balances (wherever they sit)
  try {
    const wallets = await fetchAllBinanceBalances();
    for (const w of wallets) assets.add(w.asset);
  } catch (e) {
    console.warn('[binance-import] balance discovery failed:', (e as Error).message);
  }
  // 2. Anything we've already recorded
  const existing = db
    .prepare("SELECT DISTINCT symbol FROM trades WHERE platform = 'Binance'")
    .all() as { symbol: string }[];
  for (const r of existing) assets.add(r.symbol);
  return assets;
}

// ──────────────────────────────────────────────────────────────
// DB writers — all go through INSERT OR IGNORE on UNIQUE(platform, external_id)
// so reruns (and overlapping windows) are safe.
// ──────────────────────────────────────────────────────────────

const insertTrade = db.prepare(
  `INSERT INTO trades(platform, symbol, side, qty, price_usd, fx_at_trade, commission, ts, external_id, source)
   VALUES (@platform, @symbol, @side, @qty, @price_usd, @fx_at_trade, @commission, @ts, @external_id, @source)
   ON CONFLICT(platform, external_id) DO NOTHING`,
);

const insertDeposit = db.prepare(
  `INSERT INTO deposits(platform, amount_thb, amount_usd, fx_locked, ts, note, source)
   VALUES (@platform, @amount_thb, @amount_usd, @fx_locked, @ts, @note, @source)
   ON CONFLICT(platform, source) DO NOTHING`,
);

interface TradeInsert {
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
function writeTrade(t: TradeInsert): boolean {
  const info = insertTrade.run({ platform: 'Binance', ...t });
  return info.changes > 0;
}

// ──────────────────────────────────────────────────────────────
// Per-endpoint importers
// ──────────────────────────────────────────────────────────────

interface Counts {
  trades: number;
  deposits: number;
  rewards: number;
  withdrawals: number;
  errors: number;
}
const newCounts = (): Counts => ({ trades: 0, deposits: 0, rewards: 0, withdrawals: 0, errors: 0 });

function parseSymbolBaseQuote(symbol: string): { base: string; quote: string } | null {
  for (const q of QUOTE_CANDIDATES) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { base: symbol.slice(0, -q.length), quote: q };
    }
  }
  return null;
}

async function resolvePriceUSD(
  priceInQuote: number,
  quote: string,
  ts: number,
): Promise<number | null> {
  if (STABLES.has(quote)) return priceInQuote;
  const quoteUSD = await getPriceUSDTForTs(quote, ts);
  if (quoteUSD == null) return null;
  return priceInQuote * quoteUSD;
}

async function importMyTradesForSymbol(symbol: string, counts: Counts): Promise<void> {
  const parsed = parseSymbolBaseQuote(symbol);
  if (!parsed) return;
  const cursorKey = `myTrades:${symbol}`;
  const cursor = readCursor(cursorKey);
  let startFromId = cursor.last_id ? cursor.last_id + 1 : 0;
  let lastId = cursor.last_id ?? 0;
  let sawAny = false;

  try {
    for await (const t of walkMyTrades(symbol, startFromId)) {
      sawAny = true;
      const mapped = await mapSpotTrade(t, parsed.base, parsed.quote);
      if (mapped && writeTrade(mapped)) counts.trades++;
      if (t.id > lastId) lastId = t.id;
    }
  } catch (e) {
    // "Invalid symbol" is expected for candidate pairs the account
    // never traded. Anything else surfaces.
    const msg = (e as Error).message;
    if (!/Invalid symbol/.test(msg) && !/-1121/.test(msg)) {
      console.warn(`[binance-import] myTrades ${symbol}:`, msg);
      counts.errors++;
    }
    return;
  }

  if (sawAny) writeCursor(cursorKey, { last_id: lastId });
}

async function mapSpotTrade(
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
  return {
    symbol: base,
    side: t.isBuyer ? 'BUY' : 'SELL',
    qty,
    price_usd: priceUSD,
    fx_at_trade: fx,
    commission: Number(t.commission) || 0,
    ts: t.time,
    external_id: `binance:trade:${t.id}`,
    source: 'api',
  };
}

async function importConverts(
  startMs: number,
  endMs: number,
  counts: Counts,
  seenAssets: Set<string>,
): Promise<void> {
  const cursorKey = 'convert';
  const cursor = readCursor(cursorKey);
  const effectiveStart = Math.max(startMs, (cursor.last_ts ?? 0) + 1);
  if (effectiveStart >= endMs) return;
  let lastTs = cursor.last_ts ?? 0;

  for await (const c of walkConverts(effectiveStart, endMs)) {
    seenAssets.add(c.fromAsset);
    seenAssets.add(c.toAsset);
    const rows = await mapConvert(c);
    for (const r of rows) if (writeTrade(r)) counts.trades++;
    if (c.createTime > lastTs) lastTs = c.createTime;
  }
  if (lastTs > (cursor.last_ts ?? 0)) writeCursor(cursorKey, { last_ts: lastTs });
}

async function mapConvert(c: RawConvert): Promise<TradeInsert[]> {
  // A convert {from A to B} is a SELL of A and a BUY of B. We record
  // it from the perspective of whichever side is the "asset" (non-
  // stable). If both are non-stable (e.g. BTC→ETH), both legs are
  // recorded. If both are stables, we skip (USDT→BUSD is a non-event).
  const fromAmt = Number(c.fromAmount);
  const toAmt = Number(c.toAmount);
  if (!(fromAmt > 0) || !(toAmt > 0)) return [];

  const ts = c.createTime;
  const fx = await getUSDTHBForTs(ts);
  const out: TradeInsert[] = [];

  const fromIsStable = STABLES.has(c.fromAsset);
  const toIsStable = STABLES.has(c.toAsset);

  if (fromIsStable && toIsStable) return [];

  if (!toIsStable) {
    // Effectively bought `toAsset` with `fromAsset`.
    const fromUSD = fromIsStable ? fromAmt : (await getPriceUSDTForTs(c.fromAsset, ts)) ?? 0;
    const priceUSD = fromAmt > 0 && fromUSD > 0 ? (fromUSD * 1) / toAmt : 0;
    if (priceUSD > 0) {
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
  }

  if (!fromIsStable) {
    // Effectively sold `fromAsset` for `toAsset`.
    const toUSD = toIsStable ? toAmt : (await getPriceUSDTForTs(c.toAsset, ts)) ?? 0;
    const priceUSD = toUSD > 0 && fromAmt > 0 ? toUSD / fromAmt : 0;
    if (priceUSD > 0) {
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
  }

  return out;
}

async function importEarnRewards(startMs: number, endMs: number, counts: Counts): Promise<void> {
  const endpoints: Array<[string, AsyncGenerator<RawEarnReward | RawStakingInterest>]> = [
    ['earn-flexible', walkFlexibleRewards(startMs, endMs)],
    ['earn-locked', walkLockedRewards(startMs, endMs)],
    ['earn-staking', walkStakingRewards(startMs, endMs)],
  ];

  for (const [key, gen] of endpoints) {
    const cursor = readCursor(key);
    const baseline = cursor.last_ts ?? 0;
    let lastTs = baseline;
    try {
      for await (const r of gen) {
        const ts = 'time' in r ? r.time : 0;
        if (ts <= baseline) continue;
        const amount = Number('rewards' in r ? r.rewards : r.amount);
        if (!(amount > 0)) continue;
        const priceUSD = await getPriceUSDTForTs(r.asset, ts);
        if (priceUSD == null) {
          counts.errors++;
          continue;
        }
        const fx = await getUSDTHBForTs(ts);
        const ok = writeTrade({
          symbol: r.asset,
          side: 'BUY',
          qty: amount,
          price_usd: priceUSD,
          fx_at_trade: fx,
          commission: 0,
          ts,
          external_id: `binance:${key}:${r.asset}:${ts}:${amount}`,
          source: 'api-reward',
        });
        if (ok) {
          counts.rewards++;
          counts.trades++;
        }
        if (ts > lastTs) lastTs = ts;
      }
    } catch (e) {
      console.warn(`[binance-import] ${key}:`, (e as Error).message);
      counts.errors++;
    }
    if (lastTs > baseline) writeCursor(key, { last_ts: lastTs });
  }
}

async function importDeposits(
  startMs: number,
  endMs: number,
  counts: Counts,
  seenAssets: Set<string>,
): Promise<void> {
  const cursorKey = 'deposits';
  const cursor = readCursor(cursorKey);
  const effectiveStart = Math.max(startMs, (cursor.last_ts ?? 0) + 1);
  if (effectiveStart >= endMs) return;
  let lastTs = cursor.last_ts ?? 0;

  for await (const d of walkDeposits(effectiveStart, endMs)) {
    const amount = Number(d.amount);
    if (!(amount > 0)) continue;
    seenAssets.add(d.coin);
    // Crypto deposits don't tell us the cost basis in THB. We record
    // them in `deposits` for visibility but leave amount_thb/amount_usd
    // as zero — the portfolio aggregator's fallback path handles the
    // unknown-cost case via live price at display time.
    const info = insertDeposit.run({
      platform: 'Binance',
      amount_thb: 0,
      amount_usd: 0,
      fx_locked: 0,
      ts: d.insertTime,
      note: `crypto-in ${amount} ${d.coin}`,
      source: `api-deposit:${d.id ?? d.txId ?? `${d.coin}:${d.insertTime}:${amount}`}`,
    });
    if (info.changes > 0) counts.deposits++;
    if (d.insertTime > lastTs) lastTs = d.insertTime;
  }
  if (lastTs > (cursor.last_ts ?? 0)) writeCursor(cursorKey, { last_ts: lastTs });
}

async function importWithdrawals(
  startMs: number,
  endMs: number,
  counts: Counts,
  seenAssets: Set<string>,
): Promise<void> {
  const cursorKey = 'withdrawals';
  const cursor = readCursor(cursorKey);
  const effectiveStart = Math.max(startMs, (cursor.last_ts ?? 0) + 1);
  if (effectiveStart >= endMs) return;
  let lastTs = cursor.last_ts ?? 0;

  for await (const w of walkWithdrawals(effectiveStart, endMs)) {
    seenAssets.add(w.coin);
    // Logged only — withdrawals naturally reduce live balance without
    // needing a trades-row adjustment (cost-basis aggregator scales
    // costTHB by live_qty / trade_qty).
    counts.withdrawals++;
    if (w.ts > lastTs) lastTs = w.ts;
  }
  if (lastTs > (cursor.last_ts ?? 0)) writeCursor(cursorKey, { last_ts: lastTs });
}

async function importP2P(
  startMs: number,
  endMs: number,
  counts: Counts,
  seenAssets: Set<string>,
): Promise<void> {
  const cursorKey = 'p2p';
  const cursor = readCursor(cursorKey);
  const effectiveStart = Math.max(startMs, (cursor.last_ts ?? 0) + 1);
  if (effectiveStart >= endMs) return;
  let lastTs = cursor.last_ts ?? 0;

  for await (const o of walkP2POrders(effectiveStart, endMs)) {
    seenAssets.add(o.asset);
    const out = await mapP2P(o);
    if (out) {
      if (out.kind === 'deposit') {
        const info = insertDeposit.run(out.row);
        if (info.changes > 0) counts.deposits++;
      } else if (out.kind === 'trade') {
        if (writeTrade(out.row)) counts.trades++;
      }
    }
    if (o.createTime > lastTs) lastTs = o.createTime;
  }
  if (lastTs > (cursor.last_ts ?? 0)) writeCursor(cursorKey, { last_ts: lastTs });
}

type P2PMapped =
  | {
      kind: 'deposit';
      row: {
        platform: 'Binance';
        amount_thb: number;
        amount_usd: number;
        fx_locked: number;
        ts: number;
        note: string;
        source: string;
      };
    }
  | { kind: 'trade'; row: TradeInsert };

async function mapP2P(o: RawP2POrder): Promise<P2PMapped | null> {
  const qtyAsset = Number(o.amount); // amount of `asset`
  const fiatAmount = Number(o.totalPrice); // amount of `fiat` paid/received
  if (!(qtyAsset > 0) || !(fiatAmount > 0)) return null;

  if (o.fiat === 'THB' && STABLES.has(o.asset)) {
    // BUY USDT with THB = deposit; SELL USDT for THB = reverse deposit
    // (record both for completeness; the portfolio math just reads
    // cumulative `deposits`).
    return {
      kind: 'deposit',
      row: {
        platform: 'Binance',
        amount_thb: o.tradeType === 'BUY' ? fiatAmount : -fiatAmount,
        amount_usd: o.tradeType === 'BUY' ? qtyAsset : -qtyAsset,
        fx_locked: fiatAmount / qtyAsset,
        ts: o.createTime,
        note: `p2p ${o.tradeType.toLowerCase()} ${qtyAsset} ${o.asset} for ${fiatAmount} THB`,
        source: `api-p2p:${o.orderNumber}`,
      },
    };
  }

  if (o.fiat === 'THB' && !STABLES.has(o.asset)) {
    // Directly bought / sold a non-stable for THB (rare). Treat as a
    // trade with price_usd derived from kline and fx_at_trade derived
    // from the THB/asset rate implied by the P2P fill.
    const priceUSD = await getPriceUSDTForTs(o.asset, o.createTime);
    if (priceUSD == null) return null;
    const fxImplied = fiatAmount / (qtyAsset * priceUSD); // THB per USD implied
    return {
      kind: 'trade',
      row: {
        symbol: o.asset,
        side: o.tradeType === 'BUY' ? 'BUY' : 'SELL',
        qty: qtyAsset,
        price_usd: priceUSD,
        fx_at_trade: fxImplied,
        commission: Number(o.commission) || 0,
        ts: o.createTime,
        external_id: `binance:p2p:${o.orderNumber}`,
        source: 'api-p2p',
      },
    };
  }

  return null; // non-THB fiat not handled
}

async function importFiatOrdersAndPayments(
  startMs: number,
  endMs: number,
  counts: Counts,
  seenAssets: Set<string>,
): Promise<void> {
  // Fiat orders = THB bank/card in/out to Binance (fiat ledger only).
  // These seed the deposits ledger the same way a bank transfer would.
  const fiatCursor = readCursor('fiat-orders');
  const fiatStart = Math.max(startMs, (fiatCursor.last_ts ?? 0) + 1);
  let fiatLast = fiatCursor.last_ts ?? 0;
  if (fiatStart < endMs) {
    for (const txType of [0, 1] as const) {
      for await (const o of walkFiatOrders(fiatStart, endMs, txType)) {
        if (o.fiatCurrency !== 'THB') continue;
        const amount = Number(o.amount);
        if (!(amount > 0)) continue;
        // Pure fiat in/out — no USD equivalent here; kept at 0 usd.
        const info = insertDeposit.run({
          platform: 'Binance',
          amount_thb: txType === 0 ? amount : -amount,
          amount_usd: 0,
          fx_locked: 0,
          ts: o.createTime,
          note: `fiat ${txType === 0 ? 'in' : 'out'} ${amount} THB`,
          source: `api-fiat-order:${o.orderNo}`,
        });
        if (info.changes > 0) counts.deposits++;
        if (o.createTime > fiatLast) fiatLast = o.createTime;
      }
    }
    if (fiatLast > (fiatCursor.last_ts ?? 0)) writeCursor('fiat-orders', { last_ts: fiatLast });
  }

  // Fiat payments = "buy crypto with card/bank" — a real THB→crypto
  // trade with a known THB cost. Treat like P2P buy-USDT path but with
  // the crypto output as a trade row (non-stable) or deposit (stable).
  const payCursor = readCursor('fiat-payments');
  const payStart = Math.max(startMs, (payCursor.last_ts ?? 0) + 1);
  let payLast = payCursor.last_ts ?? 0;
  if (payStart < endMs) {
    for (const txType of [0, 1] as const) {
      for await (const p of walkFiatPayments(payStart, endMs, txType)) {
        seenAssets.add(p.cryptoCurrency);
        const out = await mapFiatPayment(p);
        if (out) {
          if (out.kind === 'deposit') {
            const info = insertDeposit.run(out.row);
            if (info.changes > 0) counts.deposits++;
          } else if (out.kind === 'trade') {
            if (writeTrade(out.row)) counts.trades++;
          }
        }
        if (p.createTime > payLast) payLast = p.createTime;
      }
    }
    if (payLast > (payCursor.last_ts ?? 0)) writeCursor('fiat-payments', { last_ts: payLast });
  }
}

async function mapFiatPayment(
  p: RawFiatPayment & { transactionType: 0 | 1 },
): Promise<P2PMapped | null> {
  const fiat = Number(p.sourceAmount);
  const crypto = Number(p.obtainAmount);
  if (!(fiat > 0) || !(crypto > 0) || p.fiatCurrency !== 'THB') return null;

  if (STABLES.has(p.cryptoCurrency)) {
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

// ──────────────────────────────────────────────────────────────
// Top-level orchestration
// ──────────────────────────────────────────────────────────────

export interface ImportOptions {
  sinceMs?: number;
  onProgress?: (phase: string, detail?: string) => void;
}

export interface ImportResult {
  counts: Counts;
  durationMs: number;
  symbolsProbed: number;
}

export async function importBinanceHistory(opts: ImportOptions = {}): Promise<ImportResult> {
  const t0 = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const counts = newCounts();

  const startMs = opts.sinceMs ?? BINANCE_LAUNCH_MS;
  const endMs = Date.now();

  progress('fx', 'bulk-loading USDTHB');
  try {
    const n = await backfillUSDTHB(new Date(startMs).toISOString().slice(0, 10));
    progress('fx', `cached ${n} daily rates`);
  } catch (e) {
    console.warn('[binance-import] fx backfill failed:', (e as Error).message);
  }

  const seenAssets = new Set<string>();

  progress('deposits', 'crypto-in');
  await importDeposits(startMs, endMs, counts, seenAssets);
  progress('withdrawals');
  await importWithdrawals(startMs, endMs, counts, seenAssets);
  progress('p2p');
  await importP2P(startMs, endMs, counts, seenAssets);
  progress('fiat');
  await importFiatOrdersAndPayments(startMs, endMs, counts, seenAssets);
  progress('convert');
  await importConverts(startMs, endMs, counts, seenAssets);

  progress('myTrades', `discovering asset universe (seen ${seenAssets.size} from history)`);
  const assets = await discoverAssetUniverse(seenAssets);
  const symbols: string[] = [];
  for (const a of assets) {
    for (const q of QUOTE_CANDIDATES) {
      if (a === q) continue;
      symbols.push(`${a}${q}`);
    }
  }
  progress('myTrades', `probing ${symbols.length} candidate pairs`);
  let done = 0;
  for (const sym of symbols) {
    await importMyTradesForSymbol(sym, counts);
    done++;
    if (done % 10 === 0) progress('myTrades', `${done}/${symbols.length}`);
  }

  progress('rewards', 'earn + staking');
  await importEarnRewards(startMs, endMs, counts);

  return {
    counts,
    durationMs: Date.now() - t0,
    symbolsProbed: symbols.length,
  };
}
