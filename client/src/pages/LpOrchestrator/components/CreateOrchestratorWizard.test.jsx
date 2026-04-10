import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CreateOrchestratorWizard from './CreateOrchestratorWizard';

const { uniswapApi, lpOrchestratorApi } = vi.hoisted(() => ({
  uniswapApi: { getSmartCreateTokenList: vi.fn() },
  lpOrchestratorApi: { create: vi.fn() },
}));

vi.mock('../../../services/api', () => ({ uniswapApi, lpOrchestratorApi }));

describe('CreateOrchestratorWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uniswapApi.getSmartCreateTokenList.mockResolvedValue([
      { symbol: 'WETH', address: '0x00000000000000000000000000000000000000AA' },
      { symbol: 'USDC', address: '0x00000000000000000000000000000000000000BB' },
    ]);
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

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalled());

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

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalled());

    // Paso 1: Identidad
    await user.type(screen.getByPlaceholderText(/ej\. WETH\/USDC/i), 'Mi orq');
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0], '0x00000000000000000000000000000000000000AA');
    await user.selectOptions(selects[1], '0x00000000000000000000000000000000000000BB');
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

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText(/ej\. WETH\/USDC/i), 'X');
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0], '0x00000000000000000000000000000000000000AA');
    await user.selectOptions(selects[1], '0x00000000000000000000000000000000000000BB');
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
});
