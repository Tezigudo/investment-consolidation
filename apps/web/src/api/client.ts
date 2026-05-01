import type { PortfolioSnapshot, TradeRow, ImportSummary, Platform } from '@consolidate/shared';

export interface BinanceSyncStatus {
  enabled: boolean;
  seeded: boolean;
  lastSyncTs: number | null;
  running: boolean;
}

export interface BinanceSyncResult {
  counts: { trades: number; deposits: number; rewards: number; withdrawals: number; errors: number };
  durationMs: number;
  symbolsProbed: number;
}

export interface DimeMailStatus {
  enabled: boolean;
  authed: boolean;
  seeded: boolean;
  lastSyncTs: number | null;
  running: boolean;
  pdfPasswordSet: boolean;
}

export interface DimeMailResult {
  counts: {
    deposits: number;
    trades: number;
    pdfsDumped: number;
    pdfErrors: number;
    parseErrors: number;
    mailErrors: number;
  };
  durationMs: number;
  debugDir: string;
}

const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  portfolio: (refresh = false) => req<PortfolioSnapshot>(`/portfolio${refresh ? '?refresh=1' : ''}`),
  trades: (opts: { platform?: Platform; symbol?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(opts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    );
    const s = qs.toString();
    return req<TradeRow[]>(`/trades${s ? `?${s}` : ''}`);
  },
  symbolHistory: (sym: string, opts: { days?: number; kind?: 'stock' | 'crypto' } = {}) => {
    const qs = new URLSearchParams();
    if (opts.days) qs.set('days', String(opts.days));
    if (opts.kind) qs.set('kind', opts.kind);
    const s = qs.toString();
    return req<{
      symbol: string;
      todayUSD: number;
      avgUSD: number;
      heldQty: number;
      series: { t: number; price: number }[];
      trades: { id: number; ts: number; side: 'BUY' | 'SELL' | 'DIV'; qty: number; price_usd: number; fx_at_trade: number; source: string | null }[];
    }>(`/symbols/${encodeURIComponent(sym)}/history${s ? `?${s}` : ''}`);
  },
  importTradesCsv: async (file: File, platform: Platform): Promise<ImportSummary> => {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(`${BASE}/import/trades-csv?platform=${platform}`, { method: 'POST', body });
    if (!res.ok) throw new Error(`import ${res.status}: ${await res.text()}`);
    return res.json() as Promise<ImportSummary>;
  },
  binanceStatus: () => req<BinanceSyncStatus>('/import/binance/status'),
  binanceSync: () =>
    req<BinanceSyncResult>('/import/binance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  dimeMailStatus: () => req<DimeMailStatus>('/import/dime/mail/status'),
  dimeMailSync: () =>
    req<DimeMailResult>('/import/dime/mail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
};
