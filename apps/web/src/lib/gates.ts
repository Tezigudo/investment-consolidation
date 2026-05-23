// Display helpers for the bot's GateStatus payload. Shared between the
// desktop BotStatusCard and the mobile BotStatusMobile so the two views
// can't drift on gate labels or value formatting — same pattern as
// lib/bots.ts for BOT_SOURCES.
//
// Adding a new strategy with new gate names only requires:
//   1. The bot pushes the new gate keys in its heartbeat payload
//   2. Optionally, add a friendlier label here for each key
// Unknown keys fall through to the raw snake_case key so the dashboard
// still shows something useful even before this map is updated.

export const GATE_LABELS: Record<string, string> = {
  rsi_oversold: 'RSI oversold (<40)',
  rsi_overbought: 'RSI overbought (>70)',
  trend_up: 'Close > EMA(200)',
  trend_down: 'Close < EMA(200)',
  volume_spike: 'Volume > 2× SMA(20)',
  funding_ok: 'Funding not extreme',
  breakout_above_80bar: 'Close > 80-bar high',
  breakdown_below_80bar: 'Close < 80-bar low',
  slope_up: 'EMA-slope ≥ +3%',
  slope_down: 'EMA-slope ≤ −3%',
};

export function gateLabel(key: string): string {
  return GATE_LABELS[key] ?? key;
}

// Formats a GateStatus value field for display. Per-key formatting because
// rsi is a 0-100 scalar, vol_ratio is a multiple, funding/slope are
// fractions that read better as percentages, and prices are dollar amounts.
export function fmtGateValue(k: string, v: number | null): string {
  if (v == null) return '—';
  if (k === 'rsi') return v.toFixed(1);
  if (k === 'vol_ratio') return `${v.toFixed(2)}×`;
  if (k === 'funding_rate') return `${(v * 100).toFixed(4)}%`;
  if (k === 'slope') return `${(v * 100).toFixed(2)}%`;
  if (Math.abs(v) >= 1000) {
    return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return v.toFixed(4);
}
