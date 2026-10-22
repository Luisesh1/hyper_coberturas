import { describe, expect, it } from 'vitest';
import { operatorsFor, summarizeCondition } from './labels';
import { NONE_KIND_OPS } from '../components/ConditionFields';

describe('operadores momentum subiendo/bajando', () => {
  it('operatorsFor(sqzmom) los incluye con su etiqueta', () => {
    const ops = operatorsFor('sqzmom');
    expect(ops).toContainEqual({ value: 'momentum_rising', label: 'momentum subiendo ↗' });
    expect(ops).toContainEqual({ value: 'momentum_falling', label: 'momentum bajando ↘' });
    expect(operatorsFor('rsi').some((o) => o.value === 'momentum_rising')).toBe(false);
  });

  it('no requieren operando', () => {
    expect(NONE_KIND_OPS.has('momentum_rising')).toBe(true);
    expect(NONE_KIND_OPS.has('momentum_falling')).toBe(true);
  });

  it('summarizeCondition los describe', () => {
    const base = { indicatorType: 'sqzmom', indicatorParams: {}, timeframe: '1h', operandSeries: 'sqzMomentum', operand: { kind: 'none' } };
    expect(summarizeCondition({ ...base, operator: 'momentum_rising' })).toMatch(/: momentum subiendo$/);
    expect(summarizeCondition({ ...base, operator: 'momentum_falling' })).toMatch(/: momentum bajando$/);
  });
});
