import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PoolCard from './PoolCard';
import ProtectedPoolCard from './ProtectedPoolCard';
import PositionActionModal from './PositionActionModal';

const { uniswapApi } = vi.hoisted(() => ({
  uniswapApi: {
    preparePositionAction: vi.fn(),
    finalizePositionAction: vi.fn(),
  },
}));

vi.mock('../../../services/api', () => ({
  uniswapApi,
}));

const basePool = {
  mode: 'lp_position',
  version: 'v3',
  network: 'arbitrum',
  networkLabel: 'Arbitrum One',
  chainId: 42161,
  identifier: '123',
  owner: '0x00000000000000000000000000000000000000aa',
  token0: { symbol: 'WETH' },
  token1: { symbol: 'USDC' },
  currentValueUsd: 100,
  pnlTotalUsd: 0,
  yieldPct: 0,
  unclaimedFeesUsd: 0,
  rangeLowerPrice: 2000,
  rangeUpperPrice: 2200,
  priceCurrent: 2100,
  explorerUrl: 'https://arbiscan.io',
};

const walletState = {
  isConnected: true,
  address: '0x00000000000000000000000000000000000000aa',
  chainId: 42161,
};

describe('LP close actions UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('muestra botones de cierre en PoolCard', async () => {
    const onClaimFees = vi.fn();
    render(
      <PoolCard
        pool={basePool}
        hasAccounts={false}
        onApplyProtection={vi.fn()}
        walletState={walletState}
        onClaimFees={onClaimFees}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Cerrar a USDC/i }));
    await userEvent.click(screen.getByRole('button', { name: /Cerrar LP/i }));

    expect(onClaimFees).toHaveBeenNthCalledWith(1, 'close-to-usdc', basePool);
    expect(onClaimFees).toHaveBeenNthCalledWith(2, 'close-keep-assets', basePool);
  });

  it('muestra botones de cierre en ProtectedPoolCard', async () => {
    const onClaimFees = vi.fn();
    render(
      <ProtectedPoolCard
        protection={{
          id: 1,
          network: 'arbitrum',
          version: 'v3',
          positionIdentifier: '123',
          token0Symbol: 'WETH',
          token1Symbol: 'USDC',
          walletAddress: walletState.address,
          status: 'active',
          protectionMode: 'static',
          leverage: 3,
          configuredHedgeNotionalUsd: 100,
          poolSnapshot: basePool,
        }}
        isDeactivating={false}
        onDeactivate={vi.fn()}
        walletState={walletState}
        onClaimFees={onClaimFees}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Cerrar a USDC/i }));
    await userEvent.click(screen.getByRole('button', { name: /Cerrar LP/i }));

    expect(onClaimFees).toHaveBeenNthCalledWith(1, 'close-to-usdc', expect.objectContaining({ identifier: '123' }));
    expect(onClaimFees).toHaveBeenNthCalledWith(2, 'close-keep-assets', expect.objectContaining({ identifier: '123' }));
  });

  it('prepara close-to-usdc con slippage y muestra aviso de protección', async () => {
    uniswapApi.preparePositionAction.mockResolvedValueOnce({
      action: 'close-to-usdc',
      network: 'arbitrum',
      version: 'v3',
      walletAddress: walletState.address,
      positionIdentifier: '123',
      quoteSummary: {
        targetStableSymbol: 'USDC',
        gasReserve: { symbol: 'ETH', reservedAmount: '0.002' },
      },
      txPlan: [{ label: 'Swap WETH -> USDC' }],
      protectionImpact: { willDeactivateProtection: true },
    });

    render(
      <PositionActionModal
        action="close-to-usdc"
        pool={basePool}
        wallet={walletState}
        sendTransaction={vi.fn()}
        defaults={{ network: 'arbitrum', version: 'v3', walletAddress: walletState.address }}
        onClose={vi.fn()}
      />
    );

    await userEvent.clear(screen.getByLabelText(/Slippage/i));
    await userEvent.type(screen.getByLabelText(/Slippage/i), '150');
    await userEvent.click(screen.getByRole('button', { name: /Preparar acción/i }));

    await waitFor(() => expect(uniswapApi.preparePositionAction).toHaveBeenCalledWith('close-to-usdc', expect.objectContaining({
      positionIdentifier: '123',
      slippageBps: 150,
    })));
    expect(await screen.findByText(/quedará desactivada/i)).toBeTruthy();
  });

  it('prepara close-keep-assets sin campo de slippage', async () => {
    uniswapApi.preparePositionAction.mockResolvedValueOnce({
      action: 'close-keep-assets',
      network: 'arbitrum',
      version: 'v3',
      walletAddress: walletState.address,
      positionIdentifier: '123',
      quoteSummary: {
        closeMode: 'keep_assets',
      },
      txPlan: [{ label: 'Decrease liquidity' }],
      protectionImpact: { willDeactivateProtection: true },
    });

    render(
      <PositionActionModal
        action="close-keep-assets"
        pool={basePool}
        wallet={walletState}
        sendTransaction={vi.fn()}
        defaults={{ network: 'arbitrum', version: 'v3', walletAddress: walletState.address }}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByLabelText(/Slippage/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Preparar acción/i }));

    await waitFor(() => expect(uniswapApi.preparePositionAction).toHaveBeenCalledWith('close-keep-assets', expect.objectContaining({
      positionIdentifier: '123',
    })));
  });
  // Cerrar el LP del orquestador con otra cuenta conectada revertia con
  // NotApproved (un custom error que la wallet muestra como "Execution
  // reverted for an unknown reason"), y no habia forma de cambiar de cuenta
  // sin salir del modal.
  it('avisa del mismatch de wallet y permite cambiarla desde el modal', async () => {
    const changeWallet = vi.fn().mockResolvedValue(null);
    const owner = '0x00000000000000000000000000000000000000e1';

    render(
      <PositionActionModal
        action="close-keep-assets"
        pool={basePool}
        wallet={{ ...walletState, changeWallet }}
        ownerAddress={owner}
        sendTransaction={vi.fn()}
        defaults={{ network: 'arbitrum', version: 'v3', walletAddress: owner }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Firmando con')).toBeTruthy();
    expect(screen.getByText(/la transacción revierte/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Cambiar wallet/i }));
    expect(changeWallet).toHaveBeenCalledTimes(1);
  });

  // El prepare tiene que ir contra la duena de la posicion aunque la conectada
  // sea otra: mandar la conectada devolvia un 400 "no es duena de esta
  // posicion" justo cuando el usuario apretaba "Reintentar".
  it('prepara contra la wallet duena, no contra la conectada', async () => {
    const owner = '0x00000000000000000000000000000000000000e1';
    uniswapApi.preparePositionAction.mockResolvedValueOnce({
      action: 'close-keep-assets',
      network: 'arbitrum',
      version: 'v3',
      walletAddress: owner,
      positionIdentifier: '123',
      quoteSummary: { closeMode: 'keep_assets' },
      txPlan: [{ label: 'Decrease liquidity' }],
    });

    render(
      <PositionActionModal
        action="close-keep-assets"
        pool={basePool}
        wallet={walletState}
        ownerAddress={owner}
        sendTransaction={vi.fn()}
        defaults={{ network: 'arbitrum', version: 'v3', walletAddress: owner }}
        onClose={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Preparar acción/i }));

    await waitFor(() => expect(uniswapApi.preparePositionAction).toHaveBeenCalledWith(
      'close-keep-assets',
      expect.objectContaining({ walletAddress: owner }),
    ));
  });
});
