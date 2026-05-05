// DIME mail importer. Two email streams:
//
// 1) KKP "receiving funds" notifications (no-reply@kkpfg.com)
//    Plain-text body contains date, account, and THB amount. These
//    represent THB deposited into the DIME settlement account (X1270)
//    and are ingested as deposits(platform='DIME', amount_thb, fx_locked).
//
// 2) DIME confirmation notes (no-reply@dime.co.th)
//    Password-protected PDF (DDMMYYYY birthdate) containing the trade
//    details. Phase 1: decrypt, extract text, dump to disk so we can
//    write the parser against real output. Phase 2: parse into trades.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Use the legacy build — the default build pulls in DOMMatrix from the
// browser. Node-compatible surface, same API.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { gmail_v1 } from 'googleapis';
import { pool } from '../db/client.js';
import { config } from '../config.js';
import { getGmailClient, gmail } from './gmail-client.js';
import { getUSDTHBForTs } from './fx-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = path.resolve(__dirname, '../../data/dime-pdf-debug');

const KKP_QUERY = 'from:no-reply@kkpfg.com subject:(X1270)';
const DIME_QUERY = 'from:no-reply@dime.co.th subject:("Confirmation Note" OR ใบยืนยันการซื้อขาย)';

// ──────────────────────────────────────────────────────────────
// Cursor helpers — mirror binance_sync_state pattern
// ──────────────────────────────────────────────────────────────

interface Cursor {
  last_ts: number | null;
}

async function readCursor(endpoint: string): Promise<Cursor> {
  const { rows } = await pool.query<Cursor>(
    'SELECT last_ts FROM dime_sync_state WHERE endpoint = $1',
    [endpoint],
  );
  return rows[0] ?? { last_ts: null };
}

async function writeCursor(endpoint: string, lastTs: number): Promise<void> {
  await pool.query(
    `INSERT INTO dime_sync_state(endpoint, last_ts, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET
       last_ts = EXCLUDED.last_ts,
       updated_at = EXCLUDED.updated_at`,
    [endpoint, lastTs, Date.now()],
  );
}

export async function isDimeMailSeeded(): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM dime_sync_state LIMIT 1');
  return rows.length > 0;
}

export async function getLastDimeMailSyncTs(): Promise<number | null> {
  const { rows } = await pool.query<{ ts: number | null }>(
    'SELECT MAX(updated_at) AS ts FROM dime_sync_state',
  );
  return rows[0]?.ts ?? null;
}

// ──────────────────────────────────────────────────────────────
// Gmail helpers
// ──────────────────────────────────────────────────────────────

async function* listMessages(
  g: gmail_v1.Gmail,
  query: string,
): AsyncGenerator<string> {
  let pageToken: string | undefined;
  do {
    const res = await g.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken,
    });
    for (const m of res.data.messages ?? []) {
      if (m.id) yield m.id;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Walk the MIME tree, return the first text/plain (utf-8) payload.
function extractPlainTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  const collected: string[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart): void => {
    if (p.mimeType === 'text/plain' && p.body?.data) {
      collected.push(b64urlDecode(p.body.data).toString('utf8'));
    }
    for (const part of p.parts ?? []) walk(part);
  };
  walk(payload);
  return collected.join('\n');
}

function extractHtmlBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  const collected: string[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart): void => {
    if (p.mimeType === 'text/html' && p.body?.data) {
      collected.push(b64urlDecode(p.body.data).toString('utf8'));
    }
    for (const part of p.parts ?? []) walk(part);
  };
  walk(payload);
  return collected.join('\n');
}

// Strip HTML tags + decode basic entities. Good enough to find regex
// markers when the email has no text/plain alternative.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ');
}

function bodyText(msg: gmail_v1.Schema$Message): string {
  const plain = extractPlainTextBody(msg.payload ?? undefined);
  if (plain.trim().length > 20) return plain;
  return htmlToText(extractHtmlBody(msg.payload ?? undefined));
}

