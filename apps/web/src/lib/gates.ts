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
  rsi_oversold: 'RSI oversold (<35)', // snapback params.yaml rsi_long_threshold=35 since 2026-05-29
  rsi_overbought: 'RSI overbought (>70)',
  trend_up: 'Close > EMA(200)',
  trend_down: 'Close < EMA(200)',
  volume_spike: 'Volume > 2× SMA(20)',
  funding_ok: 'Funding not extreme',
  breakout_above_80bar: 'Close > 80-bar high',
  breakdown_below_80bar: 'Close < 80-bar low',
  slope_up: 'EMA-slope ≥ +3%',
  slope_down: 'EMA-slope ≤ −3%',
  // cnh-hybrid-short-v1 (DT + ICnH on 4h)
  pattern_admitted_this_bar: 'Pattern admitted (DT or ICnH)',
  tp_slot_below_entry: 'EMA(100) below close (TP slot)',
  icnh_lookback_ema_xd: 'EMA24 cross-down within lookback',
  // supertrend (SOL, native 4h). Entry fires only on the FLIP bar, so both
  // gates read ✗ whenever the trend simply continues — that is the normal
  // resting state, not a stall.
  st_flip_up: 'Supertrend flipped UP this bar',
  st_flip_down: 'Supertrend flipped DOWN this bar',
  // …and the value/threshold keys, which shared the same raw-key fallback.
  st_dir: 'Supertrend direction',
  st_dir_prev: 'Direction, previous bar',
  st_line: 'Supertrend band (flip level)',
  dist_to_flip_pct: 'Distance to flip',
  atr_pct: 'ATR as % of price',
  bars_since_flip: 'Bars since last flip',
  would_sl_price: 'SL if it fired now',
  would_tp_price: 'TP if it fired now',
  st_period: 'Supertrend period',
  st_multiplier: 'Supertrend multiplier',
  sl_atr: 'Stop (× ATR)',
  tp_atr: 'Target (× ATR)',
  shorts_enabled: 'Shorts enabled',
};

// Value keys that are PRICES. Needed because the generic formatter only adds a
// `$` above 1000 (fine for BTC, wrong for SOL at ~$74 — it fell through to
// toFixed(4) and rendered "74.0900").
const PRICE_KEYS = new Set([
  'close', 'st_line', 'would_sl_price', 'would_tp_price',
  'upper_80bar', 'lower_80bar',
]);
// Value keys already expressed in percent (do NOT multiply by 100 again).
// Split by whether the SIGN carries information: distance-to-flip is signed
// (+ = band above price, − = below), whereas ATR is always positive so a
// leading "+" would just be noise.
const SIGNED_PCT_KEYS = new Set(['dist_to_flip_pct']);
const PCT_KEYS = new Set(['atr_pct']);
// Value keys that are counts — no decimals.
const INT_KEYS = new Set(['bars_since_flip', 'st_period']);

export function gateLabel(key: string): string {
  return GATE_LABELS[key] ?? key;
}

// Short labels for the phone. The desktop card has room for "Supertrend band
// (flip level)"; a 375px-wide PWA row does not.
const GATE_LABELS_SHORT: Record<string, string> = {
  st_dir_prev: 'prev',
  st_dir: 'now',
  st_line: 'flip at',
  dist_to_flip_pct: 'to flip',
  bars_since_flip: 'bars held',
  atr_pct: 'ATR',
  would_sl_price: 'SL',
  would_tp_price: 'TP',
  upper_80bar: '80b high',
  lower_80bar: '80b low',
  trend_ema: 'EMA200',
  vol_ratio: 'vol',
  funding_rate: 'funding',
};

export function gateLabelShort(key: string): string {
  return GATE_LABELS_SHORT[key] ?? GATE_LABELS[key] ?? key;
}

// Which `values` entries the mobile/PWA card shows, in priority order. The
// desktop card renders every value; a phone cannot, so this is a curated
// shortlist — only keys actually present in the payload are rendered, so one
// list serves every strategy and a new leg degrades gracefully instead of
// blowing up the layout.
//
// `st_dir_prev` is listed BEFORE `st_dir` on purpose: reading "prev ↓ / now ↓"
// left-to-right is how you see at a glance that nothing flipped, which is the
// whole question the supertrend card has to answer.
export const MOBILE_VALUE_KEYS: readonly string[] = [
  'st_dir_prev', 'st_dir', 'dist_to_flip_pct', 'st_line', 'bars_since_flip',
  'rsi', 'close', 'upper_80bar', 'lower_80bar', 'slope',
  'atr_pct', 'vol_ratio', 'funding_rate',
];

/** Pick the mobile-visible subset of a GateStatus `values` map, in priority
 *  order, skipping absent/null keys. `max` caps the rows so a strategy with a
 *  large values payload can't push the phone card arbitrarily tall. */
export function pickMobileValues(
  values: Record<string, unknown> | null | undefined,
  max = 6,
): [string, unknown][] {
  if (!values) return [];
  const out: [string, unknown][] = [];
  for (const k of MOBILE_VALUE_KEYS) {
    if (out.length >= max) break;
    const v = values[k];
    if (v === undefined || v === null) continue;
    out.push([k, v]);
  }
  return out;
}

// Formats a GateStatus value field for display. Per-key formatting because
// rsi is a 0-100 scalar, vol_ratio is a multiple, funding/slope are
// fractions that read better as percentages, and prices are dollar amounts.
//
// Runtime `v` may not be numeric — the cnh-hybrid-short-v1 strategy includes
// `last_admitted_pattern` (dict) and `pattern_fired` (string) inside its
// values payload. Defensive type-check so we never call `.toFixed` on a
// non-number and crash the whole card.
export function fmtGateValue(k: string, v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      // Truncate so a multi-field admitted-pattern dict can't push the values
      // column arbitrarily wide. 60 chars fits the dashboard layout.
      return s.length > 60 ? s.slice(0, 57) + '…' : s;
    } catch { return String(v); }
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v !== 'number' || Number.isNaN(v)) return String(v);
  // Supertrend direction is a ±1 flag, not a measurement — "-1.0000" told the
  // reader nothing. Spell it out.
  if (k === 'st_dir' || k === 'st_dir_prev') {
    if (v > 0) return '↑ up (+1)';
    if (v < 0) return '↓ down (−1)';
    return 'flat (0)';
  }
  if (k === 'rsi') return v.toFixed(1);
  if (k === 'vol_ratio') return `${v.toFixed(2)}×`;
  if (k === 'funding_rate') return `${(v * 100).toFixed(4)}%`;
  if (k === 'slope') return `${(v * 100).toFixed(2)}%`;
  if (SIGNED_PCT_KEYS.has(k)) return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  if (PCT_KEYS.has(k)) return `${v.toFixed(2)}%`;
  if (INT_KEYS.has(k)) return v.toFixed(0);
  if (k === 'atr') return v.toFixed(2);
  if (PRICE_KEYS.has(k)) {
    // 2dp under $1000 (SOL ~$74.14), no cents above it (BTC ~$64,098).
    return Math.abs(v) >= 1000
      ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : `$${v.toFixed(2)}`;
  }
  if (Math.abs(v) >= 1000) {
    return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  // Trailing zeros on a 4dp default read as false precision; trim them.
  return String(Number(v.toFixed(4)));
}
