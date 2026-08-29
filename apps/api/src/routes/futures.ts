// HTTP routes for the Binance Futures analytics dashboard.
//
// READ (dashboard):
//   GET  /futures/analytics?range=<days>   — full analytics payload
//
// INGEST (droplet relay — the chosen architecture):
//   POST /futures/account-snapshot         — wallet/margin/uPnL/available
//        (carries an `account` label; v1 relays from its own sub-account)
//   POST /futures/positions                — replace the open-position set
//   POST /futures/income                   — batch income rows (deduped)
//
// The droplet reads the bot's real futures account (its own futures key +
// static IP) and POSTs here, so no futures key lives on Fly. All routes are
// bearer-authed via the global onRequest hook (same token the bot already
// sends for /bot-event). The read path reads ONLY Postgres + bot_events; the
// Fly cron (services/futures-analytics.ts) only runs if an explicit Fly
// futures key is set — otherwise these ingestion endpoints are the source.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildFuturesAnalytics,
  futuresConfigured,
  ingestFuturesAccountSnapshot,
  ingestFuturesPositions,
  ingestFuturesIncome,
} from '../services/futures-analytics.js';

const fin = () => z.number().finite();

const AccountBody = z.object({
  // Sub-account label. Constrained to a slug so it can never collide with SQL
  // quoting or render as something surprising in the portfolio row name.
  // Defaults to 'main' so a relay that predates this field keeps working.
  account: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).default('main'),
  walletBalanceUsd: fin().nonnegative(),
  marginBalanceUsd: fin(),
  unrealizedPnlUsd: fin(),
  availableBalanceUsd: fin(),
});

const PositionsBody = z.object({
  positions: z.array(
    z.object({
      symbol: z.string().min(1).max(32),
      positionSide: z.string().max(16).default('BOTH'),
      positionAmt: fin(),
      entryPrice: fin().nonnegative(),
      markPrice: fin().nonnegative(),
      unrealizedPnlUsd: fin(),
      liquidationPrice: fin().positive().nullable().default(null),
      leverage: fin().nonnegative(),
      marginUsd: fin().positive().nullable().default(null),
      slPrice: fin().positive().nullable().default(null),
      tpPrice: fin().positive().nullable().default(null),
    }),
  ).max(500),
  // Did the relay actually read open-orders this push? false (the default, and
  // what a fetch failure sends) → the server PRESERVES existing sl/tp instead
  // of letting a transient blip null out a bracket that's still resting.
  bracketsKnown: z.boolean().default(false),
});

const IncomeBody = z.object({
  income: z.array(
    z.object({
      tranId: z.number().int(),
      symbol: z.string().max(32).default(''),
      incomeType: z.string().min(1).max(48),
      incomeUsd: fin(),
      asset: z.string().max(16).default('USDT'),
      ts: z.number().int().positive(),
    }),
  ).min(1).max(1000),
});

export async function futuresRoutes(app: FastifyInstance) {
  app.get('/futures/analytics', async (req) => {
    const q = req.query as { range?: string };
    const raw = Number(q.range);
    // Default 30d; clamp [1, 730] so a bad query can't scan unbounded.
    const rangeDays = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 730) : 30;
    const analytics = await buildFuturesAnalytics(rangeDays);
    return { ...analytics, futuresConfigured: futuresConfigured() };
  });

  app.post('/futures/account-snapshot', async (req, reply) => {
    const p = AccountBody.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: 'invalid', details: p.error.flatten().fieldErrors }; }
    const { stored } = await ingestFuturesAccountSnapshot(p.data);
    return { ok: true, stored };
  });

  app.post('/futures/positions', async (req, reply) => {
    const p = PositionsBody.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: 'invalid', details: p.error.flatten().fieldErrors }; }
    await ingestFuturesPositions(p.data.positions, p.data.bracketsKnown);
    return { ok: true, count: p.data.positions.length };
  });

  app.post('/futures/income', async (req, reply) => {
    const p = IncomeBody.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: 'invalid', details: p.error.flatten().fieldErrors }; }
    const { inserted } = await ingestFuturesIncome(p.data.income);
    return { ok: true, received: p.data.income.length, inserted };
  });
}
