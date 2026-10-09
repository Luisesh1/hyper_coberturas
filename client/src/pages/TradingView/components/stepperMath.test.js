import { describe, expect, it } from 'vitest';
import { parseNumberInput, normalizeNumber, stepNumber } from './stepperMath';

describe('stepNumber', () => {
  it('suma y resta el paso entero', () => {
    expect(stepNumber(20, 1, { min: 2, max: 500, step: 1 })).toBe(21);
    expect(stepNumber(20, -1, { min: 2, max: 500, step: 1 })).toBe(19);
  });

  it('no acumula error de coma flotante con pasos decimales', () => {
    expect(stepNumber(0.2, 1, { min: 0.1, max: 5, step: 0.1 })).toBe(0.3);
    expect(stepNumber(1.5, 1, { min: 0.5, max: 5, step: 0.1 })).toBe(1.6);
    expect(stepNumber(0.3, -1, { min: 0.1, max: 5, step: 0.1 })).toBe(0.2);
  });

  it('se queda en los límites', () => {
    expect(stepNumber(500, 1, { min: 2, max: 500, step: 1 })).toBe(500);
    expect(stepNumber(2, -1, { min: 2, max: 500, step: 1 })).toBe(2);
    expect(stepNumber(4.95, 1, { min: 0.5, max: 5, step: 0.1 })).toBe(5);
  });

  it('usa paso 1 si no viene definido', () => {
    expect(stepNumber(3, 1, {})).toBe(4);
  });

  it('parte de un valor fuera de rango y lo devuelve al rango', () => {
    expect(stepNumber(900, -1, { min: 2, max: 500, step: 1 })).toBe(499);
  });
});

describe('normalizeNumber', () => {
  it('limita a min y max', () => {
    expect(normalizeNumber(1, { min: 2, max: 500, step: 1 })).toBe(2);
    expect(normalizeNumber(9999, { min: 2, max: 500, step: 1 })).toBe(500);
  });

  it('redondea a la precisión del paso', () => {
    expect(normalizeNumber(2.345, { min: 0.5, max: 5, step: 0.1 })).toBe(2.3);
    expect(normalizeNumber(20.6, { min: 2, max: 500, step: 1 })).toBe(21);
    expect(normalizeNumber(0.1 + 0.2, { min: 0.1, max: 5, step: 0.1 })).toBe(0.3);
  });

  it('deja intactos valores ya válidos', () => {
    expect(normalizeNumber(1.5, { min: 0.5, max: 5, step: 0.1 })).toBe(1.5);
    expect(normalizeNumber(70, { min: 0, max: 100, step: 1 })).toBe(70);
  });

  it('funciona sin min ni max', () => {
    expect(normalizeNumber(-3.14159, { step: 0.01 })).toBe(-3.14);
  });
});

describe('parseNumberInput', () => {
  it('acepta punto o coma decimal', () => {
    expect(parseNumberInput('1.5')).toBe(1.5);
    expect(parseNumberInput('1,5')).toBe(1.5);
    expect(parseNumberInput(' 20 ')).toBe(20);
  });

  it('devuelve null para texto vacío o no numérico', () => {
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('-')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput('1.2.3')).toBeNull();
  });
});
