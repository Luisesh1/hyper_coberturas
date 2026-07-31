import { describe, it, expect } from 'vitest';
import { STRATEGY_FIELDS, STRATEGY_FIELD_BY_KEY, validateStrategyFields } from './strategy-fields';

// Estos limites son un espejo de strategyConfigSchema en
// server/src/schemas/lp-orchestrator.schema.js. Si divergen, el formulario
// deja mandar valores que el backend rechaza con un error mucho menos claro.
const LIMITES_DEL_BACKEND = {
  rangeWidthPct: { min: 0.1, max: 99 },
  edgeMarginPct: { min: 5, max: 49 },
  costToRewardThreshold: { min: 0.01, max: 0.99 },
  urgentAlertRepeatMinutes: { min: 1, max: 1440 },
  maxSlippageBps: { min: 1, max: 1000 },
};

describe('STRATEGY_FIELDS', () => {
  it('cada campo trae label y tooltip', () => {
    for (const field of STRATEGY_FIELDS) {
      expect(field.label, `${field.key} sin label`).toBeTruthy();
      // El tooltip es la razon de existir del modulo: antes solo los tenia el
      // wizard y el modal de edicion quedaba a ciegas.
      expect(field.tooltip, `${field.key} sin tooltip`).toBeTruthy();
    }
  });

  it('los rangos coinciden con los del backend', () => {
    for (const [key, limites] of Object.entries(LIMITES_DEL_BACKEND)) {
      const field = STRATEGY_FIELD_BY_KEY[key];
      expect(field, `falta el campo ${key}`).toBeTruthy();
      expect(field.min, `${key}.min`).toBe(limites.min);
      expect(field.max, `${key}.max`).toBe(limites.max);
    }
  });

  it('no hay claves duplicadas', () => {
    const keys = STRATEGY_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('validateStrategyFields', () => {
  const valido = {
    rangeWidthPct: 5, edgeMarginPct: 40, costToRewardThreshold: 0.33,
    reinvestThresholdUsd: 10, urgentAlertRepeatMinutes: 30,
    minRebalanceCooldownSec: 3600, minNetLpEarningsForRebalanceUsd: 0,
    maxSlippageBps: 100,
  };

  it('acepta una configuración válida', () => {
    expect(validateStrategyFields(valido)).toBeNull();
  });

  it('rechaza por debajo del mínimo y por encima del máximo', () => {
    expect(validateStrategyFields({ ...valido, edgeMarginPct: 4 })).toMatch(/mínimo es 5/);
    expect(validateStrategyFields({ ...valido, edgeMarginPct: 50 })).toMatch(/máximo es 49/);
    expect(validateStrategyFields({ ...valido, maxSlippageBps: 1001 })).toMatch(/máximo es 1000/);
  });

  it('rechaza un campo vaciado a mano en vez de mandar 0', () => {
    expect(validateStrategyFields({ ...valido, rangeWidthPct: '' })).toMatch(/falta completar/);
  });

  it('ignora campos ausentes (el backend aplica su default)', () => {
    expect(validateStrategyFields({ rangeWidthPct: 5, edgeMarginPct: 40 })).toBeNull();
  });

  it('rechaza valores no numéricos', () => {
    expect(validateStrategyFields({ ...valido, rangeWidthPct: 'abc' })).toMatch(/debe ser un número/);
  });
});