function findAttachments(
  payload: gmail_v1.Schema$MessagePart | undefined,
): { filename: string; attachmentId: string; mimeType: string }[] {
  const out: { filename: string; attachmentId: string; mimeType: string }[] = [];
  if (!payload) return out;
  const walk = (p: gmail_v1.Schema$MessagePart): void => {
    if (p.filename && p.body?.attachmentId) {
      out.push({
        filename: p.filename,
        attachmentId: p.body.attachmentId,
        mimeType: p.mimeType ?? 'application/octet-stream',
      });
    }
    for (const part of p.parts ?? []) walk(part);
  };
  walk(payload);
  return out;
}

async function fetchAttachment(
  g: gmail_v1.Gmail,
  msgId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await g.users.messages.attachments.get({
    userId: 'me',
    messageId: msgId,
    id: attachmentId,
  });
  const data = res.data.data;
  if (!data) throw new Error(`attachment ${attachmentId} on ${msgId} had no data`);
  return b64urlDecode(data);
}

// ──────────────────────────────────────────────────────────────
// KKP "receiving funds" parsing
// ──────────────────────────────────────────────────────────────

// Parses DD/MM/YYYY HH:mm as Bangkok local time (+07:00) → ms epoch UTC.
function parseBangkokDateTime(dateStr: string, timeStr: string): number | null {
  const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!dm || !tm) return null;
  const [, dd, mm, yyyy] = dm;
  const [, hh, mi] = tm;
  // Bangkok is UTC+7 — subtract 7h from wall clock to get UTC.
  return Date.UTC(+yyyy, +mm - 1, +dd, +hh - 7, +mi, 0);
}

export interface KkpInbound {
  ts: number;
  amountThb: number;
  account: string;
}

export function parseKkpInbound(body: string): KkpInbound | null {
  // The rendered email glues labels; the plain-text MIME may or may not
  // preserve newlines. Use lenient per-field regexes against the whole blob.
  const amountRe = /จำนวนเงิน\s*:?\s*([\d,]+\.\d{2})\s*THB/;
  const dateRe = /วันที่ทำรายการ\s*:?\s*(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{1,2}:\d{2})/;
  const acctRe = /บัญชี\s*:?\s*(X\d{3,})/;
  const amountM = amountRe.exec(body);
  const dateM = dateRe.exec(body);
  const acctM = acctRe.exec(body);
  if (!amountM || !dateM || !acctM) return null;
  const amount = Number(amountM[1].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  const ts = parseBangkokDateTime(dateM[1], dateM[2]);
  if (ts == null) return null;
  return { ts, amountThb: amount, account: acctM[1] };
}

// ──────────────────────────────────────────────────────────────
// DIME confirmation PDF → text + parsed trades
// ──────────────────────────────────────────────────────────────

const ENG_MONTHS: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

// Trade row layout (single line per row in extracted text):
//   <orderId 6+ digits>  <DD/MM/YYYY settlement>  <BUY|SEL|REW|EXC|EXP>
//   <SYMBOL> [<EXCHANGE>] <qty>  <unit_price>  USD
//   <gross_ccy> <fee_ccy> <fee_thb_w_vat> <wht_ccy> <wht_thb> <total_ccy> <total_thb_net> <gross_thb>
const TRADE_ROW_RE =
  /(\d{6,})\s+(\d{2}\/\d{2}\/\d{4})\s+(BUY|SEL|REW|EXC|EXP)\s+([A-Z][A-Z.]*)\s+\[([A-Z]+)\]\s+([\d.]+)\s+([\d.,]+)\s+([A-Z]{3})\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/g;

// Document-level effective date + FX rate. Anchor on the English-month
// date that appears just before the FX number near the BOT line.
const DOC_DATE_FX_RE =
  /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\s+(\d{2}\.\d{4})/;

type DimeSide = 'BUY' | 'SEL' | 'REW' | 'EXC' | 'EXP';

interface DimeTradeRow {
  orderId: string;
  settlementDate: string;
  type: DimeSide;
  symbol: string;
  exchange: string;
  qty: number;
  unitPrice: number;
  currency: string;
  feeCcy: number;
}

export interface DimeConfirmation {
  effectiveTs: number; // ms epoch (Bangkok noon)
  fxThbPerUsd: number;
  trades: DimeTradeRow[];
}

function num(s: string): number {
  return Number(s.replace(/,/g, ''));
}

export function parseDimeConfirmation(text: string): DimeConfirmation | null {
  const docM = DOC_DATE_FX_RE.exec(text);
  if (!docM) return null;
  const day = Number(docM[1]);
  const month = ENG_MONTHS[docM[2]];
  const year = Number(docM[3]);
  const fx = Number(docM[4]);
  if (!(fx > 0) || month == null) return null;
  // Noon Bangkok (+07:00) → UTC by subtracting 7h. Date-only granularity
  // is fine — fx_daily lookups key on date.
  const effectiveTs = Date.UTC(year, month, day, 12 - 7, 0, 0);

  const trades: DimeTradeRow[] = [];
  TRADE_ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRADE_ROW_RE.exec(text)) !== null) {
    const qty = num(m[6]);
    const unitPrice = num(m[7]);
    const feeCcy = num(m[10]);
    if (!(qty > 0) || !(unitPrice > 0)) continue;
    trades.push({
      orderId: m[1],
      settlementDate: m[2],
      type: m[3] as DimeSide,
      symbol: m[4],
      exchange: m[5],
      qty,
      unitPrice,
      currency: m[8],
      feeCcy,
    });
  }
  return { effectiveTs, fxThbPerUsd: fx, trades };
}

