import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  clearApiToken,
  clearApiUrl,
  getApiUrl,
  getStoredApiToken,
  getStoredApiUrl,
  setApiToken,
  setApiUrl,
} from '../../api/client';
import { M } from './styles';
import type { Currency } from '@consolidate/shared';

interface Props {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  dark: boolean;
  setDark: (d: boolean) => void;
  privacy: boolean;
  setPrivacy: (p: boolean) => void;
}

export function Settings({ currency, setCurrency, dark, setDark, privacy, setPrivacy }: Props) {
  const qc = useQueryClient();
  const [apiUrlInput, setApiUrlInput] = useState(getStoredApiUrl());
  const [apiTokenInput, setApiTokenInput] = useState(getStoredApiToken());
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Re-read on mount in case the tab is opened after being elsewhere.
  useEffect(() => {
    setApiUrlInput(getStoredApiUrl());
    setApiTokenInput(getStoredApiToken());
  }, []);

  const save = () => {
    const url = apiUrlInput.trim();
    const token = apiTokenInput.trim();
    if (url) setApiUrl(url);
    else clearApiUrl();
    if (token) setApiToken(token);
    else clearApiToken();
    setSavedMsg('Saved · refetching…');
    qc.invalidateQueries();
    setTimeout(() => setSavedMsg(null), 2000);
  };

  return (
    <>
      <header style={M.header}>
        <div style={M.title}>Settings</div>
      </header>

      <div style={M.scroll}>
        <SettingRow label="Currency">
          <div style={M.segGroup}>
            {(['USD', 'THB', 'USDT'] as Currency[]).map((c) => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                style={{ ...M.segBtn, ...(currency === c ? M.segBtnActive : {}) }}
              >
                {c}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="Theme">
          <div style={M.segGroup}>
            <button
              onClick={() => setDark(true)}
              style={{ ...M.segBtn, ...(dark ? M.segBtnActive : {}) }}
            >
              Dark
            </button>
            <button
              onClick={() => setDark(false)}
              style={{ ...M.segBtn, ...(!dark ? M.segBtnActive : {}) }}
            >
              Light
            </button>
          </div>
        </SettingRow>

        <SettingRow label="Privacy mode" sub="Mask numbers when shoulder-surfing">
          <div style={M.segGroup}>
            <button
              onClick={() => setPrivacy(true)}
              style={{ ...M.segBtn, ...(privacy ? M.segBtnActive : {}) }}
            >
              On
            </button>
            <button
              onClick={() => setPrivacy(false)}
              style={{ ...M.segBtn, ...(!privacy ? M.segBtnActive : {}) }}
            >
              Off
            </button>
          </div>
        </SettingRow>

        <div style={M.section}>API connection</div>
        <div style={{ ...M.card, padding: '14px 14px' }}>
          <div style={{ ...M.eyebrow, marginBottom: 4 }}>API URL</div>
          <input
            type="url"
            value={apiUrlInput}
            onChange={(e) => setApiUrlInput(e.target.value)}
            placeholder={getApiUrl()}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            style={inputStyle}
          />
          <div style={{ ...M.eyebrow, marginTop: 12, marginBottom: 4 }}>Bearer token</div>
          <input
            type="password"
            value={apiTokenInput}
            onChange={(e) => setApiTokenInput(e.target.value)}
            placeholder="paste API_AUTH_TOKEN"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            style={inputStyle}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <button onClick={save} style={primaryBtn}>
              Save
            </button>
            {savedMsg && (
              <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{savedMsg}</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 14 }}>
            Currently calling: {getApiUrl()}
          </div>
        </div>

        <div style={M.section}>About</div>
        <div style={{ ...M.card, padding: '14px 14px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          Consolidate · personal investing dashboard.
          <br />
          DIME, Binance, on-chain (World Chain) and THB cash, with true-baht PNL.
          <br />
          Add to Home Screen from Safari to install as an app.
        </div>

        <div style={{ height: 24 }} />
      </div>
    </>
  );
}

function SettingRow({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        ...M.card,
        marginTop: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {sub && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 11px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  boxSizing: 'border-box',
};

const primaryBtn: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--accent)',
  color: 'var(--bg)',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  fontFamily: 'var(--ui)',
};
