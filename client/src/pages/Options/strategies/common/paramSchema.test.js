import { describe, expect, it } from 'vitest';
import { formatParamValue, initialParams, normalizeSchema, validateParams } from './paramSchema';
import { formatNumber, formatUsdt } from './format';

describe('normalizeSchema', () => {
  it('acepta lista y objeto y deduce tipos', () => {
    const fromList = normalizeSchema([
      { key: 'deltaTarget', label: 'Δ objetivo', type: 'number', min: 0.05, max: 0.5, step: 0.05 },
      { key: 'dte', type: 'integer', min: 1, max: 60 },
      { key: 'onlyFridays', type: 'boolean' },
      { key: 'exit', options: [{ value: 'tp', label: 'Toma de ganancia' }, 'expiry'] },
    ]);
    expect(fromList.map((s) => s.type)).toEqual(['number', 'integer', 'boolean', 'select']);
    expect(fromList[1]).toMatchObject({ label: 'Dte', step: 1 });
    expect(fromList[3].options).toEqual([{ value: 'tp', label: 'Toma de ganancia' }, { value: 'expiry', label: 'expiry' }]);

    const fromObject = normalizeSchema({ takeProfitPct: { type: 'number', min: 10, max: 90 } });
    expect(fromObject[0]).toMatchObject({ key: 'takeProfitPct', label: 'Take profit pct', type: 'number', min: 10 });
  });

  it('es idempotente', () => {
    const once = normalizeSchema([{ key: 'a', type: 'int', min: 1 }]);
    expect(normalizeSchema(once)).toEqual(once);
  });
});

describe('initialParams', () => {
  it('defaultParams > default del esquema > neutro, y los valores actuales mandan', () => {
    const tpl = {
      defaultParams: { a: 0.2 },
      paramSchema: [
        { key: 'a', type: 'number' },
        { key: 'b', type: 'number', default: 7 },
        { key: 'c', type: 'number', min: 3 },
        { key: 'd', type: 'boolean' },
      ],
    };
    expect(initialParams(tpl)).toEqual({ a: 0.2, b: 7, c: 3, d: false });
    expect(initialParams(tpl, { b: 9 })).toMatchObject({ b: 9 });
  });
});

describe('validateParams', () => {
  const schema = [
    { key: 'delta', label: 'Delta', type: 'number', min: 0.05, max: 0.5 },
    { key: 'dte', label: 'DTE', type: 'integer', min: 1 },
    { key: 'mode', type: 'select', options: ['a', 'b'] },
  ];

  it('marca vacíos, fuera de rango, no enteros y opciones inválidas', () => {
    expect(validateParams(schema, { delta: 0.9, dte: 2.5, mode: 'z' })).toEqual({
      delta: 'Máximo 0,5',
      dte: 'Debe ser un número entero',
      mode: 'Opción no válida',
    });
    expect(validateParams(schema, { delta: null, dte: 0, mode: 'a' })).toEqual({ delta: 'Obligatorio', dte: 'Mínimo 1' });
    expect(validateParams(schema, { delta: 0.2, dte: 7, mode: 'b' })).toEqual({});
  });
});

describe('format', () => {
  it('es-ES con agrupación, signo y menos tipográfico', () => {
    expect(formatUsdt(1020)).toBe('1.020,00');
    expect(formatUsdt(412.8, { sign: true })).toBe('+412,80');
    expect(formatUsdt(-38.5)).toBe('−38,50');
    expect(formatNumber(null)).toBe('—');
    expect(formatParamValue({ type: 'boolean' }, true)).toBe('Sí');
  });
});
