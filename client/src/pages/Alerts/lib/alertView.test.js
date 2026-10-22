import { describe, expect, it } from 'vitest';
import { alertToPayload, baseTimeframe, lastTriggeredLabel } from './alertView';

const cond = (timeframe, operand = { kind: 'constant', value: 0 }) => ({
  indicatorType: 'rsi',
  indicatorParams: { length: 14 },
  timeframe,
  operandSeries: 'line',
  operator: '<',
  operand,
});

describe('baseTimeframe', () => {
  it('devuelve la temporalidad más baja de las condiciones', () => {
    const rules = [{ conditions: [cond('1h'), cond('15m')] }, { conditions: [cond('4h')] }];
    expect(baseTimeframe(rules)).toBe('15m');
  });

  it('considera los operandos series', () => {
    const rules = [{ conditions: [cond('1h', { kind: 'series', timeframe: '5m' })] }];
    expect(baseTimeframe(rules)).toBe('5m');
  });

  it('devuelve null si no hay ninguna', () => {
    expect(baseTimeframe([])).toBeNull();
    expect(baseTimeframe(undefined)).toBeNull();
  });
});

describe('lastTriggeredLabel', () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();

  it('Pausada si la alerta está inactiva', () => {
    expect(lastTriggeredLabel({ isActive: false, lastTriggeredAt: { BTC: at(22, 12, 0) } }, now)).toBe('Pausada');
  });

  it('Nunca si no hay disparos', () => {
    expect(lastTriggeredLabel({ isActive: true }, now)).toBe('Nunca');
    expect(lastTriggeredLabel({ isActive: true, lastTriggeredAt: {} }, now)).toBe('Nunca');
  });

  it('hoy hh:mm con el disparo más reciente de cualquier activo', () => {
    const a = { isActive: true, lastTriggeredAt: { BTC: at(22, 9, 5), ETH: at(22, 12, 0) } };
    expect(lastTriggeredLabel(a, now)).toBe('hoy 12:00');
  });

  it('ayer hh:mm', () => {
    expect(lastTriggeredLabel({ isActive: true, lastTriggeredAt: { BTC: at(21, 18, 15) } }, now)).toBe('ayer 18:15');
  });

  it('dd/mm hh:mm para otras fechas', () => {
    expect(lastTriggeredLabel({ isActive: true, lastTriggeredAt: { BTC: at(3, 8, 7) } }, now)).toBe('03/10 08:07');
  });
});

describe('alertToPayload', () => {
  it('convierte el DTO a payload con isActive intacto', () => {
    const payload = alertToPayload({
      id: 5,
      name: ' Mi alerta ',
      isActive: true,
      thresholdPercent: '70',
      cooldownSeconds: 900,
      telegramEnabled: true,
      datasource: 'binance',
      direction: 'bullish',
      assetList: ['BTCUSDT'],
      lastTriggeredAt: { BTCUSDT: 1 },
      rules: [{ label: 'x', weight: 2, joiners: [], conditions: [cond('15m')] }],
    });
    expect(payload).toEqual({
      name: 'Mi alerta',
      isActive: true,
      thresholdPercent: 70,
      cooldownSeconds: 900,
      telegramEnabled: true,
      datasource: 'binance',
      direction: 'bullish',
      assetList: ['BTCUSDT'],
      rules: [{ label: 'x', weight: 2, joiners: [], conditions: [cond('15m')] }],
    });
  });

  it('normaliza reglas legacy planas', () => {
    const payload = alertToPayload({
      name: 'L', isActive: true, thresholdPercent: 70, cooldownSeconds: 900, telegramEnabled: true,
      datasource: 'binance', assetList: ['BTC'],
      rules: [{ indicatorType: 'rsi', indicatorParams: {}, timeframe: '1h', operandSeries: 'line', operator: '<', operand: { kind: 'constant', value: 30 }, weight: 1 }],
    });
    expect(payload.direction).toBe('neutral');
    expect(payload.rules[0].conditions).toHaveLength(1);
    expect(payload.rules[0].conditions[0].timeframe).toBe('1h');
  });
});
