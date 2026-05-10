import { useState } from 'react';
import { usePortfolio } from '../hooks/usePortfolio';
import { Toast } from '../components/Toast';
import { Overview } from './mobile/Overview';
import { Holdings } from './mobile/Holdings';
import { Activity } from './mobile/Activity';
import { Settings } from './mobile/Settings';
import { PositionSheet } from './mobile/PositionSheet';
import { M } from './mobile/styles';
import type { Currency, EnrichedPosition } from '@consolidate/shared';

type Tab = 'overview' | 'holdings' | 'activity' | 'settings';
export type CostView = 'standard' | 'dime';

interface Props {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  dark: boolean;
  setDark: (d: boolean) => void;
  privacy: boolean;
  setPrivacy: (p: boolean) => void;
}

export function MobileShell(props: Props) {
  const { currency, setCurrency, dark, setDark, privacy, setPrivacy } = props;
  const [tab, setTab] = useState<Tab>('overview');
  const [costView, setCostView] = useState<CostView>('standard');
  const [selected, setSelected] = useState<EnrichedPosition | null>(null);

  const { data, isLoading, error } = usePortfolio();
  const errMsg = error ? (error as Error).message : null;
  const is401 = errMsg ? /\b401\b/.test(errMsg) : false;

  const body = (() => {
    if (isLoading || (!data && !error)) return <SkeletonScreen />;
    if (error || !data) return <ErrorScreen onSettings={() => setTab('settings')} />;
    switch (tab) {
      case 'overview':
        return (
          <Overview
            data={data}
            currency={currency}
            setCurrency={setCurrency}
            privacy={privacy}
            setPrivacy={setPrivacy}
          />
        );
      case 'holdings':
        return (
          <Holdings
            data={data}
            currency={currency}
            privacy={privacy}
            costView={costView}
            setCostView={setCostView}
            onSelect={setSelected}
          />
        );
      case 'activity':
        return <Activity privacy={privacy} />;
      case 'settings':
        return (
          <Settings
            currency={currency}
            setCurrency={setCurrency}
            dark={dark}
            setDark={setDark}
            privacy={privacy}
            setPrivacy={setPrivacy}
          />
        );
    }
  })();

  return (
    <div style={M.page}>
      {body}
      <TabBar tab={tab} setTab={setTab} />
      {selected && data && (
        <PositionSheet
          position={selected}
          currency={currency}
          usdthb={data.fx.usdthb}
          costView={costView}
          onClose={() => setSelected(null)}
        />
      )}
      {errMsg && (
        <Toast
          tone={is401 ? 'warn' : 'error'}
          title={is401 ? 'Sign in needed' : 'API error'}
          message={
            is401
              ? 'Open Settings (bottom-right tab) and paste your bearer token.'
              : `${errMsg}. Check the API URL in Settings.`
          }
        />
      )}
    </div>
  );
}

function SkeletonScreen() {
  return (
    <div style={{ padding: '20px 14px' }}>
      <div style={{ ...M.card, height: 140, opacity: 0.55, marginBottom: 12 }} />
      <div style={{ ...M.card, height: 90, opacity: 0.45, marginBottom: 12 }} />
      <div style={{ ...M.card, height: 200, opacity: 0.4 }} />
    </div>
  );
}

function ErrorScreen({ onSettings }: { onSettings: () => void }) {
  return (
    <div style={{ padding: '40px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 16 }}>
        Couldn't load portfolio.
      </div>
      <button
        onClick={onSettings}
        style={{
          padding: '8px 16px',
          background: 'var(--accent)',
          color: 'var(--bg)',
          border: 'none',
          borderRadius: 8,
          fontWeight: 600,
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Open Settings
      </button>
    </div>
  );
}

const TAB_DEFS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'holdings', label: 'Holdings', icon: 'holdings' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <nav style={tabBarStyles.bar}>
      {TAB_DEFS.map((t) => {
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={active ? 'page' : undefined}
            style={{
              ...tabBarStyles.btn,
              color: active ? 'var(--text)' : 'var(--muted)',
            }}
          >
            <TabIcon name={t.icon} active={active} />
            <span style={{ fontSize: 10, marginTop: 2, fontWeight: active ? 600 : 500 }}>
              {t.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function TabIcon({ name, active }: { name: string; active: boolean }) {
  const stroke = active ? 'var(--accent)' : 'currentColor';
  const fill = active ? 'color-mix(in oklab, var(--accent) 22%, transparent)' : 'none';
  const props = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke,
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'overview':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" fill={fill} />
          <path d="M12 3 V12 L19 14" />
        </svg>
      );
    case 'holdings':
      return (
        <svg {...props}>
          <rect x="3" y="5" width="18" height="3.5" rx="1" fill={fill} />
          <rect x="3" y="10.5" width="18" height="3.5" rx="1" fill={fill} />
          <rect x="3" y="16" width="18" height="3.5" rx="1" fill={fill} />
        </svg>
      );
    case 'activity':
      return (
        <svg {...props}>
          <path d="M3 12 H7 L10 5 L14 19 L17 12 H21" fill={fill} />
        </svg>
      );
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" fill={fill} />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
}

const tabBarStyles = {
  bar: {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    background: 'color-mix(in oklab, var(--bg) 95%, transparent)',
    backdropFilter: 'blur(14px)',
    borderTop: '1px solid var(--border)',
    paddingBottom: 'env(safe-area-inset-bottom)',
    zIndex: 100,
  },
  btn: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0,
    padding: '10px 0 8px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--ui)',
  },
} satisfies Record<string, React.CSSProperties>;
