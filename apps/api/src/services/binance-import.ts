// Binance history importer — orchestration only.
//
// Pulls every record the SAPI + public APIs will give us — myTrades,
// deposits, withdrawals, convert, fiat orders/payments, earn & staking
// rewards — and writes them into our trades/deposits schema.
//
// Cursors are persisted in binance_sync_state so reruns are
// incremental: the first run might take a few minutes (5-year
// backfill), subsequent runs are seconds.
//
// File layout for this importer:
//   binance-import.ts             ← (this file) per-endpoint loops + top-level orchestration
//   binance-import-cursors.ts     ← cursor read/write + sync-state helpers
//   binance-import-mappers.ts     ← pure raw-row → schema mappers
//   binance-stables.ts            ← shared STABLES set + QUOTE_CANDIDATES

import { db } from '../db/client.js';
import {
  walkMyTrades,
  walkDeposits,
  walkWithdrawals,
  walkConverts,
  walkFlexibleRewards,
  walkLockedRewards,
  walkStakingRewards,
  walkFiatOrders,
  walkFiatPayments,
  type RawEarnReward,
  type RawStakingInterest,
} from './binance-history.js';
import { fetchAllBinanceBalances, getLiveSpotSymbols } from './binance.js';
import { backfillUSDTHB, getUSDTHBForTs } from './fx-history.js';
import { getPriceUSDTForTs } from './price-history.js';
import { isStable, QUOTE_CANDIDATES } from './binance-stables.js';
import { readCursor, writeCursor } from './binance-import-cursors.js';
import {
  parseSymbolBaseQuote,
  mapSpotTrade,
  mapConvert,
  mapFiatPayment,
  type TradeInsert,
} from './binance-import-mappers.js';

export { isBinanceSyncSeeded, getLastBinanceSyncTs } from './binance-import-cursors.js';

const BINANCE_LAUNCH_MS = Date.parse('2017-07-01T00:00:00Z'); // safe lower bound

// ──────────────────────────────────────────────────────────────
// Symbol universe discovery
// ──────────────────────────────────────────────────────────────

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

