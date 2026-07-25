import { describe, it, expect } from 'vitest';
import { fmtGateValue, gateLabel, gateLabelShort, pickMobileValues, MOBILE_VALUE_KEYS } from './gates';

describe('supertrend gate rendering', () => {
  it('renders SOL-scale prices as dollars, not toFixed(4)', () => {
    expect(fmtGateValue('close', 74.14)).toBe('$74.14');
    expect(fmtGateValue('st_line', 77.15166281749242)).toBe('$77.15');
    expect(fmtGateValue('would_sl_price', 72.39447225610432)).toBe('$72.39');
    expect(fmtGateValue('would_tp_price', 82.8676387194784)).toBe('$82.87');
  });
  it('keeps BTC-scale prices comma-formatted with no cents', () => {
    expect(fmtGateValue('close', 64098)).toBe('$64,098');
    expect(fmtGateValue('upper_80bar', 66648)).toBe('$66,648');
  });
  it('spells out the direction flag instead of -1.0000', () => {
    expect(fmtGateValue('st_dir', -1)).toBe('↓ down (−1)');
    expect(fmtGateValue('st_dir_prev', 1)).toBe('↑ up (+1)');
  });
  it('formats already-percent values without double-scaling', () => {
    expect(fmtGateValue('dist_to_flip_pct', 4.062129508352341)).toBe('+4.06%');
    expect(fmtGateValue('atr_pct', 1.177183533784516)).toBe('1.18%');
  });
  it('renders counts as integers and booleans as words', () => {
    expect(fmtGateValue('bars_since_flip', 5)).toBe('5');
    expect(fmtGateValue('shorts_enabled', true)).toBe('yes');
  });
  it('does not regress the other strategies formatters', () => {
    expect(fmtGateValue('rsi', 34.5)).toBe('34.5');
    expect(fmtGateValue('slope', 0.000371)).toBe('0.04%');
    expect(fmtGateValue('vol_ratio', 1.5)).toBe('1.50×');
    expect(fmtGateValue('atr', 0.8727)).toBe('0.87');
  });
  it('labels the new keys instead of falling back to snake_case', () => {
    expect(gateLabel('st_flip_up')).toBe('Supertrend flipped UP this bar');
    expect(gateLabel('st_dir_prev')).toBe('Direction, previous bar');
    expect(gateLabel('totally_unknown_key')).toBe('totally_unknown_key');
  });
});

describe('mobile value picker', () => {
  it('puts prev BEFORE now so "prev ↓ / now ↓" reads left-to-right', () => {
    const picked = pickMobileValues({ st_dir: -1, st_dir_prev: -1, close: 74.14 });
    expect(picked.map(([k]) => k).slice(0, 2)).toEqual(['st_dir_prev', 'st_dir']);
  });
  it('skips absent and null keys', () => {
    const picked = pickMobileValues({ st_dir: -1, st_line: null, rsi: undefined });
    expect(picked.map(([k]) => k)).toEqual(['st_dir']);
  });
  it('caps rows so a big values payload cannot blow up the phone card', () => {
    const many = Object.fromEntries(MOBILE_VALUE_KEYS.map((k) => [k, 1]));
    expect(pickMobileValues(many).length).toBe(6);
    expect(pickMobileValues(many, 3).length).toBe(3);
  });
  it('is empty for a missing values map', () => {
    expect(pickMobileValues(null)).toEqual([]);
    expect(pickMobileValues(undefined)).toEqual([]);
  });
  it('short labels fit a phone row', () => {
    expect(gateLabelShort('st_dir_prev')).toBe('prev');
    expect(gateLabelShort('st_dir')).toBe('now');
    expect(gateLabelShort('dist_to_flip_pct')).toBe('to flip');
    // falls back to the long label, then the raw key
    expect(gateLabelShort('st_flip_up')).toBe('Supertrend flipped UP this bar');
    expect(gateLabelShort('nope_unknown')).toBe('nope_unknown');
  });
});
