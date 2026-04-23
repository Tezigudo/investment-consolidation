import type { CSSProperties } from 'react';

export function themeVars(dark: boolean): CSSProperties {
  if (dark) {
    return {
      '--bg': '#0b0c0f',
      '--surface': '#131519',
      '--surface-2': '#1b1e24',
      '--border': '#23262d',
      '--text': '#eef0f3',
      '--muted': '#8b8f97',
      '--muted-2': '#6b7280',
      '--accent': 'oklch(0.78 0.16 150)',
      '--accent-2': 'oklch(0.75 0.14 55)',
      '--up': 'oklch(0.82 0.19 145)',
      '--up-bg': 'color-mix(in oklab, oklch(0.82 0.19 145) 16%, transparent)',
      '--down': 'oklch(0.72 0.19 25)',
      '--down-bg': 'color-mix(in oklab, oklch(0.72 0.19 25) 16%, transparent)',
      '--mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      '--ui': '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    } as CSSProperties;
  }
  return {
    '--bg': '#faf9f6',
    '--surface': '#ffffff',
    '--surface-2': '#f2f0ec',
    '--border': '#e7e4de',
    '--text': '#1a1a1a',
    '--muted': '#6b6b6b',
    '--muted-2': '#9a9a9a',
    '--accent': 'oklch(0.55 0.17 150)',
    '--accent-2': 'oklch(0.62 0.14 55)',
    '--up': 'oklch(0.52 0.19 145)',
    '--up-bg': 'color-mix(in oklab, oklch(0.52 0.19 145) 14%, transparent)',
    '--down': 'oklch(0.58 0.22 25)',
    '--down-bg': 'color-mix(in oklab, oklch(0.58 0.22 25) 14%, transparent)',
    '--mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    '--ui': '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  } as CSSProperties;
}
