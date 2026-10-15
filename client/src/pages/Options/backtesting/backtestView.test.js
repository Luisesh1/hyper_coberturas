import { describe, expect, it } from 'vitest';
import {
  buildBacktestPayload, buildMetrics, cyclesToCsv, defaultForm, formatLegs, sourceAvailable, validateBacktestForm,
} from './backtestView';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const strategies = [{ id: 1, name: 'Strangle semanal BTC', underlying: 'BTC' }];
const templates = [{ id: 'short_strangle', label: 'Strangle corto', paramSchema: [{ key: 'deltaTarget', type: 'number', min: 0.05, max: 0.5 }] }];

describe('backtestView', () => {
  it('DVOL sólo para BTC y ETH', () => {
    expect(sourceAvailable('dvol', 'BTC')).toBe(true);
    expect(sourceAvailable('dvol', 'eth')).toBe(true);
    expect(sourceAvailable('dvol', 'SOL')).toBe(false);
    expect(sourceAvailable('realized', 'SOL')).toBe(true);
  });

  it('payload con estrategia guardada: fechas en ms UTC (inicio/fin de día) y sin prima de vol fuera de realized', () => {
    const form = { ...defaultForm({ now: NOW }), selection: 's:1', from: '2025-10-01', to: '2026-10-01' };
    expect(buildBacktestPayload(form)).toEqual({
      strategyId: 1,
      underlying: 'BTC',
      from: Date.parse('2025-10-01T00:00:00Z'),
      to: Date.parse('2026-10-01T23:59:59.999Z'),
      capitalUsdt: 5000,
      source: 'dvol',
      spreadPct: 3,
      feePct: 0.03,
    });
  });

  it('payload con plantilla + parámetros y fuente realized', () => {
    const form = {
      ...defaultForm({ now: NOW, underlying: 'SOL' }),
      selection: 't:short_strangle',
      params: { deltaTarget: 0.2 },
      source: 'realized',
      volPremiumPct: 15,
    };
    const p = buildBacktestPayload(form);
    expect(p).toMatchObject({ template: 'short_strangle', params: { deltaTarget: 0.2 }, underlying: 'SOL', source: 'realized', volPremiumPct: 15 });
    expect(p.strategyId).toBeUndefined();
  });

  it('valida selección, fechas, capital, fuente y parámetros', () => {
    const base = defaultForm({ now: NOW });
    expect(validateBacktestForm({ ...base, selection: '' }, { strategies, templates, now: NOW }).selection).toBeTruthy();
    expect(validateBacktestForm({ ...base, selection: 's:1', from: '2026-05-01', to: '2026-04-01' }, { strategies, templates, now: NOW }).to)
      .toBe('Debe ser posterior a «Desde»');
    expect(validateBacktestForm({ ...base, selection: 's:1', to: '2027-01-01' }, { strategies, templates, now: NOW }).to).toBe('No puede ser futura');
    expect(validateBacktestForm({ ...base, selection: 's:1', capitalUsdt: 0 }, { strategies, templates, now: NOW }).capitalUsdt).toBeTruthy();
    expect(validateBacktestForm({ ...base, selection: 's:1', underlying: 'XRP', source: 'dvol' }, { strategies, templates, now: NOW }).source)
      .toBe('DVOL solo existe para BTC y ETH');
    expect(validateBacktestForm({ ...base, selection: 't:short_strangle', params: { deltaTarget: 2 } }, { strategies, templates, now: NOW }).params)
      .toEqual({ deltaTarget: 'Máximo 0,5' });
    expect(validateBacktestForm({ ...base, selection: 's:1' }, { strategies, templates, now: NOW })).toEqual({});
  });

  it('métricas con signo y drawdown negativo', () => {
    const m = buildMetrics({ returnPct: 38.2, pnlUsdt: 1910, maxDrawdownPct: 14.6, sharpe: 1.41, wins: 41, cycles: 52, premiumUsdt: 9840, worstCycleUsdt: -612 });
    expect(m.map((x) => x.value)).toEqual(['+38,2 %', '+1.910,00 USDT', '−14,6 %', '1,41', '41 / 52', '9.840 USDT', '−612 USDT']);
    const oldRun = buildMetrics({ returnPct: -2 }, { capitalUsdt: 5000, equity: [{ strategy: 4900 }] });
    expect(oldRun.find((x) => x.key === 'pnlUsdt').value).toBe('−100,00 USDT');
  });

  it('patas abreviadas y CSV con cabecera y comillas', () => {
    expect(formatLegs([{ side: 'SELL', symbol: 'BTC-261003-70000-C' }, { side: 'SELL', strike: 62000, type: 'put' }])).toBe('V 70000-C · V 62000-P');
    const csv = cyclesToCsv([
      { openedAt: Date.parse('2026-09-26T08:15:00Z'), expiry: Date.parse('2026-10-03T08:00:00Z'), legs: 'V 70000-C · V 62000-P', premiumUsdt: 238.1, exitReason: 'Toma de ganancia, 50 %', pnlUsdt: 119.05 },
    ]);
    const [header, row] = csv.split('\n');
    expect(header).toBe('apertura,vencimiento,patas,prima_usdt,salida,pnl_usdt');
    expect(row).toBe('2026-09-26T08:15:00.000Z,2026-10-03T08:00:00.000Z,V 70000-C · V 62000-P,238.1,"Toma de ganancia, 50 %",119.05');
  });
});

describe('exitReasonLabel', () => {
  it('traduce los códigos del motor y deja pasar texto libre', async () => {
    const { normalizeCycles } = await import('./backtestView');
    const rows = normalizeCycles([{ exitReason: 'take_profit' }, { exitReason: 'expiry' }, { exitReason: 'Texto libre' }]);
    expect(rows.map((r) => r.exitReason)).toEqual(['Toma de ganancia', 'Vencimiento', 'Texto libre']);
  });
});
