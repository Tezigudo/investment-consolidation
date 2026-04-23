import type { Currency } from '@consolidate/shared';

interface Props {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  lastSyncMs: number;
}

export function TopBar({ currency, setCurrency, lastSyncMs }: Props) {
  const relative = lastSyncMs ? new Date(lastSyncMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—';
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
