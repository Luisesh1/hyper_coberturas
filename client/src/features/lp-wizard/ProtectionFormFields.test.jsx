import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  computeAutoTunedProtection,
  buildDefaultProtection,
  buildProtectionPayload,
  validateProtectionForm,
  rangePositionFraction,
  DEFAULT_CENTER_DEAD_ZONE_PCT,
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

describe('notional automático desde el delta del rango', () => {
  const rangeProps = {
    initialUsd: 110,
    currentPrice: 92,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
  };

  const enabled = (overrides = {}) => ({
    ...buildDefaultProtection(110, null, { enabled: true, leverage: '10' }),
    ...overrides,
  });

  it('viene activado por defecto', () => {
    expect(buildDefaultProtection(110, null, { enabled: true }).notionalAuto).toBe(true);
  });

  it('con auto activo muestra el notional del delta y oculta el input manual', () => {
    render(
      <ProtectionFormFields
        value={enabled()}
        onChange={vi.fn()}
        accounts={[{ id: 1 }]}
        {...rangeProps}
      />
    );

    // 88.66% de $110 con el precio pegado al borde inferior, no la mitad.
    expect(screen.getByText('$97.53')).toBeTruthy();
    expect(screen.queryByLabelText('Notional USD a hedgear')).toBeNull();
  });

  it('desmarcar auto revela el input pre-rellenado con el valor calculado', () => {
    const onChange = vi.fn();
    render(
      <ProtectionFormFields
        value={enabled()}
        onChange={onChange}
        accounts={[{ id: 1 }]}
        {...rangeProps}
      />
    );

    fireEvent.click(screen.getByLabelText('Calcular el notional automáticamente'));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      notionalAuto: false,
      configuredNotionalUsd: '97.53',
    }));
  });

  it('sin precio ni bordes cae a la mitad del capital', () => {
    render(
      <ProtectionFormFields
        value={enabled()}
        onChange={vi.fn()}
        accounts={[{ id: 1 }]}
        initialUsd={110}
      />
    );

    expect(screen.getByText('$55')).toBeTruthy();
  });

  it('el payload manda el notional calculado y descarta notionalAuto', () => {
    const payload = buildProtectionPayload(enabled({
      accountId: 1,
      notionalAuto: true,
      configuredNotionalUsd: '97.53',
    }));

    expect(payload.configuredNotionalUsd).toBe(97.53);
    expect(payload.notionalAuto).toBeUndefined();
  });
});

// Las configuraciones ya persistidas no tienen `notionalAuto`. Heredar el
// default `true` haría que el efecto de auto pisara el notional que el usuario
// fijó a mano en su día, en silencio y sólo por abrir el modal de edición.
describe('compatibilidad con protecciones ya guardadas', () => {
  it('un valor con notional propio y sin notionalAuto se trata como manual', () => {
    const onChange = vi.fn();
    render(
      <ProtectionFormFields
        value={(() => {
          // Una fila persistida: la clave `notionalAuto` no existe siquiera.
          const saved = buildDefaultProtection(110, null, { enabled: true, leverage: '10' });
          delete saved.notionalAuto;
          return { ...saved, accountId: 1, configuredNotionalUsd: '42' };
        })()}
        onChange={onChange}
        accounts={[{ id: 1 }]}
        initialUsd={110}
        currentPrice={92}
        rangeLowerPrice={90}
        rangeUpperPrice={110}
      />
    );

    expect(screen.getByLabelText('Notional USD a hedgear').value).toBe('42');
    expect(onChange).not.toHaveBeenCalled();
  });
});

// La zona central sin rebalanceo es la unica preferencia del formulario que
// depende de DONDE esta el precio dentro del rango, asi que el numero solo no
// alcanza: el usuario tiene que ver el tramo congelado y su estado actual.
describe('zona central sin rebalanceo', () => {
  const baseValue = {
    ...buildDefaultProtection(1000, 5),
    enabled: true,
    accountId: 1,
  };

  it('arranca en 40% y viaja en el payload', () => {
    expect(buildDefaultProtection(1000, 5).centerDeadZonePct).toBe(String(DEFAULT_CENTER_DEAD_ZONE_PCT));
    expect(buildProtectionPayload(baseValue).centerDeadZonePct).toBe(40);
  });

  it('acepta el 0 como "sin zona muerta" y rechaza valores fuera de rango', () => {
    expect(validateProtectionForm({ ...baseValue, centerDeadZonePct: '0' })).toBeNull();
    expect(validateProtectionForm({ ...baseValue, centerDeadZonePct: '95' })).toMatch(/entre 0 y 90/);
    expect(validateProtectionForm({ ...baseValue, centerDeadZonePct: '-1' })).toMatch(/entre 0 y 90/);
  });

  // El centro de un rango de ticks es el medio GEOMETRICO: con la mitad
  // aritmetica el marcador se corre del borde de la zona justo donde el
  // usuario mira para decidir.
  it('ubica el precio en espacio logaritmico, como el servidor', () => {
    expect(rangePositionFraction(Math.sqrt(90 * 110), 90, 110)).toBeCloseTo(0.5, 12);
    expect(rangePositionFraction(90, 90, 110)).toBe(0);
    expect(rangePositionFraction(80, 90, 110)).toBeNull();
  });

  it('dice si con el precio de ahora la cobertura rebalancea o no', async () => {
    const { rerender } = render(
      <ProtectionFormFields
        value={baseValue}
        onChange={() => {}}
        accounts={[{ id: 1, alias: 'main', address: '0xabc' }]}
        currentPrice={Math.sqrt(90 * 110)}
        rangeLowerPrice={90}
        rangeUpperPrice={110}
      />
    );
    expect(await screen.findByText(/no rebalancea/i)).toBeTruthy();

    // Cerca del borde inferior (fraccion ~0.05) queda fuera del 40% central.
    rerender(
      <ProtectionFormFields
        value={baseValue}
        onChange={() => {}}
        accounts={[{ id: 1, alias: 'main', address: '0xabc' }]}
        currentPrice={91}
        rangeLowerPrice={90}
        rangeUpperPrice={110}
      />
    );
    await waitFor(() => expect(screen.getByText(/^Con el precio de ahora la cobertura rebalancea\.$/)).toBeTruthy());
  });
});