async function importMyTradesForSymbol(symbol: string, counts: Counts): Promise<void> {
  const parsed = parseSymbolBaseQuote(symbol);
  if (!parsed) return;
  const cursorKey = `myTrades:${symbol}`;
  const cursor = readCursor(cursorKey);
  const startFromId = cursor.last_id ? cursor.last_id + 1 : 0;
  let lastId = cursor.last_id ?? 0;

  try {
    for await (const t of walkMyTrades(symbol, startFromId)) {
      const mapped = await mapSpotTrade(t, parsed.base, parsed.quote);
      if (mapped && writeTrade(mapped)) counts.trades++;
      if (t.id > lastId) lastId = t.id;
    }
  } catch (e) {
    // -1121 ("Invalid symbol") is expected for candidate pairs the
    // account never traded. Only suppress that specific error code;
    // everything else (418 bans, network errors, etc.) must surface
    // so the cursor advances correctly on the next run.
    const msg = (e as Error).message;
    if (!/-1121/.test(msg)) {
      console.warn(`[binance-import] myTrades ${symbol}:`, msg);
      counts.errors++;
    }
    return;
  }

  // Persist cursor even when no trades were found (last_id stays 0).
  // This marks the symbol as "probed" so subsequent incremental runs
  // can skip it instead of burning another signed request.
  writeCursor(cursorKey, { last_id: lastId });
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
          // Klines miss → asset never had a USDT/BUSD pair on this date
          // (e.g. delisted before the backfill window opened, or asset
          // only ever quoted against another now-delisted pair). The row
          // is dropped silently from the trades table; surface it so the
          // user can decide whether to bridge-price it manually.
          console.warn(
            `[binance-import] ${key}: dropped ${r.asset} reward at ${new Date(ts).toISOString()} — no historical USDT price`,
          );
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
        if (ok) counts.rewards++;
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

    let amountThb = 0;
    let amountUsd = 0;
    let fxLocked = 0;
    let note = `crypto-in ${amount} ${d.coin}`;

    if (isStable(d.coin)) {
      // Stable arriving from another chain — treat as if it were funded
      // in THB at the USDTHB rate at the moment of deposit. Non-stable
      // external deposits still leave cost at 0.
      fxLocked = await getUSDTHBForTs(d.insertTime);
      amountUsd = amount;
      amountThb = amount * fxLocked;
      note = `crypto-in ${amount} ${d.coin} @ ${fxLocked.toFixed(4)} THB/USD`;
    }

    const info = insertDeposit.run({
      platform: 'Binance',
      amount_thb: amountThb,
      amount_usd: amountUsd,
      fx_locked: fxLocked,
      ts: d.insertTime,
      note,
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

// P2P import intentionally omitted — user opted out of P2P history ingestion.
// Re-enable by restoring importP2P/mapP2P and the `walkP2POrders` import.

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

  // Fiat payments = "buy crypto with card/bank" — see mapFiatPayment.
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
  progress('deposits', `done — +${counts.deposits} deposits`);

  progress('withdrawals');
  await importWithdrawals(startMs, endMs, counts, seenAssets);
  progress('withdrawals', `done — +${counts.withdrawals} withdrawals`);

  progress('fiat');
  await importFiatOrdersAndPayments(startMs, endMs, counts, seenAssets);
  progress('fiat', `done — deposits=${counts.deposits}, trades=${counts.trades}`);

  progress('convert');
  const tradesBefore = counts.trades;
  await importConverts(startMs, endMs, counts, seenAssets);
  progress('convert', `done — +${counts.trades - tradesBefore} convert trades`);

  progress('myTrades', `discovering asset universe (seen ${seenAssets.size} from history)`);
  const assets = await discoverAssetUniverse(seenAssets);
  const allCandidates: string[] = [];
  for (const a of assets) {
    for (const q of QUOTE_CANDIDATES) {
      if (a === q) continue;
      allCandidates.push(`${a}${q}`);
    }
  }
  // Pre-filter against exchangeInfo to avoid probing non-existent pairs.
  // This cuts the burst from ~400 signed calls down to actual Spot pairs.
  let liveSpot: Set<string>;
  try {
    liveSpot = await getLiveSpotSymbols();
  } catch (e) {
    console.warn('[binance-import] exchangeInfo fetch failed, probing all candidates:', (e as Error).message);
    liveSpot = new Set(allCandidates); // fallback: probe everything
  }
  const symbols = allCandidates.filter((s) => liveSpot.has(s));
  // Skip symbols that have been probed before and had no trades
  // (cursor exists with last_id = 0). Only re-probe symbols that
  // either have never been checked or have a real trade cursor.
  const toProbe = symbols.filter((sym) => {
    const cursor = readCursor(`myTrades:${sym}`);
    // null = never probed → must check.
    // last_id > 0 = has trades → check for new ones.
    // last_id = 0 + exists in DB = probed but empty → skip.
    return cursor.last_id === null || cursor.last_id > 0;
  });
  progress(
    'myTrades',
    `probing ${toProbe.length} pairs (${symbols.length - toProbe.length} cached-empty skipped, ${allCandidates.length} total candidates)`,
  );
  let done = 0;
  const spotTradesBefore = counts.trades;
  for (const sym of toProbe) {
    await importMyTradesForSymbol(sym, counts);
    done++;
    if (done % 10 === 0) {
      progress('myTrades', `${done}/${toProbe.length} — +${counts.trades - spotTradesBefore} trades so far`);
    }
  }
  progress('myTrades', `done — +${counts.trades - spotTradesBefore} spot trades from ${toProbe.length} pairs`);

  progress('rewards', 'earn + staking');
  await importEarnRewards(startMs, endMs, counts);
  progress('rewards', `done — +${counts.rewards} rewards`);

  progress(
    'summary',
    `trades=${counts.trades} deposits=${counts.deposits} rewards=${counts.rewards} withdrawals=${counts.withdrawals} errors=${counts.errors}`,
  );

  return {
    counts,
    durationMs: Date.now() - t0,
    symbolsProbed: symbols.length,
  };
}
