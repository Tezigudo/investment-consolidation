import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { importTradesCsv } from '../services/csv-importer.js';
import { config } from '../config.js';
import {
  importBinanceHistory,
  isBinanceSyncSeeded,
  getLastBinanceSyncTs,
} from '../services/binance-import.js';
import {
  importDimeMail,
  isDimeMailSeeded,
  getLastDimeMailSyncTs,
} from '../services/dime-mail.js';
import { isGmailConfigured, isGmailAuthed } from '../services/gmail-client.js';
import { refreshOnChainWLD } from '../services/onchain.js';

const Query = z.object({
  platform: z.enum(['DIME', 'Binance']).default('DIME'),
});

// Guard against concurrent Binance imports.
let binanceImportRunning = false;
// Guard against concurrent DIME mail imports.
let dimeMailImportRunning = false;

export async function importRoutes(app: FastifyInstance) {
  app.post('/import/trades-csv', async (req, reply) => {
    const { platform } = Query.parse(req.query);
    const file = await req.file();
    if (!file) {
      reply.code(400);
      return { error: 'multipart file field required' };
    }
    const buf = await file.toBuffer();
    const text = buf.toString('utf8');
    try {
      return await importTradesCsv(text, platform);
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });

  // Binance history sync
  app.get('/import/binance/status', async () => {
    return {
      enabled: config.binanceEnabled,
      seeded: config.binanceEnabled ? await isBinanceSyncSeeded() : false,
      lastSyncTs: config.binanceEnabled ? await getLastBinanceSyncTs() : null,
      running: binanceImportRunning,
    };
  });

  app.post<{ Body: { fullHistory?: boolean } }>('/import/binance', async (req, reply) => {
    if (!config.binanceEnabled) {
      reply.code(400);
      return { error: 'Binance not configured (set BINANCE_API_KEY/SECRET in .env)' };
    }
    if (binanceImportRunning) {
      reply.code(409);
      return { error: 'Binance import already in progress' };
    }
    binanceImportRunning = true;
    try {
      const fullHistory = !!(req.body as Record<string, unknown>)?.fullHistory;
      const result = await importBinanceHistory({
        sinceMs: fullHistory ? undefined : undefined, // cursors handle incremental
      });
      return result;
    } finally {
      binanceImportRunning = false;
    }
  });

  // DIME mail sync (Gmail). Non-interactive — the first-time OAuth must
  // be completed from the CLI (`bun run import:dime-mail -- --auth`).
  app.get('/import/dime/mail/status', async () => {
    const gmailConfigured = isGmailConfigured();
    return {
      enabled: gmailConfigured,
      authed: gmailConfigured ? isGmailAuthed() : false,
      seeded: gmailConfigured ? await isDimeMailSeeded() : false,
      lastSyncTs: gmailConfigured ? await getLastDimeMailSyncTs() : null,
      running: dimeMailImportRunning,
      pdfPasswordSet: !!config.DIME_PDF_PASSWORD,
    };
  });

  app.post('/import/dime/mail', async (_req, reply) => {
    if (!isGmailConfigured()) {
      reply.code(400);
      return { error: 'Gmail credentials missing (secrets/gmail-credentials.json)' };
    }
    if (!isGmailAuthed()) {
      reply.code(400);
      return {
        error:
          'Gmail not authorized yet. Run `bun run import:dime-mail -- --auth` once to complete OAuth.',
      };
    }
    if (dimeMailImportRunning) {
      reply.code(409);
      return { error: 'DIME mail import already in progress' };
    }
    dimeMailImportRunning = true;
    try {
      const result = await importDimeMail({ interactive: false });
      return result;
    } finally {
      dimeMailImportRunning = false;
    }
  });

  // On-chain WLD: status + manual refresh ("Sync now" button can hit this).
  app.get('/import/onchain/status', async () => {
    return {
      enabled: config.onchainEnabled,
      wallet: config.ONCHAIN_WLD_WALLET || null,
      vaults: config.ONCHAIN_WLD_VAULTS,
      costUSD: config.ONCHAIN_WLD_COST_USD,
    };
  });

  app.post('/import/onchain/sync', async (_req, reply) => {
    if (!config.onchainEnabled) {
      reply.code(400);
      return { error: 'on-chain sync disabled (set ONCHAIN_WLD_WALLET in .env)' };
    }
    try {
      const snap = await refreshOnChainWLD();
      return snap;
    } catch (e) {
      reply.code(500);
      return { error: (e as Error).message };
    }
  });
}
