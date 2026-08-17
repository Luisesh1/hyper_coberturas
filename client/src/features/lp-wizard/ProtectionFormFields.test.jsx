import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  computeAutoTunedProtection,
  buildDefaultProtection,
  buildProtectionPayload,
  validateProtectionForm,
} from './ProtectionFormFields';
import ProtectionFormFields from './ProtectionFormFields';

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

  // Antes era un absoluto en USD derivado del capital, y se congelaba: un LP
  // que crecia se quedaba con el umbral del primer dia. Ahora es un % que el
  // motor aplica sobre el valor vivo del LP, asi que ya no depende del capital
  // inicial ni del ancho del rango.
  it('minRebalanceNotionalPct es un % fijo, independiente del capital', () => {
    expect(computeAutoTunedProtection(5, 1000).minRebalanceNotionalPct).toBe(12);
    expect(computeAutoTunedProtection(5, 80).minRebalanceNotionalPct).toBe(12);
    expect(computeAutoTunedProtection(1, 5).minRebalanceNotionalPct).toBe(12);
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

  it('permite defaults del wizard orquestado sin alterar los de edición', () => {
    const result = buildDefaultProtection(1000, null, { enabled: true, leverage: '10' });
    expect(result.enabled).toBe(true);
    expect(result.leverage).toBe('10');
    expect(result.preset).toBe('adaptive');
    expect(result.bandMode).toBe('adaptive');
  });
});

describe('selección de cuenta Hyperliquid', () => {
  it('selecciona únicamente la cuenta cuya address coincide con la wallet del LP', async () => {
    const onChange = vi.fn();
    render(
      <ProtectionFormFields
        value={buildDefaultProtection(1000, null, { enabled: true, leverage: '10' })}
        onChange={onChange}
        lpWalletAddress="0xaBcd000000000000000000000000000000000001"
        accounts={[
          { id: 1, address: '0x9999000000000000000000000000000000000009', isDefault: true },
          { id: 2, address: '0xaBcd000000000000000000000000000000000001' },
        ]}
      />
    );

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ accountId: 2 })));
  });

  it('mantiene la cuenta vacía cuando no hay coincidencia', async () => {
    const onChange = vi.fn();
    render(
      <ProtectionFormFields
        value={buildDefaultProtection(1000, null, { enabled: true, leverage: '10' })}
        onChange={onChange}
        lpWalletAddress="0xaBcd000000000000000000000000000000000001"
        accounts={[{ id: 1, address: '0x9999000000000000000000000000000000000009', isDefault: true }]}
      />
    );

    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
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

describe('política de cobertura', () => {
  const netProfitShadow = () => ({
    ...buildDefaultProtection(1000, null, { enabled: true, leverage: '10' }),
    accountId: 1,
    policyVersion: 'net_profit_v1',
    executionIntent: 'shadow',
  });

  it('conserva la política al apagar y volver a encender la protección', () => {
    const onChange = vi.fn();
    render(<ProtectionFormFields value={netProfitShadow()} onChange={onChange} accounts={[{ id: 1 }]} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /Activar protección delta-neutral/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      policyVersion: 'net_profit_v1',
      executionIntent: 'shadow',
    }));
  });

  it('conserva la política al re-aplicar el auto-tune', () => {
    const onChange = vi.fn();
    render(
      <ProtectionFormFields
        value={{ ...netProfitShadow(), autoTunedFor: 3 }}
        onChange={onChange}
        accounts={[{ id: 1 }]}
        rangeWidthPct={9}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Re-aplicar/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      policyVersion: 'net_profit_v1',
      executionIntent: 'shadow',
    }));
  });

  it('pasar a operación real limpia la confirmación previa y volver a sombra la descarta', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ProtectionFormFields value={netProfitShadow()} onChange={onChange} accounts={[{ id: 1 }]} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Operación real/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ executionIntent: 'live' }));

    onChange.mockClear();
    rerender(
      <ProtectionFormFields
        value={{ ...netProfitShadow(), executionIntent: 'live', activationConfirmed: true }}
        onChange={onChange}
        accounts={[{ id: 1 }]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Sombra/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      executionIntent: 'shadow',
      activationConfirmed: false,
    }));
  });

  it('validateProtectionForm bloquea net profit en real sin confirmar', () => {
    const live = { ...netProfitShadow(), executionIntent: 'live' };
    expect(validateProtectionForm(live)).toMatch(/Confirma la operación real/);
    expect(validateProtectionForm({ ...live, activationConfirmed: true })).toBeNull();
    expect(validateProtectionForm({ ...netProfitShadow() })).toBeNull();
  });
});
