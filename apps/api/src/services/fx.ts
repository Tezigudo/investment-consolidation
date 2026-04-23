import { db } from '../db/client.js';
import type { FxRow } from '../db/types.js';

const FX_TTL_MS = 60 * 60 * 1000; // 1h — FX moves slowly and we don't want to hammer free endpoints

interface ExchangeRateHostResponse {
  result?: number;
  success?: boolean;
  info?: { rate?: number };
}

async function fetchUSDTHBFromExchangerateHost(): Promise<number> {
  const res = await fetch('https://api.exchangerate.host/convert?from=USD&to=THB');
  if (!res.ok) throw new Error(`exchangerate.host ${res.status}`);
  const data = (await res.json()) as ExchangeRateHostResponse;
  const rate = data.result ?? data.info?.rate;
  if (!rate || rate <= 0) throw new Error('exchangerate.host returned no rate');
  return rate;
}

async function fetchUSDTHBFromErApi(): Promise<number> {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error(`er-api ${res.status}`);
  const data = (await res.json()) as { rates?: { THB?: number } };
  const rate = data.rates?.THB;
  if (!rate || rate <= 0) throw new Error('er-api returned no THB rate');
  return rate;
}

async function fetchUSDTHB(): Promise<{ rate: number; source: string }> {
  try {
    return { rate: await fetchUSDTHBFromExchangerateHost(), source: 'exchangerate.host' };
  } catch {
    return { rate: await fetchUSDTHBFromErApi(), source: 'open.er-api.com' };
  }
}

export function getCachedFx(pair: string): FxRow | undefined {
  return db.prepare('SELECT * FROM fx_rates WHERE pair = ?').get(pair) as FxRow | undefined;
}

export async function getUSDTHB(forceRefresh = false): Promise<FxRow> {
  const cached = getCachedFx('USDTHB');
  if (!forceRefresh && cached && Date.now() - cached.ts < FX_TTL_MS) return cached;

  try {
    const { rate, source } = await fetchUSDTHB();
    const row: FxRow = { pair: 'USDTHB', rate, source, ts: Date.now() };
    db.prepare(
      'INSERT INTO fx_rates(pair, rate, source, ts) VALUES (?, ?, ?, ?) ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, source = excluded.source, ts = excluded.ts',
    ).run(row.pair, row.rate, row.source, row.ts);
    return row;
  } catch (err) {
    if (cached) return cached; // stale is better than nothing
    throw err;
  }
}
