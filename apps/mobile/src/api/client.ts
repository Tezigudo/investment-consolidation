// Mirror of apps/web/src/api/client.ts but with two changes:
//   1. Base URL is the full LAN URL (no Vite proxy on mobile).
//   2. Returned types include the same shapes — kept identical so the
//      shared package stays the single source of truth.
import type {
  PortfolioSnapshot,
  TradeRow,
  ImportSummary,
  Platform,
} from '@consolidate/shared';
import { getApiUrl, getApiToken } from './baseUrl';

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

export interface OnChainStatus {
  enabled: boolean;
  wallet: string | null;
  vaults: string[];
  costUSD: number;
}

export interface OnChainSnapshot {
  totalQty: number;
  walletQty: number;
  vaults: { address: string; assetsQty: number; sharesRaw: string }[];
}

export interface SymbolHistory {
  symbol: string;
  todayUSD: number;
  avgUSD: number;
  heldQty: number;
  realizedUSD: number;
  realizedTHB: number;
  realizedFxContribTHB: number;
  series: { t: number; price: number }[];
  earned: {
    qty: number;
    valueUSD: number;
    valueTHB: number;
    count: number;
    firstTs: number;
    lastTs: number;
  };
  trades: {
    id: number;
    ts: number;
    side: 'BUY' | 'SELL' | 'DIV';
    qty: number;
    price_usd: number;
    fx_at_trade: number;
    commission: number;
    source: string | null;
  }[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const [base, token] = await Promise.all([getApiUrl(), getApiToken()]);
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean; ts: number }>('/health'),
  portfolio: (refresh = false) =>
    req<PortfolioSnapshot>(`/portfolio${refresh ? '?refresh=1' : ''}`),
  trades: (opts: { platform?: Platform; symbol?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(opts)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)]),
    );
    const s = qs.toString();
    return req<TradeRow[]>(`/trades${s ? `?${s}` : ''}`);
  },
  symbolHistory: (
    sym: string,
    opts: { days?: number; kind?: 'stock' | 'crypto' } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.days) qs.set('days', String(opts.days));
    if (opts.kind) qs.set('kind', opts.kind);
    const s = qs.toString();
    return req<SymbolHistory>(
      `/symbols/${encodeURIComponent(sym)}/history${s ? `?${s}` : ''}`,
    );
  },
  importTradesCsv: async (
    file: { uri: string; name: string; type: string },
    platform: Platform,
  ): Promise<ImportSummary> => {
    const [base, token] = await Promise.all([getApiUrl(), getApiToken()]);
    const body = new FormData();
    // RN file objects are { uri, name, type } — not real Blobs. Relax the
    const [base, token] = await Promise.all([getApiUrl(), getApiToken()]);
+    const body = new FormData();
+    // React Native expects a `{ uri, name, type }` file object here, not a real Blob.
+    // Keep the runtime shape accurate and only relax the type for FormData.
+    body.append('file', file as any);
+    const headers = new Headers();
+    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${base}/import/trades-csv?platform=${platform}`, {
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
    req<{ counts: Record<string, number>; durationMs: number }>('/import/dime/mail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  onchainStatus: () => req<OnChainStatus>('/import/onchain/status'),
  onchainSync: () =>
    req<OnChainSnapshot>('/import/onchain/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
};
