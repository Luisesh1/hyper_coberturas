import { describe, expect, it } from 'vitest';
import { avgHoldText, bestRows, buildGrid, coverageText, defaultStop, nearestCell } from './exitSimulator';

const sc = (tpPct, maxHoldHours, stopPct, pnlUsdt, extra = {}) => ({ tpPct, maxHoldHours, stopPct, pnlUsdt, trades: 4, wins: 3, avgHoldMinutes: 90, incomplete: 0, ...extra });

describe('exitSimulator', () => {
  it('formatea cobertura y filas de mejores combinaciones', () => {
    expect(coverageText({ positions: 12, minute: 5, hourly: 4, none: 3 })).toBe('12 operaciones · 5 con datos por minuto · 4 solo horarios · 3 sin datos');
    const [r] = bestRows({ best: [sc(80, 6, 50, 12.5), sc(null, null, null, -3)] });
    expect(r).toMatchObject({ tp: '+80 %', hold: '6 h', stop: '−50 %', hits: '3/4', avgHold: '1,5 h' });
    expect(r.pnl).toBe('+12,50 USDT');
    expect(bestRows({ best: [sc(null, null, null, -3)] })[0]).toMatchObject({ tp: 'Sin TP', hold: 'sin', stop: 'sin' });
    expect(avgHoldText(30)).toBe('30 min');
  });

  it('arma el mapa del stop elegido, con null al final', () => {
    const scenarios = [sc(20, 1, null, 5), sc(20, null, null, -10), sc(null, 1, null, 2), sc(20, 1, 30, 99)];
    const g = buildGrid(scenarios, null);
    expect(g.tps).toEqual([20, null]);
    expect(g.holds).toEqual([1, null]);
    expect(g.rows[0].cells[1]).toMatchObject({ pnl: -10, sign: 'neg', intensity: 1 });
    expect(g.rows[0].cells[0].intensity).toBe(0.5);
    expect(buildGrid(scenarios, 30).rows[0].cells[0].pnl).toBe(99);
  });

  it('marca la celda más cercana solo con TP fijo', () => {
    const g = buildGrid([sc(60, 4, null, 1), sc(80, 4, null, 1), sc(80, 6, null, 1), sc(60, 6, null, 1)], null);
    expect(nearestCell({ takeProfitMode: 'fixed', takeProfitPct: 75, maxHoldMinutes: 330 }, g)).toEqual({ tp: 80, hold: 6 });
    expect(nearestCell({ takeProfitMode: 'atr_band', takeProfitPct: 75 }, g)).toBeNull();
    expect(nearestCell({ takeProfitMode: 'volatility' }, g)).toBeNull();
    expect(defaultStop({ stopLossPct: 45 })).toBe(50);
    expect(defaultStop({})).toBeNull();
  });
});
