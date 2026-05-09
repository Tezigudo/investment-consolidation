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

// Resolution order: stored override → VITE_API_URL → PROD_DEFAULT
// (non-localhost) → '/api' (vite dev proxy).
const ENV_BASE = import.meta.env.VITE_API_URL as string | undefined;
const PROD_DEFAULT = 'https://investment-consolidation.fly.dev';
const TOKEN_KEY = 'consolidate.apiToken';
const URL_KEY = 'consolidate.apiUrl';

function readBase(): string {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(URL_KEY);
    if (stored) return stored.replace(/\/$/, '');
  }
  if (ENV_BASE) return ENV_BASE.replace(/\/$/, '');
  // Vite proxies /api → :4000 only on localhost. On any deployed host
  // (Cloudflare Pages), fall through to the prod Fly URL instead of /api,
  // which would otherwise loop back to the Pages domain.
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return PROD_DEFAULT;
  }
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
export function clearApiUrl() {
  localStorage.removeItem(URL_KEY);
}
export function clearApiToken() {
  localStorage.removeItem(TOKEN_KEY);
}
// Stored override only (empty when unset) — distinct from the resolved
// value so the Settings input shows "what I actually saved", not the
// fallback chain's current pick.
export function getStoredApiUrl(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(URL_KEY) || '';
}
export function getStoredApiToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(TOKEN_KEY) || '';
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
      airdrop: { qty: number; valueUSD: number; valueTHB: number; count: number; sources: number; firstTs: number; lastTs: number } | null;
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
