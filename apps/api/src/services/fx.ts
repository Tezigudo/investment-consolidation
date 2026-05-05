import { pool } from '../db/client.js';
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

export async function getCachedFx(pair: string): Promise<FxRow | undefined> {
  const { rows } = await pool.query<FxRow>(
    'SELECT pair, rate, source, ts FROM fx_rates WHERE pair = $1',
    [pair],
  );
  return rows[0];
}

export async function getUSDTHB(forceRefresh = false): Promise<FxRow> {
  const cached = await getCachedFx('USDTHB');
  if (!forceRefresh && cached && Date.now() - cached.ts < FX_TTL_MS) return cached;

  try {
    const { rate, source } = await fetchUSDTHB();
    const row: FxRow = { pair: 'USDTHB', rate, source, ts: Date.now() };
    await pool.query(
      `INSERT INTO fx_rates(pair, rate, source, ts) VALUES ($1, $2, $3, $4)
       ON CONFLICT (pair) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, ts = EXCLUDED.ts`,
      [row.pair, row.rate, row.source, row.ts],
    );
    return row;
  } catch (err) {
    if (cached) return cached; // stale is better than nothing
    throw err;
  }
}
