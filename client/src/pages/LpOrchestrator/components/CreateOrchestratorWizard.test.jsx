import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CreateOrchestratorWizard from './CreateOrchestratorWizard';

const { uniswapApi, lpOrchestratorApi } = vi.hoisted(() => ({
  uniswapApi: { getSmartCreateTokenList: vi.fn(), getSmartCreatePools: vi.fn() },
  lpOrchestratorApi: { create: vi.fn() },
}));

vi.mock('../../../services/api', () => ({ uniswapApi, lpOrchestratorApi }));

describe('CreateOrchestratorWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uniswapApi.getSmartCreateTokenList.mockResolvedValue([]);
    // El wizard ya no compone el par: elige de los pools que existen on-chain.
    uniswapApi.getSmartCreatePools.mockResolvedValue({
      network: 'arbitrum',
      version: 'v3',
      pools: [
        {
          label: 'WETH/USDC', fee: 500, tickSpacing: 10, hasLiquidity: true,
          token0: { symbol: 'WETH', address: '0x00000000000000000000000000000000000000AA', decimals: 18 },
          token1: { symbol: 'USDC', address: '0x00000000000000000000000000000000000000BB', decimals: 6 },
        },
        {
          label: 'WETH/USDC', fee: 3000, tickSpacing: 60, hasLiquidity: false,
          token0: { symbol: 'WETH', address: '0x00000000000000000000000000000000000000AA', decimals: 18 },
          token1: { symbol: 'USDC', address: '0x00000000000000000000000000000000000000BB', decimals: 6 },
        },
      ],
    });
    lpOrchestratorApi.create.mockResolvedValue({ id: 42, name: 'Test orq' });
  });

  it('valida cada paso antes de avanzar', async () => {
    const user = userEvent.setup();
    render(
      <CreateOrchestratorWizard
        network="arbitrum"
        version="v3"
        walletAddress="0x123"
        accounts={[{ id: 1, alias: 'Main', address: '0xa', isDefault: true }]}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreatePools).toHaveBeenCalled());

    // Sin nombre / tokens debe bloquear el avance
    await user.click(screen.getByText(/Siguiente/));
    expect(screen.queryByText(/Pon un nombre al orquestador/i)).toBeTruthy();
  });

  it('ejecuta el flow completo y llama a lpOrchestratorApi.create', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <CreateOrchestratorWizard
        network="arbitrum"
        version="v3"
        walletAddress="0x123"
        accounts={[{ id: 1, alias: 'Main', address: '0xa', isDefault: true }]}
        onClose={() => {}}
        onCreated={onCreated}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreatePools).toHaveBeenCalled());

    // Paso 1: Identidad
    await user.type(screen.getByPlaceholderText(/ej\. WETH\/USDC/i), 'Mi orq');
    await user.click(screen.getByText(/Siguiente/));

    // Paso 2: Estrategia (los defaults son válidos)
    await waitFor(() => expect(screen.queryByText(/Ancho del rango/i)).toBeTruthy());
    await user.click(screen.getByText(/Siguiente/));

    // Paso 3: Protección — dejar desactivada
    await waitFor(() => expect(screen.queryByText(/Activar protección delta-neutral/i)).toBeTruthy());
    await user.click(screen.getByText(/Siguiente/));

    // Paso 4: Review → Crear
    await waitFor(() => expect(screen.queryByText('Crear orquestador', { selector: 'button' })).toBeTruthy());
    await user.click(screen.getByText('Crear orquestador', { selector: 'button' }));

    await waitFor(() => expect(lpOrchestratorApi.create).toHaveBeenCalledTimes(1));
    const payload = lpOrchestratorApi.create.mock.calls[0][0];
    expect(payload.name).toBe('Mi orq');
    expect(payload.token0Address).toBe('0x00000000000000000000000000000000000000AA');
    expect(payload.token1Address).toBe('0x00000000000000000000000000000000000000BB');
    expect(payload.protectionConfig.enabled).toBe(false);
    expect(payload.strategyConfig.rangeWidthPct).toBe(5);
    expect(payload.strategyConfig.edgeMarginPct).toBe(40);
    expect(onCreated).toHaveBeenCalledWith({ id: 42, name: 'Test orq' });
  });

  it('habilita protección delta-neutral y la incluye en el payload', async () => {
    const user = userEvent.setup();
    render(
      <CreateOrchestratorWizard
        network="arbitrum"
        version="v3"
        walletAddress="0x123"
        accounts={[{ id: 1, alias: 'Main', address: '0xa', isDefault: true }]}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreatePools).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText(/ej\. WETH\/USDC/i), 'X');
    await user.click(screen.getByText(/Siguiente/));
    await waitFor(() => expect(screen.queryByText(/Ancho del rango/i)).toBeTruthy());
    await user.click(screen.getByText(/Siguiente/));

    // Activar protección
    await waitFor(() => expect(screen.queryByText(/Activar protección delta-neutral/i)).toBeTruthy());
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    // Avanzar al review
    await user.click(screen.getByText(/Siguiente/));
    await waitFor(() => expect(screen.queryByText('Crear orquestador', { selector: 'button' })).toBeTruthy());
    await user.click(screen.getByText('Crear orquestador', { selector: 'button' }));

    await waitFor(() => expect(lpOrchestratorApi.create).toHaveBeenCalledTimes(1));
    const payload = lpOrchestratorApi.create.mock.calls[0][0];
    expect(payload.protectionConfig.enabled).toBe(true);
    expect(payload.protectionConfig.accountId).toBe(1);
  });

  it('solo ofrece pools que existen on-chain y marca los que no tienen liquidez', async () => {
    render(
      <CreateOrchestratorWizard
        network="arbitrum" version="v3" walletAddress="0x123"
        accounts={[]} onClose={() => {}} onCreated={() => {}}
      />
    );
    await waitFor(() => expect(uniswapApi.getSmartCreatePools).toHaveBeenCalled());

    const opciones = await screen.findAllByRole('radio');
    expect(opciones).toHaveLength(2);
    // El de 0.30% viene sin liquidez: hay que advertirlo, no ocultarlo.
    expect(screen.getByText(/sin liquidez/i)).toBeTruthy();
    // Preselecciona el primero CON liquidez para ahorrar un click.
    expect(opciones[0].getAttribute('aria-checked')).toBe('true');
    expect(opciones[1].getAttribute('aria-checked')).toBe('false');
  });

  it('recarga los pools al cambiar de versión', async () => {
    const user = userEvent.setup();
    render(
      <CreateOrchestratorWizard
        network="arbitrum" version="v3" walletAddress="0x123"
        accounts={[]} onClose={() => {}} onCreated={() => {}}
      />
    );
    await waitFor(() => expect(uniswapApi.getSmartCreatePools).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText('Versión'), 'v4');
    await waitFor(() => expect(uniswapApi.getSmartCreatePools).toHaveBeenCalledTimes(2));
    expect(uniswapApi.getSmartCreatePools).toHaveBeenLastCalledWith({ network: 'arbitrum', version: 'v4' });
  });

  it('el par y el fee del payload salen del pool elegido, no de inputs sueltos', async () => {
    const user = userEvent.setup();
    render(
      <CreateOrchestratorWizard
        network="arbitrum" version="v3" walletAddress="0x123"
        accounts={[{ id: 1, alias: 'Main', address: '0xa', isDefault: true }]}
        onClose={() => {}} onCreated={() => {}}
      />
    );
    await waitFor(() => expect(uniswapApi.getSmartCreatePools).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText(/ej\. WETH\/USDC/i), 'Desde pool');
    // Elegimos explicitamente el segundo pool (0.30%, sin liquidez).
    const opciones = await screen.findAllByRole('radio');
    await user.click(opciones[1]);

    await user.click(screen.getByText(/Siguiente/));
    await waitFor(() => expect(screen.queryByText(/Ancho del rango/i)).toBeTruthy());
    await user.click(screen.getByText(/Siguiente/));
    await waitFor(() => expect(screen.queryByText(/Activar protección delta-neutral/i)).toBeTruthy());
    await user.click(screen.getByText(/Siguiente/));
    await waitFor(() => expect(screen.queryByText('Crear orquestador', { selector: 'button' })).toBeTruthy());
    await user.click(screen.getByText('Crear orquestador', { selector: 'button' }));

    await waitFor(() => expect(lpOrchestratorApi.create).toHaveBeenCalledTimes(1));
    const payload = lpOrchestratorApi.create.mock.calls[0][0];
    expect(payload.feeTier).toBe(3000);
    expect(payload.token0Symbol).toBe('WETH');
    expect(payload.token1Symbol).toBe('USDC');
    expect(payload.token0Address).toBe('0x00000000000000000000000000000000000000AA');
    // v3 no persiste tickSpacing.
    expect(payload.strategyConfig.v4TickSpacing).toBeUndefined();
  });
});
