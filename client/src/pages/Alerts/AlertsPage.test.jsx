import { describe, expect, it } from 'vitest';
import { normalizeLoadedRule } from './AlertsPage';

describe('normalizeLoadedRule', () => {
  it('conserva un peso explícito de cero al abrir una alerta', () => {
    const rule = normalizeLoadedRule({
      label: 'Solo informativa',
      weight: 0,
      conditions: [{
        indicatorType: 'rsi',
        timeframe: '15m',
        operator: '<',
        operand: { kind: 'constant', value: 30 },
      }],
      joiners: [],
    });

    expect(rule.weight).toBe(0);
  });
});
