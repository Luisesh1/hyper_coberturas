import { describe, expect, it } from 'vitest';
import { initialBotForm } from './botView';
import {
  EDITOR_MODES, applyPreset, botSummary, errorMode, expiryOf, exitOf, presetOf, strikeOf,
  withExit, withExpiry, withRisk, withStrike, RISK_QUANTITY_CAP,
} from './editorModes';

const base = () => ({ ...initialBotForm({ underlying: 'BTC' }), name: 'Bot', underlyings: ['BTC', 'ETH'], alertIds: [1] });

describe('editorModes', () => {
  it('tres modos: Simple, Avanzado y Presets', () => {
    expect(EDITOR_MODES.map((m) => m.label)).toEqual(['Simple', 'Avanzado', 'Presets']);
  });

  it('strike: cercano = delta 0,95, equilibrado 0,35, lejano 0,15; otro valor = sin opción', () => {
    expect(withStrike(base(), 'near').targetDelta).toBe(0.95);
    expect(strikeOf(withStrike(base(), 'far'))).toBe('far');
    expect(strikeOf({ ...base(), targetDelta: 0.35 })).toBe('mid');
    expect(strikeOf({ ...base(), targetDelta: 0.25 })).toBeNull();
    expect(strikeOf({ ...base(), targetDelta: '0.95' })).toBe('near');
  });

  it('vencimiento: fija días y rango; cualquier otra combinación = sin opción', () => {
    const f = withExpiry(base(), 'short');
    expect([f.expiryDays, f.expiryMinDays, f.expiryMaxDays]).toEqual([2, 1, 3]);
    expect(expiryOf(f)).toBe('short');
    expect(expiryOf(withExpiry(base(), 'week'))).toBe('week');
    expect(expiryOf({ ...f, expiryMaxDays: 4 })).toBeNull();
  });

  it('salida: Banda ATR o TP/SL fijo; volatilidad = sin opción', () => {
    expect(exitOf(withExit(base(), 'atr'))).toBe('atr');
    const fixed = withExit(withExit(base(), 'atr'), 'fixed');
    expect(fixed.takeProfitMode).toBe('fixed');
    expect(fixed.stopLossPct).toBe(50);
    expect(exitOf({ ...base(), takeProfitMode: 'volatility' })).toBeNull();
  });

  it('presets: aplicar y reconocer; tocar un ajuste lo vuelve personalizado', () => {
    const fast = applyPreset(base(), 'fast');
    expect(presetOf(fast)).toBe('fast');
    expect(fast).toMatchObject({ targetDelta: 0.95, expiryDays: 2, takeProfitMode: 'atr_band', tpMaxGainPct: 200 });
    const lottery = applyPreset(fast, 'lottery');
    expect(presetOf(lottery)).toBe('lottery');
    expect(lottery).toMatchObject({ targetDelta: 0.15, tpMaxGainPct: 500 });
    const swing = applyPreset(lottery, 'swing');
    expect(presetOf(swing)).toBe('swing');
    expect(swing).toMatchObject({ targetDelta: 0.35, expiryDays: 7, takeProfitMode: 'fixed', takeProfitPct: 80, stopLossPct: 50 });
    expect(presetOf(withStrike(fast, 'mid'))).toBeNull();
    expect(presetOf({ ...fast, tpMaxGainPct: 300 })).toBeNull();
  });

  it('vender en contra: los presets salen con TP/SL fijo y los valores de venta', () => {
    const sell = { ...base(), structure: 'sell_against' };
    const fast = applyPreset(sell, 'fast');
    expect(fast).toMatchObject({ takeProfitMode: 'fixed', takeProfitPct: 50, stopLossPct: 200 });
    expect(presetOf(fast)).toBe('fast');
  });

  it('riesgo por operación: capital por entrada y la cantidad máxima sube al tope para no limitarlo', () => {
    const f = withRisk(base(), 10);
    expect(f.capitalUsdt).toBe(10);
    expect(f.quantity).toBe(RISK_QUANTITY_CAP);
    expect(withRisk({ ...base(), quantity: 5 }, 10).quantity).toBe(5);
    const cleared = withRisk(f, '');
    expect(cleared.capitalUsdt).toBe('');
    expect(cleared.quantity).toBe(RISK_QUANTITY_CAP);
  });

  it('resumen en una frase', () => {
    const f = withRisk(applyPreset(base(), 'fast'), 10);
    expect(botSummary(f)).toBe('Con cada alerta en BTC o ETH compra la opción a favor (call si es alcista, put si es bajista), cercana al precio, que vence en 1–3 días, arriesgando hasta 10 USDT. Vende al tocar la banda ATR.');
    const sell = applyPreset({ ...base(), structure: 'sell_against', underlyings: ['ETH'] }, 'swing');
    expect(botSummary(sell)).toMatch(/^Con cada alerta en ETH vende la opción en contra \(put si es alcista, call si es bajista\), equilibrada, que vence en ~1 semana, con la cantidad configurada\. Sale con TP \+50 % o stop −200 %\.$/);
  });

  it('errores: a qué modo llevar al usuario para verlos', () => {
    expect(errorMode({ name: 'x' }, 'presets')).toBe('simple');
    expect(errorMode({ name: 'x' }, 'simple')).toBe('simple');
    expect(errorMode({ name: 'x', atrBandLength: 'y' }, 'simple')).toBe('advanced');
    expect(errorMode({}, 'presets')).toBe('presets');
  });
});
