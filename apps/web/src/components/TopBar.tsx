import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Currency } from '@consolidate/shared';

interface Props {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  lastSyncMs: number;
}

export function TopBar({ currency, setCurrency, lastSyncMs }: Props) {
  const relative = lastSyncMs ? new Date(lastSyncMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—';
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [dimeSyncing, setDimeSyncing] = useState(false);
  const [dimeSyncMsg, setDimeSyncMsg] = useState<string | null>(null);

  const { data: syncStatus } = useQuery({
    queryKey: ['binance-status'],
    queryFn: () => api.binanceStatus(),
    staleTime: 30_000,
    refetchInterval: syncing ? 5_000 : 60_000,
  });
  const { data: dimeStatus } = useQuery({
    queryKey: ['dime-mail-status'],
    queryFn: () => api.dimeMailStatus(),
    staleTime: 30_000,
    refetchInterval: dimeSyncing ? 5_000 : 60_000,
  });

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api.binanceSync();
      const parts: string[] = [];
      if (r.counts.trades) parts.push(`${r.counts.trades} trades`);
      if (r.counts.deposits) parts.push(`${r.counts.deposits} deposits`);
      if (r.counts.rewards) parts.push(`${r.counts.rewards} rewards`);
      setSyncMsg(parts.length ? `+${parts.join(', ')}` : 'Up to date');
      // Refresh portfolio + trades data after sync
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      void queryClient.invalidateQueries({ queryKey: ['trades'] });
      void queryClient.invalidateQueries({ queryKey: ['binance-status'] });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('409')) setSyncMsg('Sync already running');
      else setSyncMsg(`Error: ${msg.slice(0, 60)}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 8_000);
    }
  }, [syncing, queryClient]);

  const handleDimeSync = useCallback(async () => {
    if (dimeSyncing) return;
    setDimeSyncing(true);
    setDimeSyncMsg(null);
    try {
      const r = await api.dimeMailSync();
      const parts: string[] = [];
      if (r.counts.deposits) parts.push(`${r.counts.deposits} deposits`);
      if (r.counts.trades) parts.push(`${r.counts.trades} trades`);
      if (r.counts.pdfsDumped) parts.push(`${r.counts.pdfsDumped} pdfs`);
      setDimeSyncMsg(parts.length ? `+${parts.join(', ')}` : 'Up to date');
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      void queryClient.invalidateQueries({ queryKey: ['trades'] });
      void queryClient.invalidateQueries({ queryKey: ['dime-mail-status'] });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('409')) setDimeSyncMsg('Sync already running');
      else if (msg.includes('--auth')) setDimeSyncMsg('Run: bun run import:dime-mail -- --auth');
      else setDimeSyncMsg(`Error: ${msg.slice(0, 60)}`);
    } finally {
      setDimeSyncing(false);
      setTimeout(() => setDimeSyncMsg(null), 10_000);
    }
  }, [dimeSyncing, queryClient]);

  const lastSync = syncStatus?.lastSyncTs
    ? new Date(syncStatus.lastSyncTs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : null;
  const lastDimeSync = dimeStatus?.lastSyncTs
    ? new Date(dimeStatus.lastSyncTs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : null;
  const dimeTitle = !dimeStatus?.enabled
    ? 'Gmail credentials missing'
    : !dimeStatus.authed
      ? 'Run `bun run import:dime-mail -- --auth` once to authorize'
      : lastDimeSync
        ? `Last DIME mail sync: ${lastDimeSync}`
        : 'Sync DIME mail (KKP inbound + confirmation PDFs)';
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: 'color-mix(in oklab, var(--bg) 90%, transparent)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          maxWidth: 1240,
          margin: '0 auto',
          padding: '14px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--bg)',
              fontFamily: 'var(--mono)',
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            ∑
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: -0.2 }}>Consolidate</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6, fontFamily: 'var(--mono)' }}>
            {relative} · live
          </div>
          {syncStatus?.enabled && (
            <>
              <button
                onClick={handleSync}
                disabled={syncing}
                title={lastSync ? `Last Binance sync: ${lastSync}` : 'Sync Binance history'}
                style={{
                  marginLeft: 8,
                  padding: '4px 10px',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  fontWeight: 600,
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  cursor: syncing ? 'wait' : 'pointer',
                  background: syncing ? 'var(--surface-2)' : 'var(--surface)',
                  color: syncing ? 'var(--muted)' : 'var(--text)',
                  opacity: syncing ? 0.7 : 1,
                }}
              >
                {syncing ? '⟳ Syncing…' : '⟳ Sync'}
              </button>
              {syncMsg && (
                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                  {syncMsg}
                </div>
              )}
            </>
          )}
          {dimeStatus?.enabled && (
            <>
              <button
                onClick={handleDimeSync}
                disabled={dimeSyncing || !dimeStatus.authed}
                title={dimeTitle}
                style={{
                  marginLeft: 4,
                  padding: '4px 10px',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  fontWeight: 600,
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  cursor: dimeSyncing ? 'wait' : dimeStatus.authed ? 'pointer' : 'not-allowed',
                  background: dimeSyncing ? 'var(--surface-2)' : 'var(--surface)',
                  color: dimeSyncing || !dimeStatus.authed ? 'var(--muted)' : 'var(--text)',
                  opacity: dimeSyncing ? 0.7 : dimeStatus.authed ? 1 : 0.5,
                }}
              >
                {dimeSyncing ? '⟳ DIME…' : '⟳ DIME mail'}
              </button>
              {dimeSyncMsg && (
                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                  {dimeSyncMsg}
                </div>
              )}
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 8 }}>
          {(['USD', 'THB', 'USDT'] as Currency[]).map((c) => (
            <button
              key={c}
              onClick={() => setCurrency(c)}
              style={{
                padding: '5px 12px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                fontWeight: 600,
                border: 'none',
                borderRadius: 5,
                cursor: 'pointer',
                background: currency === c ? 'var(--surface)' : 'transparent',
                color: currency === c ? 'var(--text)' : 'var(--muted)',
                boxShadow: currency === c ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
