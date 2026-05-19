// HTTP routes for bot event ingestion + status read.
//
// POST /bot-event       — bot pushes a single event
// POST /bot-event/batch — bot drains its outbox (array of events)
// GET  /bot-status      — dashboard reads the current bot status
// GET  /bot-events      — raw event log (paginated)
//
// Bearer auth applies via the global onRequest hook in server.ts —
// snapback-btc's bot loads CONSOLIDATE_API_TOKEN from its .env and
// sends `Authorization: Bearer <token>` on every push.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  botStatus,
  insertBotEvent,
  recentBotEvents,
} from '../services/bot-events.js';
import type { BotEventKind } from '@consolidate/shared';

const KIND = z.enum([
  'boot',
  'heartbeat',
  'dry_run_signal',
  'entry',
  'exit',
  'kill_switch',
  'halt',
  'boot_flatten',
  'order_failed',
  'signal_skipped',
]);

const EventBody = z.object({
  source: z.string().min(1).max(64),
  external_id: z.string().min(1).max(128),
  bot_ts_ms: z.number().int().positive(),
  kind: KIND,
  signal_id: z.string().max(64).nullable().optional(),
  strategy: z.string().max(64).nullable().optional(),
  side: z.enum(['long', 'short']).nullable().optional(),
  // Numeric fields are bounded to defend against malformed/replayed events
  // that would produce nonsense in the dashboard (negative equity makes
  // killSwitchHeadroomPct render a garbage signed value; price_usd=0 would
  // div-by-zero in some downstream consumers).
  qty: z.number().finite().nonnegative().nullable().optional(),
  price_usd: z.number().finite().positive().nullable().optional(),
  notional_usd: z.number().finite().nonnegative().nullable().optional(),
  equity_usd: z.number().finite().nonnegative().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const BatchBody = z.object({
  events: z.array(EventBody).min(1).max(200),
});

export async function botEventRoutes(app: FastifyInstance) {
  app.post('/bot-event', async (req, reply) => {
    const parsed = EventBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_event', details: parsed.error.flatten().fieldErrors };
    }
    try {
      const { inserted, id } = await insertBotEvent(parsed.data);
      // 200 on insert AND on dedup-noop — both are success from the bot's
      // perspective (idempotent retry). The body distinguishes.
      return { ok: true, inserted, id };
    } catch (e) {
      req.log.error({ err: e }, 'bot-event insert failed');
      reply.code(500);
      return { error: 'insert_failed', message: (e as Error).message };
    }
  });

  app.post('/bot-event/batch', async (req, reply) => {
    const parsed = BatchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_batch', details: parsed.error.flatten().fieldErrors };
    }
    let inserted = 0;
    let skipped = 0;
    const errors: { external_id: string; message: string }[] = [];
    for (const e of parsed.data.events) {
      try {
        const r = await insertBotEvent(e);
        if (r.inserted) inserted++;
        else skipped++;
      } catch (err) {
        errors.push({ external_id: e.external_id, message: (err as Error).message });
      }
    }
    // Returning 207 (or any non-2xx) on partial failure is critical: the bot's
    // outbox drain only deletes local rows on a 2xx response. If we returned 200
    // with errors in the body, the bot's default `res.ok` check would delete
    // events the server actually failed to store. The (source, external_id)
    // UNIQUE constraint makes the bot's retry safe (successful events dedupe).
    if (errors.length > 0) {
      req.log.warn({ errors, inserted, skipped }, 'bot-event batch had errors');
      reply.code(inserted + skipped === 0 ? 500 : 207);
    }
    return { ok: errors.length === 0, inserted, skipped, errors };
  });

  app.get('/bot-status', async (req) => {
    // `||` (not `??`) so an empty-string query param (?source=) still
    // falls through to the default. Otherwise an accidental
    // `WHERE source = ''` returns a fabricated "unknown" status.
    const source = (req.query as { source?: string })?.source || 'snapback-btc';
    return botStatus(source);
  });

  app.get('/bot-events', async (req, reply) => {
    const q = req.query as {
      source?: string;
      kind?: string;
      since?: string;
      limit?: string;
    };
    const source = q.source || 'snapback-btc';
    const opts: { kind?: BotEventKind; since?: number; limit?: number } = {};
    if (q.kind) {
      const k = KIND.safeParse(q.kind);
      if (!k.success) {
        reply.code(400);
        return { error: 'invalid_kind' };
      }
      opts.kind = k.data;
    }
    if (q.since) {
      const since = Number(q.since);
      if (Number.isFinite(since)) opts.since = since;
    }
    if (q.limit) {
      const limit = Number(q.limit);
      if (Number.isFinite(limit)) opts.limit = limit;
    }
    return recentBotEvents(source, opts);
  });
}
