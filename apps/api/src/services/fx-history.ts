import { db } from '../db/client.js';

// Historical USDTHB source. Yahoo Finance `THB=X` chart endpoint gives
// daily closes for the whole range in a single call — we bulk-fetch
// once at backfill time and serve all subsequent lookups from SQLite.
//
// FX on weekends/holidays: we carry the last observed business-day
// close forward ("last available rate"), which is how most brokerage
// bookkeeping handles non-trading days.

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/THB=X';

interface YahooChartResponse {
  chart: {
    result?: {
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

export function dateKey(ts: number): string {
  // YYYY-MM-DD in UTC — keep it timezone-stable regardless of server TZ.
  return new Date(ts).toISOString().slice(0, 10);
}

// Fetch Yahoo daily closes for [startMs, endMs]. Returns rows suitable
// for upsert into fx_daily.
async function fetchYahooDailyRange(
  startMs: number,
  endMs: number,
): Promise<{ date: string; rate: number }[]> {
  const params = new URLSearchParams({
    period1: String(Math.floor(startMs / 1000)),
    period2: String(Math.floor(endMs / 1000)),
    interval: '1d',
    events: 'history',
  });
  const res = await fetch(`${YAHOO_CHART}?${params.toString()}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (consolidate-dashboard)' },
  });
  if (!res.ok) throw new Error(`yahoo THB=X ${res.status}`);
  const data = (await res.json()) as YahooChartResponse;
  if (data.chart.error) throw new Error(`yahoo THB=X: ${data.chart.error.description}`);
  const result = data.chart.result?.[0];
  const ts = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const out: { date: string; rate: number }[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    out.push({ date: dateKey(ts[i] * 1000), rate: close });
  }
  return out;
}

export async function backfillUSDTHB(startDate: string, endDate?: string): Promise<number> {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = endDate ? Date.parse(`${endDate}T23:59:59Z`) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error(`bad date range: ${startDate} .. ${endDate ?? 'now'}`);
  }
  const rows = await fetchYahooDailyRange(startMs, endMs);
  const insert = db.prepare(
    `INSERT INTO fx_daily(pair, date, rate, source) VALUES ('USDTHB', ?, ?, 'yahoo')
     ON CONFLICT(pair, date) DO UPDATE SET rate = excluded.rate, source = excluded.source`,
  );
  const tx = db.transaction((batch: { date: string; rate: number }[]) => {
    for (const r of batch) insert.run(r.date, r.rate);
  });
  tx(rows);
  return rows.length;
}

// Lookup USDTHB for an arbitrary millisecond timestamp. Uses the
// closest prior cached date (handles weekends/holidays). If no prior
// date is cached, falls back to the closest *later* date, and then as
// a last resort triggers a small backfill window around ts.
export async function getUSDTHBForTs(ts: number): Promise<number> {
  const date = dateKey(ts);
  const row = db
    .prepare(
      `SELECT rate FROM fx_daily WHERE pair = 'USDTHB' AND date <= ? ORDER BY date DESC LIMIT 1`,
    )
    .get(date) as { rate: number } | undefined;
  if (row) return row.rate;

  const later = db
    .prepare(
      `SELECT rate FROM fx_daily WHERE pair = 'USDTHB' AND date >= ? ORDER BY date ASC LIMIT 1`,
    )
    .get(date) as { rate: number } | undefined;
  if (later) return later.rate;

  // Cold cache: fetch a 30-day window centred on ts.
  const window = 30 * 86_400_000;
  const startDate = dateKey(ts - window);
  const endDate = dateKey(ts + window);
  await backfillUSDTHB(startDate, endDate);
  const retry = db
    .prepare(
      `SELECT rate FROM fx_daily WHERE pair = 'USDTHB' AND date <= ? ORDER BY date DESC LIMIT 1`,
    )
    .get(date) as { rate: number } | undefined;
  if (retry) return retry.rate;
  throw new Error(`no USDTHB rate found for ${date}`);
}

// Called from the cron to keep the tail of fx_daily current. Fetches
// the last 14 days so we always have today's rate whether it's a
// weekday or not.
export async function refreshDailyUSDTHB(): Promise<number> {
  const now = Date.now();
  const startDate = dateKey(now - 14 * 86_400_000);
  return backfillUSDTHB(startDate);
}
