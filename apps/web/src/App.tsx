import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dashboard } from './views/Dashboard';
import { themeVars } from './lib/theme';
import {
  getApiUrl,
  getStoredApiUrl,
  getStoredApiToken,
  setApiUrl,
  setApiToken,
  clearApiUrl,
  clearApiToken,
} from './api/client';
import type { Currency } from '@consolidate/shared';

const KEY = 'consolidate.prefs.v1';

interface Prefs {
  currency: Currency;
  dark: boolean;
  privacy: boolean;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { currency: 'THB', dark: true, privacy: false, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { currency: 'THB', dark: true, privacy: false };
}

export function App() {
  const init = loadPrefs();
  const [currency, setCurrency] = useState<Currency>(init.currency);
  const [dark, setDark] = useState(init.dark);
  const [privacy, setPrivacy] = useState(init.privacy);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [apiUrlInput, setApiUrlInput] = useState(getStoredApiUrl());
  const [apiTokenInput, setApiTokenInput] = useState(getStoredApiToken());
  const [apiSavedMsg, setApiSavedMsg] = useState<string | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify({ currency, dark, privacy }));
  }, [currency, dark, privacy]);

  useEffect(() => {
    if (tweaksOpen) {
      setApiUrlInput(getStoredApiUrl());
      setApiTokenInput(getStoredApiToken());
    }
  }, [tweaksOpen]);

  const saveApiSettings = () => {
    const url = apiUrlInput.trim();
    const token = apiTokenInput.trim();
    if (url) setApiUrl(url); else clearApiUrl();
    if (token) setApiToken(token); else clearApiToken();
    setApiSavedMsg('Saved · refetching…');
    qc.invalidateQueries();
    setTimeout(() => setApiSavedMsg(null), 2000);
  };

  return (
    <div style={{ ...themeVars(dark), minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      <Dashboard currency={currency} setCurrency={setCurrency} privacy={privacy} />

      {tweaksOpen && (
        <div className="tweaks-panel" style={themeVars(dark)}>
          <div className="t-title">Tweaks</div>
          <div className="t-row">
            <span>Currency</span>
            <div className="t-seg">
              {(['USD', 'THB', 'USDT'] as Currency[]).map((c) => (
                <button key={c} data-active={currency === c} onClick={() => setCurrency(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="t-row">
            <span>Theme</span>
            <div className="t-seg">
              <button data-active={dark} onClick={() => setDark(true)}>
                Dark
              </button>
              <button data-active={!dark} onClick={() => setDark(false)}>
                Light
              </button>
            </div>
          </div>
          <div className="t-row">
            <span>Privacy</span>
            <div className="t-seg">
              <button data-active={privacy} onClick={() => setPrivacy(true)}>
                On
              </button>
              <button data-active={!privacy} onClick={() => setPrivacy(false)}>
                Off
              </button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              API URL
            </div>
            <input
              type="url"
              value={apiUrlInput}
              onChange={(e) => setApiUrlInput(e.target.value)}
              placeholder={getApiUrl()}
              spellCheck={false}
              style={{
                width: '100%',
                padding: '6px 8px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                marginBottom: 8,
                boxSizing: 'border-box',
              }}
            />
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Bearer token
            </div>
            <input
              type="password"
              value={apiTokenInput}
              onChange={(e) => setApiTokenInput(e.target.value)}
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
                fontSize: 11,
                marginBottom: 10,
                boxSizing: 'border-box',
              }}
            />
            <button
              onClick={saveApiSettings}
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
            {apiSavedMsg && (
              <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--muted)' }}>{apiSavedMsg}</span>
            )}
          </div>
        </div>
      )}

      <button className="gear-btn" onClick={() => setTweaksOpen((o) => !o)} title="Tweaks" aria-label="Tweaks">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  );
}