async function pdfToText(buffer: Buffer, password: string): Promise<string> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    password,
    useSystemFonts: true,
    // pdfjs-dist 5.7 dropped `isEvalSupported` from the public type but
    // still honors it at runtime — keep it for the security posture.
    isEvalSupported: false,
  } as Parameters<typeof getDocument>[0]);
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((it) => ('str' in it ? (it as { str: string }).str : ''))
      .join(' ');
    pages.push(line);
  }
  return pages.join('\n\n--- page break ---\n\n');
}

// ──────────────────────────────────────────────────────────────
// DB writers
// ──────────────────────────────────────────────────────────────

async function insertDimeDeposit(d: {
  amount_thb: number;
  amount_usd: number;
  fx_locked: number;
  ts: number;
  note: string;
  source: string;
}): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO deposits(platform, amount_thb, amount_usd, fx_locked, ts, note, source)
     VALUES ('DIME', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (platform, source) DO NOTHING`,
    [d.amount_thb, d.amount_usd, d.fx_locked, d.ts, d.note, d.source],
  );
  return (res.rowCount ?? 0) > 0;
}

// SEL → SELL, REW → DIV (reward shares ≈ dividend-like).
// EXC/EXP (option exercise) skipped — never seen in dumps; revisit if encountered.
function dimeSideToTradeSide(s: DimeSide): 'BUY' | 'SELL' | 'DIV' | null {
  if (s === 'BUY') return 'BUY';
  if (s === 'SEL') return 'SELL';
  if (s === 'REW') return 'DIV';
  return null;
}

async function insertDimeTrade(
  t: DimeTradeRow,
  effectiveTs: number,
  fx: number,
): Promise<boolean> {
  const side = dimeSideToTradeSide(t.type);
  if (!side) return false;
  const res = await pool.query(
    `INSERT INTO trades(platform, symbol, side, qty, price_usd, fx_at_trade, commission, ts, external_id, source)
     VALUES ('DIME', $1, $2, $3, $4, $5, $6, $7, $8, 'mail-pdf')
     ON CONFLICT (platform, external_id) DO NOTHING`,
    [
      t.symbol,
      side,
      t.qty,
      t.unitPrice,
      fx,
      t.feeCcy,
      effectiveTs,
      `dime:order:${t.orderId}`,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

// ──────────────────────────────────────────────────────────────
// Orchestration
// ──────────────────────────────────────────────────────────────

export interface DimeMailCounts {
  deposits: number;
  trades: number;
  pdfsDumped: number;
  pdfErrors: number;
  parseErrors: number;
  mailErrors: number;
}

export interface DimeMailResult {
  counts: DimeMailCounts;
  durationMs: number;
  debugDir: string;
}

const newCounts = (): DimeMailCounts => ({
  deposits: 0,
  trades: 0,
  pdfsDumped: 0,
  pdfErrors: 0,
  parseErrors: 0,
  mailErrors: 0,
});

function buildIncrementalQuery(baseQuery: string, sinceTs: number | null): string {
  if (!sinceTs) return baseQuery;
  // Gmail `after:` uses seconds.
  return `${baseQuery} after:${Math.floor(sinceTs / 1000)}`;
}

async function importKkpInbound(
  g: gmail_v1.Gmail,
  counts: DimeMailCounts,
  progress: (s: string) => void,
): Promise<void> {
  const cursorKey = 'kkp-inbound';
  const cursor = await readCursor(cursorKey);
  const query = buildIncrementalQuery(KKP_QUERY, cursor.last_ts);
  let seen = 0;
  let lastTs = cursor.last_ts ?? 0;

  for await (const msgId of listMessages(g, query)) {
    seen++;
    try {
      const res = await g.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
      const msg = res.data;
      const internalDate = Number(msg.internalDate ?? 0);
      const text = bodyText(msg);
      const parsed = parseKkpInbound(text);
      if (!parsed) {
        // Dump unparsed body for inspection.
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(DEBUG_DIR, `kkp-unparsed-${msgId}.txt`),
          text,
          'utf8',
        );
        counts.mailErrors++;
      } else {
        // Only ingest X1270 (the DIME funding account). Others are
        // unrelated KKP notifications.
        if (parsed.account === 'X1270') {
          const fx = await getUSDTHBForTs(parsed.ts);
          const amountUsd = parsed.amountThb / fx;
          const inserted = await insertDimeDeposit({
            amount_thb: parsed.amountThb,
            amount_usd: amountUsd,
            fx_locked: fx,
            ts: parsed.ts,
            note: `kkp-inbound ${parsed.amountThb} THB to ${parsed.account} @ ${fx.toFixed(4)}`,
            source: `mail:kkp:${msgId}`,
          });
          if (inserted) counts.deposits++;
        }
      }
      if (internalDate > lastTs) lastTs = internalDate;
    } catch (e) {
      console.warn(`[dime-mail] kkp ${msgId}:`, (e as Error).message);
      counts.mailErrors++;
    }
    if (seen % 25 === 0) progress(`kkp: ${seen} scanned, +${counts.deposits} deposits`);
  }
  if (lastTs > (cursor.last_ts ?? 0)) await writeCursor(cursorKey, lastTs);
}

async function importDimeConfirmations(
  g: gmail_v1.Gmail,
  counts: DimeMailCounts,
  progress: (s: string) => void,
): Promise<void> {
  const password = config.DIME_PDF_PASSWORD;
  if (!password) {
    progress('dime-confirmation: SKIPPED (set DIME_PDF_PASSWORD=DDMMYYYY in .env to enable)');
    return;
  }
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const cursorKey = 'dime-confirmation';
  const cursor = await readCursor(cursorKey);
  const query = buildIncrementalQuery(DIME_QUERY, cursor.last_ts);
  let seen = 0;
  let lastTs = cursor.last_ts ?? 0;

  for await (const msgId of listMessages(g, query)) {
    seen++;
    const outFile = path.join(DEBUG_DIR, `${msgId}.txt`);
    let text: string | null = null;
    let internalDate = 0;

    if (fs.existsSync(outFile)) {
      // Reuse the dumped text — much cheaper than re-downloading. Pull
      // internalDate from the dump header so the cursor still advances.
      text = fs.readFileSync(outFile, 'utf8');
      const m = /^#\s*internalDate:\s*(\d+)/m.exec(text);
      internalDate = m ? Number(m[1]) : 0;
    } else {
      try {
        const res = await g.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
        const msg = res.data;
        internalDate = Number(msg.internalDate ?? 0);
        const atts = findAttachments(msg.payload ?? undefined);
        const pdf = atts.find(
          (a) => a.mimeType === 'application/pdf' || a.filename.toLowerCase().endsWith('.pdf'),
        );
        if (!pdf) {
          fs.writeFileSync(
            path.join(DEBUG_DIR, `${msgId}.no-attachment.txt`),
            bodyText(msg),
            'utf8',
          );
          counts.pdfErrors++;
        } else {
          const buf = await fetchAttachment(g, msgId, pdf.attachmentId);
          try {
            const body = await pdfToText(buf, password);
            const header = [
              `# DIME confirmation dump`,
              `# msgId: ${msgId}`,
              `# filename: ${pdf.filename}`,
              `# internalDate: ${internalDate} (${new Date(internalDate).toISOString()})`,
              ``,
            ].join('\n');
            text = header + body;
            fs.writeFileSync(outFile, text, 'utf8');
            counts.pdfsDumped++;
          } catch (e) {
            const msgText = (e as Error).message;
            fs.writeFileSync(
              path.join(DEBUG_DIR, `${msgId}.decrypt-error.txt`),
              `# msgId: ${msgId}\n# filename: ${pdf.filename}\n# error: ${msgText}\n`,
              'utf8',
            );
            counts.pdfErrors++;
          }
        }
      } catch (e) {
        console.warn(`[dime-mail] dime ${msgId}:`, (e as Error).message);
        counts.mailErrors++;
      }
    }

    // Parse + insert trades (works for both freshly downloaded and
    // previously dumped texts — ON CONFLICT DO NOTHING handles dedup).
    if (text) {
      const conf = parseDimeConfirmation(text);
      if (!conf || conf.trades.length === 0) {
        counts.parseErrors++;
        console.warn(`[dime-mail] no trades parsed from ${msgId}`);
      } else {
        for (const tr of conf.trades) {
          if (await insertDimeTrade(tr, conf.effectiveTs, conf.fxThbPerUsd)) {
            counts.trades++;
          }
        }
      }
    }

    if (internalDate > lastTs) lastTs = internalDate;
    if (seen % 10 === 0) progress(`dime: ${seen} scanned, +${counts.trades} trades, +${counts.pdfsDumped} pdfs dumped`);
  }
  if (lastTs > (cursor.last_ts ?? 0)) await writeCursor(cursorKey, lastTs);
}

export interface DimeMailOpts {
  onProgress?: (phase: string, detail?: string) => void;
  interactive?: boolean; // allow OAuth prompt (CLI yes, HTTP route no)
}

export async function importDimeMail(opts: DimeMailOpts = {}): Promise<DimeMailResult> {
  const t0 = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const counts = newCounts();

  const auth = await getGmailClient({ interactive: opts.interactive ?? false });
  const g = gmail(auth);

  progress('kkp', 'scanning KKP X1270 inbound notifications');
  await importKkpInbound(g, counts, (s) => progress('kkp', s));
  progress('kkp', `done — +${counts.deposits} deposits`);

  progress('dime', 'scanning DIME confirmation notes');
  await importDimeConfirmations(g, counts, (s) => progress('dime', s));
  progress(
    'dime',
    `done — +${counts.trades} trades, +${counts.pdfsDumped} new pdf dumps, ${counts.parseErrors} parse errors`,
  );

  return {
    counts,
    durationMs: Date.now() - t0,
    debugDir: DEBUG_DIR,
  };
}
