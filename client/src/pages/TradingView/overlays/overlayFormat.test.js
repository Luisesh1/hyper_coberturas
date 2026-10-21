import { describe, it, expect } from 'vitest';
import { formatAgo, formatCandleTime, formatOverlayPct, formatOverlayValue } from './overlayFormat';

describe('overlayFormat', () => {
  it('valores según magnitud y prima en USD', () => {
    expect(formatOverlayValue(110954.2)).toBe('110,954');
    expect(formatOverlayValue(2426.43)).toBe('2,426.4');
    expect(formatOverlayValue(17.42, { usd: true })).toBe('$17.42');
    expect(formatOverlayValue(0.5123)).toBe('0.5123');
    expect(formatOverlayValue(null)).toBe('—');
  });
  it('porcentajes con signo; sin signo si redondea a cero', () => {
    expect(formatOverlayPct(9.23)).toBe('+9.2 %');
    expect(formatOverlayPct(-0.6)).toBe('−0.6 %');
    expect(formatOverlayPct(-0.0001)).toBe('0.00 %');
    expect(formatOverlayPct(null)).toBe('');
  });
  it('antigüedad y hora de vela en UTC', () => {
    expect(formatAgo(3)).toBe('3 h');
    expect(formatAgo(0.25)).toBe('15 min');
    expect(formatCandleTime(Date.UTC(2026, 9, 16, 3) / 1000, '1h')).toBe('16 oct 03:00 · vela 1h');
    expect(formatCandleTime(Date.UTC(2026, 9, 16) / 1000, '1d')).toBe('16 oct 2026 · vela 1D');
  });
});
