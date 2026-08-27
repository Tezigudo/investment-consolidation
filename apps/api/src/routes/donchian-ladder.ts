// GET /donchian-ladder — where the trailing channel exit sits for an OPEN
// channel-exit leg, and where it moves next.
//
// WHY A SEPARATE ROUTE
// buildFuturesAnalytics is Postgres-only by design ("never calls Binance —
// hot-path discipline", services/futures-analytics.ts). Computing the channel
// needs live PERP klines, so folding it in would let a Binance hiccup degrade
// the whole Futures page. This mirrors routes/divergence.ts instead: its own
// route, its own module cache, degrades to `available: false` on its own.
//
// PERP, NOT SPOT. The bot evaluates BTC/USDT:USDT on fapi klines. Spot closes
// differ, and a spot-derived level is one the bot will never act on.
//
// FORMING BAR. Binance returns the still-forming bar last. The bot drops it
// before evaluating (that omission once cost the live bot a month of trades),
// so we drop it too and use its close only as the mark.

import type { FastifyInstance } from 'fastify';
import type { ChannelLadderState, FuturesBotTrade } from '@consolidate/shared';
import { pool } from '../db/client.js';
import { binanceFuturesPublicGet } from '../services/binance-http.js';
import {
  pairBotTrades,
  strategyMeta,
  isOpenPosition,
  PAIRING_KINDS,
  type BotEventLite,
} from '../services/futures-math.js';
import { buildChannelLadder, ladderSide, type LadderCandle } from '../services/donchian-ladder.js';

// The mark moves continuously even though the level only changes every 4h, so
// this is short. Still enough to keep a dashboard poll off Binance's weight.
const CACHE_MS = 60_000;
// Far enough back to catch the open entry of a leg whose time-stop is 8 days.
const LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const ROWS = 10;

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

let cache: { at: number; payload: ChannelLadderState } | null = null;

const unavailable = (reason: string): ChannelLadderState => ({
  available: false,
  reason,
  source: null,
  strategy: null,
  ladder: null,
});

// fapi symbol per bot leg. Explicitly a map, not a constant with a source
// parameter it ignores: a future non-BTC channel-exit leg must fail closed here
// rather than silently draw a BTC ladder over someone else's position.
const LEG_SYMBOL: Record<string, string> = {
  'snapback-btc-donchian': 'BTCUSDT',
};

async function openChannelTrade(): Promise<FuturesBotTrade | null> {
  const { rows } = await pool.query<{
    source: string; kind: string; bot_ts: string; side: string | null;
    qty: string | null; price_usd: string | null; notional_usd: string | null;
    equity_usd: string | null; strategy: string | null; payload: Record<string, unknown> | null;
  }>(
    `SELECT source, kind, bot_ts::text, side, qty, price_usd, notional_usd,
            equity_usd, strategy, payload
       FROM bot_events
      WHERE bot_ts >= $1
        AND kind = ANY($2)
      ORDER BY bot_ts ASC`,
    [Date.now() - LOOKBACK_MS, PAIRING_KINDS],
  );

  const events: BotEventLite[] = rows.map((r) => ({
    source: r.source,
    kind: r.kind,
    side: r.side as BotEventLite['side'],
    qty: r.qty != null ? Number(r.qty) : null,
    price_usd: r.price_usd != null ? Number(r.price_usd) : null,
    notional_usd: r.notional_usd != null ? Number(r.notional_usd) : null,
    equity_usd: r.equity_usd != null ? Number(r.equity_usd) : null,
    bot_ts_ms: Number(r.bot_ts), // BIGINT ms-epoch as text — NOT a date string
    strategy: r.strategy,
    payload: r.payload,
  }));

  // Only legs whose strategy declares a channel period have a trailing level to
  // draw at all. `isOpenPosition`, not a bare exitTs check: an entry whose exit
  // the bot dropped also has exitTs == null, and drawing a live trailing ladder
  // over a position that already closed is worse than drawing nothing.
  const open = pairBotTrades(events, Date.now()).filter(
    (t) => isOpenPosition(t) && strategyMeta(t.strategy)?.channelExitPeriod != null,
  );
  // Newest wins if two legs are somehow open — the ladder is per-position.
  open.sort((a, b) => b.entryTs - a.entryTs);
  return open[0] ?? null;
}

export async function donchianLadderRoutes(app: FastifyInstance) {
  app.get('/donchian-ladder', async (): Promise<ChannelLadderState> => {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.payload;

    let payload: ChannelLadderState;
    try {
      const trade = await openChannelTrade();
      if (!trade) {
        payload = unavailable('no channel-exit leg has an open position');
      } else {
        const meta = strategyMeta(trade.strategy)!;
        const period = meta.channelExitPeriod!;
        const side = ladderSide(trade.side);
        if (!side) {
          payload = unavailable(`open entry for ${trade.source} has no usable side`);
          cache = { at: Date.now(), payload };
          return payload;
        }
        const symbol = LEG_SYMBOL[trade.source];
        if (!symbol) {
          payload = unavailable(`no fapi symbol mapped for leg ${trade.source}`);
          cache = { at: Date.now(), payload };
          return payload;
        }
        const rawRows = await binanceFuturesPublicGet<RawKline[]>('/fapi/v1/klines', {
          symbol,
          interval: '4h',
          limit: Math.max(period + ROWS + 10, 50),
        });

        // Last row is the forming bar: its close is the live mark, and it must
        // NOT enter the channel window.
        const forming = rawRows[rawRows.length - 1];
        const mark = Number(forming[4]);
        const closedCandles: LadderCandle[] = rawRows
          .slice(0, -1)
          .map((r) => ({ closeTimeMs: Number(r[6]), close: Number(r[4]) }));

        const ladder = buildChannelLadder({
          closedCandles,
          period,
          barMs: meta.barMs,
          side,
          markUsd: mark,
          entryPriceUsd: trade.entryPriceUsd,
          slPriceUsd: trade.exitPlan?.slPriceUsd ?? null,
          rows: ROWS,
        });

        payload = ladder
          ? { available: true, reason: null, source: trade.source, strategy: trade.strategy, ladder }
          : unavailable('not enough closed bars to compute the channel');
      }
    } catch (err) {
      // Never 500 a dashboard panel over a Binance blip; the UI hides itself.
      app.log.warn({ err }, 'donchian-ladder: falling back to unavailable');
      payload = unavailable('could not reach Binance for perp klines');
    }

    cache = { at: Date.now(), payload };
    return payload;
  });
}
