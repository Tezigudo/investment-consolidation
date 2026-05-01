// Binance history endpoints + paginators.
//
// Each endpoint has its own quirks — window caps (30/90 day), cursor
// style (fromId for myTrades, time-range for everything else), and
// response shape. The paginators below normalize those into async
// generators that the importer can stream through.

import { binanceSignedGet as signedGet } from './binance-http.js';

// Pacing, 429/418 handling, and Retry-After are all centralised in
// binance-http.ts. Every call below routes through it, so the old
// PAGE_DELAY_MS sleeps between generator pages are now redundant —
// the pacer enforces a minimum inter-request interval across the
// entire app.

// ──────────────────────────────────────────────────────────────
// Spot myTrades (per-symbol) — fromId pagination
// ──────────────────────────────────────────────────────────────

export interface RawSpotTrade {
  id: number;
  symbol: string;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
}

export async function* walkMyTrades(
  symbol: string,
  startFromId = 0,
): AsyncGenerator<RawSpotTrade> {
  let fromId = startFromId;
  while (true) {
    const page = await signedGet<RawSpotTrade[]>('/api/v3/myTrades', {
      symbol,
      fromId,
      limit: 1000,
    });
    if (!page.length) return;
    for (const t of page) yield t;
    const lastId = page[page.length - 1].id;
    if (lastId === fromId) return; // wire-around guard
    fromId = lastId + 1;
    if (page.length < 1000) return;
  }
}

// ──────────────────────────────────────────────────────────────
// Time-window paginator helper for endpoints that take
// startTime/endTime and cap at N days.
// ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

async function* walkTimeWindows(
  startMs: number,
  endMs: number,
  windowDays: number,
): AsyncGenerator<{ startTime: number; endTime: number }> {
  const step = windowDays * DAY_MS;
  let t = startMs;
  while (t < endMs) {
    const end = Math.min(t + step - 1, endMs);
    yield { startTime: t, endTime: end };
    t = end + 1;
  }
}

// ──────────────────────────────────────────────────────────────
// Deposit history (crypto). 90-day window.
// ──────────────────────────────────────────────────────────────

export interface RawDeposit {
  id?: string;
  amount: string;
  coin: string;
  network?: string;
  status: number; // 1 = success
  txId?: string;
  insertTime: number;
  transferType?: number;
}

export async function* walkDeposits(startMs: number, endMs: number): AsyncGenerator<RawDeposit> {
  for await (const w of walkTimeWindows(startMs, endMs, 90)) {
    const page = await signedGet<RawDeposit[]>('/sapi/v1/capital/deposit/hisrec', {
      startTime: w.startTime,
      endTime: w.endTime,
      limit: 1000,
    });
    for (const d of page) if (d.status === 1) yield d;
  }
}

// ──────────────────────────────────────────────────────────────
// Withdraw history. 90-day window.
// ──────────────────────────────────────────────────────────────

export interface RawWithdraw {
  id: string;
  amount: string;
  coin: string;
  network?: string;
  status: number; // 6 = completed
  txId?: string;
  applyTime: string | number;
  transferType?: number;
}

