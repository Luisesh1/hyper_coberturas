import { describe, expect, it } from 'vitest';
import { finite, fmtSignedUsd, fmtUsdCompact, toNumber } from './format';

describe('toNumber', () => {
  it('no convierte la ausencia en cero', () => {
    // Una columna NULL de Postgres llega como `null`: con `Number()` a secas
    // valdria 0 y la UI mostraria un saldo que nadie midio.
    expect(toNumber(null)).toBeNaN();
    expect(toNumber(undefined)).toBeNaN();
    expect(toNumber('')).toBeNaN();
    expect(toNumber('   ')).toBeNaN();
    expect(toNumber(false)).toBeNaN();
    expect(toNumber([])).toBeNaN();
  });

  it('acepta numeros y cadenas numericas', () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-12.5)).toBe(-12.5);
    expect(toNumber('1234.56')).toBe(1234.56);
  });
});

describe('finite', () => {
  it('deja hueco donde no hay dato y conserva el cero real', () => {
    expect(finite(null)).toBeNull();
    expect(finite('abc')).toBeNull();
    expect(finite(Infinity)).toBeNull();
    expect(finite(0)).toBe(0);
  });
});

describe('formateo', () => {
  it('pinta un guion donde falta el dato, no $0', () => {
    expect(fmtUsdCompact(null)).toBe('—');
    expect(fmtSignedUsd(null)).toBe('—');
    expect(fmtSignedUsd(0)).toBe('+$0.00');
    expect(fmtSignedUsd(-1)).toBe('-$1.00');
  });
});
