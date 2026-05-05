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

// Resolution order:
//   1. localStorage override (Settings → Server URL) — lets user retarget
//      a deployed web build at a different API without a redeploy.
//   2. VITE_API_URL baked at build time (Cloudflare Pages env var).
//   3. /api fallback — only meaningful in dev (Vite proxies to :4000).
const ENV_BASE = (import.meta as { env?: Record<string, string | undefined> }).env
  ?.VITE_API_URL;
const TOKEN_KEY = 'consolidate.apiToken';
const URL_KEY = 'consolidate.apiUrl';

function readBase(): string {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(URL_KEY);
    if (stored) return stored.replace(/\/$/, '');
  }
  if (ENV_BASE) return ENV_BASE.replace(/\/$/, '');
  return '/api';
}

function readToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setApiUrl(url: string) {
  localStorage.setItem(URL_KEY, url.trim().replace(/\/$/, ''));
}
export function setApiToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token.trim());
}
export function getApiUrl(): string {
  return readBase();
}
export function getApiToken(): string {
  return readToken();
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${readBase()}${path}`, { ...init, headers });
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
      realizedUSD: number;
      realizedTHB: number;
      realizedFxContribTHB: number;
      series: { t: number; price: number }[];
      earned: { qty: number; valueUSD: number; valueTHB: number; count: number; firstTs: number; lastTs: number };
      trades: { id: number; ts: number; side: 'BUY' | 'SELL' | 'DIV'; qty: number; price_usd: number; fx_at_trade: number; commission: number; source: string | null }[];
    }>(`/symbols/${encodeURIComponent(sym)}/history${s ? `?${s}` : ''}`);
  },
  importTradesCsv: async (file: File, platform: Platform): Promise<ImportSummary> => {
    const body = new FormData();
    body.append('file', file);
    const headers = new Headers();
    const token = readToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${readBase()}/import/trades-csv?platform=${platform}`, {
      method: 'POST',
      body,
      headers,
    });
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