function parseApplyTime(v: string | number): number {
  if (typeof v === 'number') return v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

export async function* walkWithdrawals(
  startMs: number,
  endMs: number,
): AsyncGenerator<RawWithdraw & { ts: number }> {
  for await (const w of walkTimeWindows(startMs, endMs, 90)) {
    const page = await signedGet<RawWithdraw[]>('/sapi/v1/capital/withdraw/history', {
      startTime: w.startTime,
      endTime: w.endTime,
      limit: 1000,
    });
    for (const d of page) if (d.status === 6) yield { ...d, ts: parseApplyTime(d.applyTime) };
  }
}

// ──────────────────────────────────────────────────────────────
// Convert history. 30-day window.
// ──────────────────────────────────────────────────────────────

export interface RawConvert {
  quoteId: string;
  orderId: number;
  orderStatus: string;
  fromAsset: string;
  fromAmount: string;
  toAsset: string;
  toAmount: string;
  ratio: string;
  inverseRatio: string;
  createTime: number;
}

export async function* walkConverts(startMs: number, endMs: number): AsyncGenerator<RawConvert> {
  for await (const w of walkTimeWindows(startMs, endMs, 30)) {
    const res = await signedGet<{ list?: RawConvert[] }>('/sapi/v1/convert/tradeFlow', {
      startTime: w.startTime,
      endTime: w.endTime,
      limit: 1000,
    });
    for (const c of res.list ?? []) {
      if (c.orderStatus === 'SUCCESS') yield c;
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Earn rewards — flexible + locked + staking. 90-day window.
// These are payouts that add qty with no cost basis → the importer
// books them as BUY at market price at payout time (option ii).
// ──────────────────────────────────────────────────────────────

export interface RawEarnReward {
  asset: string;
  rewards: string;
  time: number;
}

async function* walkFlexibleRewardsByType(
  type: 'BONUS' | 'REALTIME' | 'REWARDS',
  startMs: number,
  endMs: number,
): AsyncGenerator<RawEarnReward> {
  for await (const w of walkTimeWindows(startMs, endMs, 90)) {
    let page = 1;
    while (true) {
      const res = await signedGet<{ rows?: RawEarnReward[]; total?: number }>(
        '/sapi/v1/simple-earn/flexible/history/rewardsRecord',
        {
          type,
          startTime: w.startTime,
          endTime: w.endTime,
          size: 100,
          current: page,
        },
      );
      const rows = res.rows ?? [];
      for (const r of rows) yield r;
      if (rows.length < 100) break;
      page++;
    }
  }
}

export async function* walkFlexibleRewards(
  startMs: number,
  endMs: number,
): AsyncGenerator<RawEarnReward> {
  // Flexible earn publishes rewards under three record types — all three
  // need to be pulled to cover bonus + realtime accrual + payouts.
  for (const type of ['BONUS', 'REALTIME', 'REWARDS'] as const) {
    for await (const r of walkFlexibleRewardsByType(type, startMs, endMs)) yield r;
  }
}

export async function* walkLockedRewards(
  startMs: number,
  endMs: number,
): AsyncGenerator<RawEarnReward> {
  for await (const w of walkTimeWindows(startMs, endMs, 90)) {
    let page = 1;
    while (true) {
      const res = await signedGet<{ rows?: RawEarnReward[]; total?: number }>(
        '/sapi/v1/simple-earn/locked/history/rewardsRecord',
        { startTime: w.startTime, endTime: w.endTime, size: 100, current: page },
      );
      const rows = res.rows ?? [];
      for (const r of rows) yield r;
      if (rows.length < 100) break;
      page++;
    }
  }
}

export interface RawStakingInterest {
  asset: string;
  amount: string;
  time: number;
  txnType: string;
}

export async function* walkStakingRewards(
  startMs: number,
  endMs: number,
): AsyncGenerator<RawStakingInterest> {
  const products = ['STAKING', 'F_DEFI', 'L_DEFI'] as const;
  for (const product of products) {
    for await (const w of walkTimeWindows(startMs, endMs, 90)) {
      let page = 1;
      while (true) {
        try {
          const rows = await signedGet<RawStakingInterest[]>('/sapi/v1/staking/stakingRecord', {
            product,
            txnType: 'INTEREST',
            startTime: w.startTime,
            endTime: w.endTime,
            size: 100,
            current: page,
          });
          for (const r of rows) yield r;
          if (rows.length < 100) break;
          page++;
        } catch {
          break; // product not enabled for this account / window
        }
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// P2P orders. 30-day window. Authoritative THB/USDT rate per fill
// when the user funded their account via P2P.
// ──────────────────────────────────────────────────────────────

export interface RawP2POrder {
  orderNumber: string;
  tradeType: 'BUY' | 'SELL';
  asset: string;
  fiat: string;
  amount: string;
  totalPrice: string;
  unitPrice: string;
  orderStatus: string;
  createTime: number;
  commission: string;
}

export async function* walkP2POrders(
  startMs: number,
  endMs: number,
): AsyncGenerator<RawP2POrder> {
  for (const tradeType of ['BUY', 'SELL'] as const) {
    for await (const w of walkTimeWindows(startMs, endMs, 30)) {
      let page = 1;
      while (true) {
        const res = await signedGet<{ data?: RawP2POrder[]; total?: number }>(
          '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
          {
            tradeType,
            startTimestamp: w.startTime,
            endTimestamp: w.endTime,
            page,
            rows: 100,
          },
        );
        const rows = res.data ?? [];
        for (const r of rows) if (r.orderStatus === 'COMPLETED') yield r;
        if (rows.length < 100) break;
        page++;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Fiat orders (card / bank deposits & withdrawals). 90-day window.
// ──────────────────────────────────────────────────────────────

export interface RawFiatOrder {
  orderNo: string;
  fiatCurrency: string;
  indicatedAmount: string;
  amount: string;
  totalFee: string;
  status: string;
  createTime: number;
}

export async function* walkFiatOrders(
  startMs: number,
  endMs: number,
  transactionType: 0 | 1,
): AsyncGenerator<RawFiatOrder & { transactionType: 0 | 1 }> {
  for await (const w of walkTimeWindows(startMs, endMs, 90)) {
    let page = 1;
    while (true) {
      const res = await signedGet<{ data?: RawFiatOrder[]; total?: number }>(
        '/sapi/v1/fiat/orders',
        {
          transactionType,
          beginTime: w.startTime,
          endTime: w.endTime,
          page,
          rows: 500,
        },
      );
      const rows = res.data ?? [];
      for (const r of rows) if (r.status === 'Successful') yield { ...r, transactionType };
      if (rows.length < 500) break;
      page++;
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Fiat payments (Binance's "buy crypto with card/bank"). Records a
// crypto acquisition with a real fiat cost, like P2P.
// ──────────────────────────────────────────────────────────────

export interface RawFiatPayment {
  orderNo: string;
  sourceAmount: string;
  fiatCurrency: string;
  obtainAmount: string;
  cryptoCurrency: string;
  totalFee: string;
  price: string;
  status: string;
  createTime: number;
}

export async function* walkFiatPayments(
  startMs: number,
  endMs: number,
  transactionType: 0 | 1,
): AsyncGenerator<RawFiatPayment & { transactionType: 0 | 1 }> {
  for await (const w of walkTimeWindows(startMs, endMs, 90)) {
    let page = 1;
    while (true) {
      const res = await signedGet<{ data?: RawFiatPayment[] }>('/sapi/v1/fiat/payments', {
        transactionType,
        beginTime: w.startTime,
        endTime: w.endTime,
        page,
        rows: 500,
      });
      const rows = res.data ?? [];
      for (const r of rows) if (r.status === 'Completed') yield { ...r, transactionType };
      if (rows.length < 500) break;
      page++;
    }
  }
}
