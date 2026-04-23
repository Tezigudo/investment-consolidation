import { fmtMoney, fmtPct } from '../lib/format';
import type { Currency } from '@consolidate/shared';

interface Props {
  label: string;
  tag: string;
  value: number;
  pnl: number;
  pct: number;
  primary: boolean;
  privacy: boolean;
  cur: Currency;
}

export function DualHeroCell({ label, tag, value, pnl, pct, primary, privacy, cur }: Props) {
  return (
    <div
      style={{
        padding: '18px 20px',
        background: primary ? 'var(--surface)' : 'var(--surface-2)',
        borderRadius: 14,
        border: `1px solid ${primary ? 'var(--text)' : 'var(--border)'}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>
        <div
          style={{
            fontSize: 9,
            fontFamily: 'var(--mono)',
            color: 'var(--muted)',
            padding: '2px 6px',
            background: 'var(--bg)',
            borderRadius: 4,
            letterSpacing: 0.5,
          }}
        >
          {tag}
        </div>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 30, fontWeight: 400, letterSpacing: -0.8, lineHeight: 1.1 }}>
        {privacy ? '•••••••' : fmtMoney(value, cur, { dp: cur === 'THB' ? 0 : 2 })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
          {fmtMoney(pnl, cur, { sign: true, dp: cur === 'THB' ? 0 : 2 })}
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 3,
            color: pnl >= 0 ? 'var(--up)' : 'var(--down)',
            background: pnl >= 0 ? 'var(--up-bg)' : 'var(--down-bg)',
          }}
        >
          {fmtPct(pct)}
        </div>
      </div>
    </div>
  );
}
