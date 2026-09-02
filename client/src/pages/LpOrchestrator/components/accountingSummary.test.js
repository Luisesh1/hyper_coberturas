import { describe, expect, it } from 'vitest';
import {
  computeAccountingSummary,
  computeHedgeNetUsd,
  buildVerdictSentence,
} from './accountingSummary';

// Caso real del orquestador #45 (26 ago - 1 sep).
const REAL = {
  lpFeesUsd: 9.39,
  gasSpentUsd: 0,
  swapSlippageUsd: 0,
  priceDriftUsd: -3.35,
  hedgeRealizedPnlUsd: -11.63,
  hedgeUnrealizedPnlUsd: 0.59,
  hedgeFundingUsd: -0.24,
  hedgeExecutionFeesUsd: 0.8,
  hedgeSlippageUsd: 1.09,
  totalNetPnlUsd: -7.13,
};

describe('computeAccountingSummary', () => {
  it('descompone el neto real en sus dos patas', () => {
    const s = computeAccountingSummary(REAL, 330);
    expect(s.hedgeNetUsd).toBeCloseTo(-13.17, 2);
    expect(s.lpNetUsd).toBeCloseTo(6.04, 2);
    expect(s.totalNetUsd).toBe(-7.13);
    expect(s.netPct).toBeCloseTo(-2.16, 2);
  });

  it('las dos patas SIEMPRE reconcilian con el neto mostrado', () => {
    // Se deriva la pata LP restando, no volviendo a sumar componentes: si el
    // servidor agrega uno que este cliente no conoce, el encabezado y el
    // detalle siguen cuadrando en vez de discrepar en silencio.
    const conComponenteDesconocido = { ...REAL, totalNetPnlUsd: -5.13, componenteFuturoUsd: 2 };
    const s = computeAccountingSummary(conComponenteDesconocido, 330);
    expect(s.lpNetUsd + s.hedgeNetUsd).toBeCloseTo(s.totalNetUsd, 10);
  });

  it('sin capital inicial no hay porcentaje, y sin neto no hay patas', () => {
    expect(computeAccountingSummary(REAL, 0).netPct).toBeNull();
    expect(computeAccountingSummary(REAL, null).netPct).toBeNull();
    const vacio = computeAccountingSummary(null, 330);
    expect(vacio.totalNetUsd).toBeNull();
    expect(vacio.lpNetUsd).toBeNull();
  });

  it('un campo ausente cuenta como cero, no como NaN', () => {
    expect(computeHedgeNetUsd({ hedgeRealizedPnlUsd: -2 })).toBe(-2);
    expect(computeHedgeNetUsd({})).toBe(0);
  });
});

describe('buildVerdictSentence', () => {
  it('nombra el caso real: el hedge se come las fees', () => {
    expect(buildVerdictSentence(computeAccountingSummary(REAL, 330)))
      .toBe('El hedge se está comiendo las fees del LP.');
  });

  it('distingue los otros escenarios', () => {
    const s = (lp, hedge) => ({ lpNetUsd: lp, hedgeNetUsd: hedge, totalNetUsd: lp + hedge });
    expect(buildVerdictSentence(s(4, 2))).toBe('Las dos patas suman.');
    expect(buildVerdictSentence(s(-4, -2))).toBe('Las dos patas pierden: la cobertura no está compensando al LP.');
    expect(buildVerdictSentence(s(-4, 6))).toBe('La cobertura está sosteniendo el resultado mientras el LP pierde.');
  });

  it('sin contabilidad no afirma nada', () => {
    expect(buildVerdictSentence(null)).toBeNull();
    expect(buildVerdictSentence({ totalNetUsd: null })).toBeNull();
  });
});
