import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERIOD_ALL, loadPeriod, periodLabel, periodSince, savePeriod, startOfLocalDay } from './botPeriod';

afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

describe('botPeriod', () => {
  it('since: 7 d y 3 d relativos a ahora, fecha fija y null con «Todo»', () => {
    const now = Date.UTC(2026, 9, 29, 12);
    expect(periodSince({ kind: 'd7' }, now)).toBe(now - 7 * 86400e3);
    expect(periodSince({ kind: 'd3' }, now)).toBe(now - 3 * 86400e3);
    expect(periodSince({ kind: 'since', since: 123 }, now)).toBe(123);
    expect(periodSince(PERIOD_ALL, now)).toBeNull();
  });

  it('startOfLocalDay devuelve el inicio del día local', () => {
    expect(startOfLocalDay('2026-10-25')).toBe(new Date(2026, 9, 25).getTime());
    expect(startOfLocalDay('basura')).toBeNull();
  });

  it('etiquetas: 7 d, 3 d, desde 25 oct y null con «Todo»', () => {
    expect(periodLabel({ kind: 'd7' })).toBe('7 d');
    expect(periodLabel({ kind: 'd3' })).toBe('3 d');
    expect(periodLabel({ kind: 'since', since: new Date(2026, 9, 25).getTime() })).toBe('desde 25 oct');
    expect(periodLabel(PERIOD_ALL)).toBeNull();
  });

  it('se recuerda por bot y sin almacenamiento cae a «Todo»', () => {
    savePeriod(1, { kind: 'd7' });
    savePeriod(2, { kind: 'since', since: 99 });
    expect(loadPeriod(1)).toEqual({ kind: 'd7' });
    expect(loadPeriod(2)).toEqual({ kind: 'since', since: 99 });
    expect(loadPeriod(3)).toEqual(PERIOD_ALL);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('bloqueado'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('bloqueado'); });
    expect(loadPeriod(1)).toEqual(PERIOD_ALL);
    expect(() => savePeriod(1, { kind: 'd3' })).not.toThrow();
  });
});
