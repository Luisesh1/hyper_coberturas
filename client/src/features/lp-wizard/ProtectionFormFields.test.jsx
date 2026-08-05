import { describe, it, expect } from 'vitest';
import {
  computeAutoTunedProtection,
  buildDefaultProtection,
  buildProtectionPayload,
} from './ProtectionFormFields';

describe('computeAutoTunedProtection', () => {
  it('devuelve null si rangeWidthPct es inválido o nulo', () => {
    expect(computeAutoTunedProtection(null, 1000)).toBeNull();
    expect(computeAutoTunedProtection(undefined, 1000)).toBeNull();
    expect(computeAutoTunedProtection(0, 1000)).toBeNull();
    expect(computeAutoTunedProtection(NaN, 1000)).toBeNull();
  });

  it('rango estrecho (≤2%) usa preset aggressive con intervalo 30 min', () => {
    const tuned = computeAutoTunedProtection(1.5, 1000);
    expect(tuned.preset).toBe('aggressive');
    expect(tuned.bandMode).toBe('fixed');
    expect(tuned.rebalanceIntervalSec).toBe(1800);
    expect(tuned.maxSlippageBps).toBe(30);
    // baseRebalancePriceMovePct = max(0.5, 1.5 * 0.3) = 0.5
    expect(tuned.baseRebalancePriceMovePct).toBe(0.5);
  });

  it('rango medio (2-5%) usa preset balanced con intervalo 1h', () => {
    const tuned = computeAutoTunedProtection(5, 1000);
    expect(tuned.preset).toBe('balanced');
    expect(tuned.bandMode).toBe('adaptive');
    expect(tuned.rebalanceIntervalSec).toBe(3600);
    expect(tuned.maxSlippageBps).toBe(25);
    // baseRebalancePriceMovePct = 5 * 0.3 = 1.5
    expect(tuned.baseRebalancePriceMovePct).toBe(1.5);
  });

  it('rango amplio (5-10%) usa preset adaptive con intervalo 6h', () => {
    const tuned = computeAutoTunedProtection(8, 1000);
    expect(tuned.preset).toBe('adaptive');
    expect(tuned.bandMode).toBe('adaptive');
    expect(tuned.rebalanceIntervalSec).toBe(21600);
    expect(tuned.maxSlippageBps).toBe(20);
    // baseRebalancePriceMovePct = 8 * 0.3 = 2.4
    expect(tuned.baseRebalancePriceMovePct).toBe(2.4);
  });

  it('rango muy amplio (>10%) usa conservative con intervalo 12h', () => {
    const tuned = computeAutoTunedProtection(20, 1000);
    expect(tuned.preset).toBe('conservative');
    expect(tuned.bandMode).toBe('fixed');
    expect(tuned.rebalanceIntervalSec).toBe(43200);
    // techo en 5%
    expect(tuned.baseRebalancePriceMovePct).toBe(5);
  });

  it('configuredNotionalUsd es la mitad del capital LP redondeada', () => {
    expect(computeAutoTunedProtection(5, 1000).configuredNotionalUsd).toBe(500);
    expect(computeAutoTunedProtection(5, 81).configuredNotionalUsd).toBe(41); // 40.5 → 41
  });

  it('minRebalanceNotionalUsd es ~12% del notional inicial con suelo en 2', () => {
    // capital 1000 → notional 500 → 12% = 60
    expect(computeAutoTunedProtection(5, 1000).minRebalanceNotionalUsd).toBe(60);
    // capital 80 → notional 40 → 12% = 4.8 → redondeo a 5
    expect(computeAutoTunedProtection(5, 80).minRebalanceNotionalUsd).toBe(5);
    // capital muy bajo → suelo de 2
    expect(computeAutoTunedProtection(5, 5).minRebalanceNotionalUsd).toBe(2);
  });
});

describe('buildDefaultProtection', () => {
  it('aplica auto-tune cuando se pasa rangeWidthPct', () => {
    const result = buildDefaultProtection(1000, 5);
    expect(result.autoTunedFor).toBe(5);
    expect(result.preset).toBe('balanced');
    expect(result.baseRebalancePriceMovePct).toBe('1.5');
    expect(result.rebalanceIntervalSec).toBe('3600');
    expect(result.configuredNotionalUsd).toBe('500');
  });

  it('vuelve a defaults simples cuando rangeWidthPct no se pasa', () => {
    const result = buildDefaultProtection(1000);
    expect(result.autoTunedFor).toBeNull();
    // Notional sigue siendo mitad del LP
    expect(result.configuredNotionalUsd).toBe('500');
  });
});

describe('buildProtectionPayload', () => {
  it('descarta autoTunedFor del payload final que va al backend', () => {
    const formValue = buildDefaultProtection(1000, 5);
    formValue.enabled = true;
    formValue.accountId = 1;
    const payload = buildProtectionPayload(formValue);
    expect(payload.enabled).toBe(true);
    expect(payload.accountId).toBe(1);
    expect(payload.baseRebalancePriceMovePct).toBe(1.5);
    // El campo autoTunedFor no debe filtrarse al backend
    expect('autoTunedFor' in payload).toBe(false);
  });

  it('cuando está desactivada solo manda { enabled: false }', () => {
    expect(buildProtectionPayload({ enabled: false })).toEqual({ enabled: false });
    expect(buildProtectionPayload(null)).toEqual({ enabled: false });
  });
});
