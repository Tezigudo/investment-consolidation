// Centralized design tokens. Mirrors the dark-on-dark dashboard
// aesthetic from apps/web/src/styles.css but tuned for native iOS
// (denser tap targets, slightly larger numerals).
export const colors = {
  bg: '#0b0d11',
  bgElevated: '#13171c',
  bgCard: '#171c23',
  border: '#262d36',
  text: '#e7eaf0',
  textMuted: '#9aa3b0',
  textDim: '#6c7480',
  accent: '#60a5fa',
  green: '#34d399',
  red: '#f87171',
  amber: '#fbbf24',
  // Per-platform pill colors. Match the web app's plat-tag classes.
  platform: {
    DIME: '#60a5fa',
    Binance: '#fbbf24',
    Bank: '#9ca3af',
    OnChain: '#34d399',
  } as const,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
};

export const typography = {
  hero: { fontSize: 40, fontWeight: '700' as const, letterSpacing: -1 },
  h1: { fontSize: 24, fontWeight: '700' as const },
  h2: { fontSize: 18, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  bodyMedium: { fontSize: 15, fontWeight: '500' as const },
  caption: { fontSize: 13, fontWeight: '400' as const },
  micro: { fontSize: 11, fontWeight: '500' as const, letterSpacing: 0.5 },
  mono: { fontVariant: ['tabular-nums'] as ['tabular-nums'] },
};
