import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import CrossChainFundingPanel from './CrossChainFundingPanel';

const byProfile = (gasO, gasD) => ({
  gasOrigin: { expectedUsd: gasO, maxUsd: gasO * 2 },
  bridgeUsd: 0.34,
  gasDestination: { expectedUsd: gasD, maxUsd: gasD * 2 },
  swaps: { expectedUsd: 0, maxUsd: 0 },
  totalExpectedUsd: gasO + 0.34 + gasD,
  totalMaxUsd: gasO * 2 + 0.34 + gasD * 2,
  pctOfTarget: ((gasO + 0.34 + gasD) / 1000) * 100,
});

const ANALYSIS = {
  needsCrossChain: true,
  totalUsdTarget: 1000,
  thresholdPct: 3,
  destination: { network: 'base', label: 'Base', nativeSymbol: 'ETH', lacksGas: true, deficitUsd: { token0: 525, token1: 345 }, localUsableUsd: 180 },
  balances: {
    totalUsd: 1270.36,
    networks: [
      { network: 'base', label: 'Base', status: 'ok', isDestination: true, rows: [{ id: 'base:usdc', symbol: 'USDC', decimals: 6, balanceRaw: '180000000', usd: 180, role: 'destination', reason: 'Se usa directo en el LP' }] },
      { network: 'arbitrum', label: 'Arbitrum One', status: 'ok', rows: [{ id: 'arbitrum:usdc', symbol: 'USDC', decimals: 6, balanceRaw: '420000000', usd: 420, role: 'used', reason: 'Costo 0.04 %', usedAmountRaw: '345000000' }] },
      { network: 'ethereum', label: 'Ethereum', status: 'ok', rows: [{ id: 'ethereum:native', symbol: 'ETH', decimals: 18, isNative: true, balanceRaw: '20000000000000000', usd: 52.4, role: 'excluded', reason: 'Costo $1.92 = 3.7 % > umbral 3 %' }] },
      { network: 'polygon', label: 'Polygon', status: 'error', error: 'rpc caido', rows: [] },
    ],
  },
  steps: [{
    order: 1, sourceNetwork: 'arbitrum', token: { symbol: 'USDC', decimals: 6, isNative: false }, amountRaw: '345000000', amountUsd: 345,
    deliveryToken: { symbol: 'USDC', decimals: 6 }, receivedRaw: '344890000', receivedUsd: 344.89, provider: 'across', carriesDestinationGas: false,
    alternative: { provider: 'lifi', costUsd: 0.98 },
    costs: { bridgeCostUsd: 0.11, bridgeFees: [{ name: 'Relayer (Across)', amountUsd: 0.11, included: true }], gasOrigin: { profilesMatter: false }, costPct: 0.04 },
    costsByProfile: {
      low: { gasOriginExpectedUsd: 0.04, gasOriginMaxUsd: 0.08, expectedUsd: 0.15, maxUsd: 0.19 },
      medium: { gasOriginExpectedUsd: 0.06, gasOriginMaxUsd: 0.12, expectedUsd: 0.17, maxUsd: 0.23 },
      high: { gasOriginExpectedUsd: 0.09, gasOriginMaxUsd: 0.18, expectedUsd: 0.2, maxUsd: 0.29 },
    },
  }],
  deliveredUsd: 344.89,
  uncoveredUsd: 0,
  deployableUsd: 1000,
  costs: { byProfile: { low: byProfile(0.04, 0.09), medium: byProfile(0.06, 0.12), high: byProfile(0.09, 0.16) } },
};

function renderPanel(props = {}) {
  const handlers = {
    onProfileChange: vi.fn(),
    onToggleForced: vi.fn(),
    onToggleDisabled: vi.fn(),
    onUseRecommended: vi.fn(),
    onBringFunds: vi.fn(),
  };
  render(<CrossChainFundingPanel analysis={ANALYSIS} profile="low" canExecute forcedSources={[]} disabledSources={[]} {...handlers} {...props} />);
  return handlers;
}

describe('CrossChainFundingPanel', () => {
  it('muestra los saldos de todas las redes con su papel y motivo', () => {
    renderPanel();
    const table = screen.getByRole('table', { name: /saldos en todas las redes/i });
    expect(within(table).getByText('Arbitrum One')).toBeTruthy();
    expect(within(table).getByText(/3.7 % > umbral 3 %/)).toBeTruthy();
    expect(within(table).getByText('Excluido')).toBeTruthy();
    expect(screen.getByText(/Polygon: no se pudo leer/)).toBeTruthy();
  });

  it('cada perfil muestra su total y al elegir uno avisa', async () => {
    const { onProfileChange } = renderPanel();
    const medium = screen.getByRole('button', { name: /Medio/ });
    expect(medium.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Bajo/ }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(medium);
    expect(onProfileChange).toHaveBeenCalledWith('medium');
  });

  it('los pasos muestran el costo del perfil elegido y la ruta descartada', () => {
    const { rerender } = render(<CrossChainFundingPanel analysis={ANALYSIS} profile="high" canExecute forcedSources={[]} disabledSources={[]} />);
    const step = screen.getByRole('listitem', { name: /Paso 1/ });
    expect(within(step).getByText('$0.20')).toBeTruthy();
    expect(within(step).getByText(/Li\.Fi costaba \$0.98/)).toBeTruthy();
    rerender(<CrossChainFundingPanel analysis={ANALYSIS} profile="low" canExecute forcedSources={[]} disabledSources={[]} />);
    expect(within(screen.getByRole('listitem', { name: /Paso 1/ })).getByText('$0.15')).toBeTruthy();
  });

  it('forzar un origen excluido llama con su id', async () => {
    const { onToggleForced } = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Forzar ETH en Ethereum/ }));
    expect(onToggleForced).toHaveBeenCalledWith('ethereum:native');
  });

  it('desactivar un origen usado llama con su id', async () => {
    const { onToggleDisabled } = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Desactivar USDC en Arbitrum One/ }));
    expect(onToggleDisabled).toHaveBeenCalledWith('arbitrum:usdc');
  });

  it('las categorías de costo y el total del perfil', () => {
    renderPanel();
    expect(screen.getByText('Gas en redes de origen')).toBeTruthy();
    expect(screen.getByText('Comisiones de bridge')).toBeTruthy();
    expect(screen.getByText('Gas en Base')).toBeTruthy();
    expect(screen.getByTestId('cc-total-expected').textContent).toBe('$0.47');
  });

  it('avisa si Base no tiene gas y en Orbit que los perfiles casi no cambian el costo', () => {
    renderPanel();
    expect(screen.getByText(/Base no tiene ETH para el gas/)).toBeTruthy();
    expect(screen.getByText(/orden de llegada/)).toBeTruthy();
  });

  it('en modo solo lectura no se puede traer fondos', () => {
    renderPanel({ canExecute: false });
    expect(screen.getByRole('button', { name: /Traer fondos/ }).disabled).toBe(true);
    expect(screen.getByText(/solo análisis/i)).toBeTruthy();
  });

  it('traer fondos avisa con la cantidad de envíos', async () => {
    const { onBringFunds } = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Traer fondos \(1 envío\)/ }));
    expect(onBringFunds).toHaveBeenCalled();
  });

  it('sin déficit solo muestra los saldos y no el plan', () => {
    renderPanel({ analysis: { ...ANALYSIS, needsCrossChain: false, steps: [] } });
    expect(screen.queryByRole('button', { name: /Traer fondos/ })).toBeNull();
    expect(screen.getByText(/alcanzan en Base/)).toBeTruthy();
  });
});
