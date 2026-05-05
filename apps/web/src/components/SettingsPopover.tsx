import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getApiUrl, getApiToken, setApiUrl, setApiToken } from '../api/client';

// Tiny gear-button popover for the deployed-app case: lets the user
// paste the API URL + bearer token without a Settings page. Persists
// to localStorage via the api/client helpers; closes on outside click.
export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    setUrl(getApiUrl());
    setToken(getApiToken());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const save = async () => {
    // Always call setters — passing empty string removes the localStorage
    // key so the user can reset to the default /api base or no-auth state.
    setApiUrl(url);
    setApiToken(token);
    setSaved('Saved · refetching…');
    try {
      await qc.invalidateQueries();
      setSaved('Saved ✓');
    } catch {
      setSaved('Saved (refetch error)');
    }
    setTimeout(() => setSaved(null), 2000);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="API URL + auth token"
        style={{
          padding: '4px 8px',
          fontSize: 14,
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: open ? 'var(--surface-2)' : 'var(--surface)',
          color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        ⚙
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 14,
            width: 320,
            zIndex: 50,
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            API URL
          </div>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://consolidate-api.fly.dev"
            spellCheck={false}
            style={{
              width: '100%',
              padding: '6px 8px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              marginBottom: 10,
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            Bearer token
          </div>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste API_AUTH_TOKEN"
            spellCheck={false}
            style={{
              width: '100%',
              padding: '6px 8px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              marginBottom: 12,
            }}
          />
          <button
            onClick={save}
            style={{
              padding: '6px 12px',
              background: 'var(--accent)',
              color: 'var(--bg)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            Save
          </button>
          {saved && (
            <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--muted)' }}>{saved}</span>
          )}
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
            Stored in browser localStorage. Leave URL blank to reset to default (/api in dev, VITE_API_URL in prod). Leave token blank to remove auth.
          </div>
        </div>
      )}
    </div>
  );
}
