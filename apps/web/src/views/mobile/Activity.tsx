import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useTrades } from '../../hooks/usePortfolio';
import { fmtUSD } from '../../lib/format';
import { M } from './styles';
import type { ImportSummary, Platform, TradeRow } from '@consolidate/shared';

interface Props {
  privacy: boolean;
}

export function Activity({ privacy }: Props) {
  const { data: trades } = useTrades();
  const qc = useQueryClient();
  const [platform, setPlatform] = useState<Platform>('DIME');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => api.importTradesCsv(file, platform),
    onSuccess: (s) => {
      setSummary(s);
      qc.invalidateQueries({ queryKey: ['portfolio'] });
      qc.invalidateQueries({ queryKey: ['trades'] });
    },
  });

  // Sync buttons — same shape as desktop TopBar but compacted for mobile.
  const [bSyncing, setBSyncing] = useState(false);
  const [bMsg, setBMsg] = useState<string | null>(null);
  const [dSyncing, setDSyncing] = useState(false);
  const [dMsg, setDMsg] = useState<string | null>(null);
  const { data: bStatus } = useQuery({
    queryKey: ['binance-status'],
    queryFn: () => api.binanceStatus(),
    staleTime: 30_000,
    refetchInterval: bSyncing ? 5_000 : 60_000,
  });
  const { data: dStatus } = useQuery({
    queryKey: ['dime-mail-status'],
    queryFn: () => api.dimeMailStatus(),
    staleTime: 30_000,
    refetchInterval: dSyncing ? 5_000 : 60_000,
  });

  const handleBinance = useCallback(async () => {
    if (bSyncing) return;
    setBSyncing(true);
    setBMsg(null);
    try {
      const r = await api.binanceSync();
      const parts: string[] = [];
      if (r.counts.trades) parts.push(`${r.counts.trades} trades`);
      if (r.counts.deposits) parts.push(`${r.counts.deposits} deposits`);
      if (r.counts.rewards) parts.push(`${r.counts.rewards} rewards`);
      setBMsg(parts.length ? `+${parts.join(', ')}` : 'Up to date');
      qc.invalidateQueries({ queryKey: ['portfolio'] });
      qc.invalidateQueries({ queryKey: ['trades'] });
    } catch (e) {
      const m = (e as Error).message;
      setBMsg(m.includes('409') ? 'Already running' : `Error: ${m.slice(0, 50)}`);
    } finally {
      setBSyncing(false);
      setTimeout(() => setBMsg(null), 8000);
    }
  }, [bSyncing, qc]);

  const handleDime = useCallback(async () => {
    if (dSyncing) return;
    setDSyncing(true);
    setDMsg(null);
    try {
      const r = await api.dimeMailSync();
      const parts: string[] = [];
      if (r.counts.deposits) parts.push(`${r.counts.deposits} deposits`);
      if (r.counts.trades) parts.push(`${r.counts.trades} trades`);
      setDMsg(parts.length ? `+${parts.join(', ')}` : 'Up to date');
      qc.invalidateQueries({ queryKey: ['portfolio'] });
      qc.invalidateQueries({ queryKey: ['trades'] });
    } catch (e) {
      const m = (e as Error).message;
      if (m.includes('409')) setDMsg('Already running');
      else if (m.includes('--auth')) setDMsg('Run --auth on the server first');
      else setDMsg(`Error: ${m.slice(0, 50)}`);
    } finally {
      setDSyncing(false);
      setTimeout(() => setDMsg(null), 10000);
    }
  }, [dSyncing, qc]);

  return (
    <>
      <header style={M.header}>
        <div style={M.title}>Activity</div>
      </header>

      <div style={M.scroll}>
        {/* Sync buttons */}
        {(bStatus?.enabled || dStatus?.enabled) && (
          <div style={{ ...M.card, padding: '14px 14px' }}>
            <div style={M.eyebrow}>Sync now</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {bStatus?.enabled && (
                <SyncButton
                  label={bSyncing ? '⟳ Binance' : 'Sync Binance'}
                  busy={bSyncing}
                  onClick={handleBinance}
                  msg={bMsg}
                />
              )}
              {dStatus?.enabled && (
                <SyncButton
                  label={dSyncing ? '⟳ DIME mail' : 'Sync DIME mail'}
                  busy={dSyncing}
                  disabled={!dStatus.authed}
                  onClick={handleDime}
                  msg={dMsg}
                />
              )}
            </div>
            {dStatus?.enabled && !dStatus.authed && (
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 8 }}>
                DIME mail needs initial OAuth on the server: <code>bun run import:dime-mail -- --auth</code>
              </div>
            )}
          </div>
        )}

        {/* CSV upload */}
        <div style={M.section}>Import CSV</div>
        <div style={{ ...M.card, padding: '14px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <div style={M.segGroup}>
              {(['DIME', 'Binance'] as Platform[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPlatform(p)}
                  style={{
                    ...M.segBtn,
                    ...(platform === p ? M.segBtnActive : {}),
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            style={{
              width: '100%',
              padding: 22,
              background: 'var(--surface-2)',
              border: '1px dashed var(--border)',
              borderRadius: 10,
              color: 'var(--muted)',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'var(--ui)',
            }}
          >
            ⇡ Pick {platform} trade CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.currentTarget.value = '';
            }}
          />
          {upload.isPending && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
              Uploading…
            </div>
          )}
          {upload.isError && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--down)', fontFamily: 'var(--mono)' }}>
              Error: {(upload.error as Error).message}
            </div>
          )}
          {summary && (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                background: 'var(--surface-2)',
                borderRadius: 8,
                fontSize: 12,
                fontFamily: 'var(--mono)',
              }}
            >
              <div>
                {summary.platform}: {summary.imported} imported · {summary.skipped} skipped ·{' '}
                {summary.errors.length} errors
              </div>
              {summary.errors.slice(0, 3).map((e, i) => (
                <div key={i} style={{ color: 'var(--down)', marginTop: 4 }}>
                  row {e.row}: {e.error}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent transactions */}
        <div style={M.section}>Recent transactions</div>
        <div style={{ ...M.card, padding: 0, overflow: 'hidden' }}>
          {!trades || trades.length === 0 ? (
            <div style={M.empty}>No transactions yet.</div>
          ) : (
            trades.slice(0, 20).map((tx, i, arr) => <TxRow key={tx.id} tx={tx} privacy={privacy} last={i === arr.length - 1} />)
          )}
        </div>

        <div style={{ height: 24 }} />
      </div>
    </>
  );
}

function SyncButton({
  label,
  busy,
  disabled,
  onClick,
  msg,
}: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  msg: string | null;
}) {
  return (
    <div style={{ flex: 1 }}>
      <button
        onClick={onClick}
        disabled={busy || disabled}
        style={{
          width: '100%',
          padding: '9px 10px',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          fontWeight: 600,
          border: '1px solid var(--border)',
          borderRadius: 8,
          cursor: busy ? 'wait' : disabled ? 'not-allowed' : 'pointer',
          background: busy ? 'var(--surface-2)' : 'var(--surface)',
          color: busy || disabled ? 'var(--muted)' : 'var(--text)',
          opacity: busy ? 0.7 : disabled ? 0.5 : 1,
        }}
      >
        {label}
      </button>
      {msg && (
        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 4 }}>{msg}</div>
      )}
    </div>
  );
}

