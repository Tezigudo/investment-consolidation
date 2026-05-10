interface Props {
  tone?: 'error' | 'warn' | 'info';
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

export function Toast({ tone = 'info', title, message, actionLabel, onAction, onDismiss }: Props) {
  const accent =
    tone === 'error' ? 'var(--down)' : tone === 'warn' ? '#d4a017' : 'var(--accent)';
  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(16px + env(safe-area-inset-top))',
        right: 16,
        zIndex: 100,
        background: 'var(--surface)',
        border: `1px solid var(--border)`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 8,
        padding: '12px 14px',
        minWidth: 280,
        maxWidth: 380,
        boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
      role="alert"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        {title && (
          <div style={{ fontSize: 12, fontWeight: 600, color: accent, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {title}
          </div>
        )}
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              padding: 0,
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4 }}>{message}</div>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          style={{
            alignSelf: 'flex-start',
            marginTop: 4,
            padding: '4px 10px',
            background: accent,
            color: 'var(--bg)',
            border: 'none',
            borderRadius: 5,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