const TX_STYLES: Record<string, { bg: string; fg: string; icon: string }> = {
  BUY: { bg: 'color-mix(in oklab, var(--up) 18%, transparent)', fg: 'var(--up)', icon: '↑' },
  SELL: { bg: 'color-mix(in oklab, var(--down) 18%, transparent)', fg: 'var(--down)', icon: '↓' },
  DIV: { bg: 'color-mix(in oklab, var(--accent) 18%, transparent)', fg: 'var(--accent)', icon: '$' },
};

function TxRow({ tx, last }: { tx: TradeRow; privacy: boolean; last: boolean }) {
  const sty = TX_STYLES[tx.side] ?? TX_STYLES.BUY;
  const d = new Date(tx.ts).toISOString().slice(0, 10);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 14px',
        borderBottom: last ? 'none' : '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            background: sty.bg,
            color: sty.fg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {sty.icon}
        </div>
        <div>
          <div style={{ fontSize: 13 }}>
            <span style={{ fontWeight: 500 }}>{tx.side}</span>{' '}
            <span style={{ color: 'var(--muted)' }}>· {tx.symbol}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
            {tx.platform} · {d}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
          {tx.side === 'DIV'
            ? fmtUSD(tx.price_usd)
            : `${tx.qty} × ${fmtUSD(tx.price_usd, { dp: tx.price_usd < 10 ? 3 : 2 })}`}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
          FX {tx.fx_at_trade.toFixed(2)}
        </div>
      </div>
    </div>
  );
}
