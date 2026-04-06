import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SmartCreatePoolModal from './SmartCreatePoolModal';

const { uniswapApi } = vi.hoisted(() => ({
  uniswapApi: {
    getSmartCreateTokenList: vi.fn(),
    smartCreateSuggest: vi.fn(),
    getSmartCreateAssets: vi.fn(),
    smartCreateFundingPlan: vi.fn(),
    prepareCreatePosition: vi.fn(),
    finalizeCreatePosition: vi.fn(),
  },
}));

vi.mock('../../../services/api', () => ({
  uniswapApi,
}));

describe('SmartCreatePoolModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uniswapApi.getSmartCreateTokenList.mockResolvedValue([
      { symbol: 'WETH', address: '0x00000000000000000000000000000000000000AA' },
      { symbol: 'USDC', address: '0x00000000000000000000000000000000000000BB' },
    ]);
    uniswapApi.smartCreateSuggest.mockResolvedValue({
      token0: { symbol: 'WETH', decimals: 18, usdPrice: 2500, address: '0x00000000000000000000000000000000000000AA' },
      token1: { symbol: 'USDC', decimals: 6, usdPrice: 1, address: '0x00000000000000000000000000000000000000BB' },
      currentPrice: 2500,
      atr14: 50,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
      suggestions: [
        { preset: 'conservative', label: 'Conservador', rangeLowerPrice: 2000, rangeUpperPrice: 3000, widthPct: 40, targetWeightToken0Pct: 50, amount0Desired: '0.2', amount1Desired: '500' },
        { preset: 'balanced', label: 'Balanceado', rangeLowerPrice: 2200, rangeUpperPrice: 2800, widthPct: 24, targetWeightToken0Pct: 55, amount0Desired: '0.22', amount1Desired: '450' },
        { preset: 'aggressive', label: 'Agresivo', rangeLowerPrice: 2350, rangeUpperPrice: 2650, widthPct: 12, targetWeightToken0Pct: 60, amount0Desired: '0.24', amount1Desired: '400' },
      ],
    });
    uniswapApi.getSmartCreateAssets.mockResolvedValue({
      gasReserve: { symbol: 'ETH', reservedAmount: '0.002' },
      assets: [
        { id: '0x00000000000000000000000000000000000000bb', symbol: 'USDC', balance: '1200', usableBalance: '1200' },
        { id: 'native', symbol: 'ETH', balance: '0.5', usableBalance: '0.498' },
      ],
    });
    uniswapApi.smartCreateFundingPlan.mockResolvedValue({
      gasReserve: { symbol: 'ETH', reservedAmount: '0.002' },
      availableFundingAssets: [
        { id: '0x00000000000000000000000000000000000000bb', symbol: 'USDC', balance: '1200', usableBalance: '1200' },
        { id: 'native', symbol: 'ETH', balance: '0.5', usableBalance: '0.498' },
      ],
      selectedFundingAssets: [
        { assetId: '0x00000000000000000000000000000000000000bb', symbol: 'USDC', useAmount: '1000', fundingRole: 'swap_source' },
        { assetId: 'native', symbol: 'ETH', useAmount: '0.2', fundingRole: 'direct_token0' },
        { assetId: 'native', symbol: 'ETH', useAmount: '0.1', fundingRole: 'swap_source' },
      ],
      fundingPlan: {
        estimatedPoolValueUsd: 1000,
        directValueUsd: 0,
        swapValueUsd: 1000,
      },
      swapPlan: [
        {
          sourceAssetId: '0x00000000000000000000000000000000000000bb',
          sourceSymbol: 'USDC',
          tokenIn: { symbol: 'USDC' },
          tokenOut: { symbol: 'WETH' },
          fee: 500,
          amountIn: '500',
          estimatedAmountOut: '0.2',
          amountOutMinimum: '0.198',
        },
      ],
    });
    uniswapApi.prepareCreatePosition.mockResolvedValue({
      quoteSummary: {
        token0: { symbol: 'WETH' },
        token1: { symbol: 'USDC' },
        gasReserve: { reservedAmount: '0.002', symbol: 'ETH' },
      },
      fundingPlan: {
        gasReserve: { reservedAmount: '0.002', symbol: 'ETH' },
        selectedFundingAssets: [
          { assetId: '0x00000000000000000000000000000000000000bb', symbol: 'USDC', useAmount: '1000', fundingRole: 'swap_source' },
        ],
      },
      swapPlan: [
        {
          sourceAssetId: '0x00000000000000000000000000000000000000bb',
          tokenIn: { symbol: 'USDC' },
          tokenOut: { symbol: 'WETH' },
          amountIn: '500',
          amountOutMinimum: '0.198',
        },
      ],
      txPlan: [
        { label: 'Approve USDC' },
        { label: 'Swap USDC -> WETH' },
        { label: 'Mint new position' },
      ],
      warnings: [],
    });
  });

  it('recorre el wizard completo hasta review mostrando swaps, approvals y mint', async () => {
    render(
      <SmartCreatePoolModal
        wallet={{ address: '0x00000000000000000000000000000000000000FF' }}
        sendTransaction={vi.fn()}
        defaults={{ network: 'ethereum', version: 'v3' }}
        meta={{ networks: [{ id: 'ethereum', label: 'Ethereum', versions: ['v3', 'v4'] }] }}
        onClose={vi.fn()}
        onFinalized={vi.fn()}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalled());

    await userEvent.selectOptions(screen.getByLabelText(/Token 0/i), '0x00000000000000000000000000000000000000AA');
    await userEvent.selectOptions(screen.getByLabelText(/Token 1/i), '0x00000000000000000000000000000000000000BB');
    await userEvent.clear(screen.getByLabelText(/Valor total objetivo/i));
    await userEvent.type(screen.getByLabelText(/Valor total objetivo/i), '1000');
    await userEvent.click(screen.getByRole('button', { name: /Analizar pool y rango/i }));

    expect(await screen.findByText(/Paso 2: Rango y composición/i)).toBeTruthy();
    expect(screen.getByText(/Balanceado/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Continuar a fondeo/i }));

    expect(await screen.findByText(/Paso 3: Capital fuente y swaps/i)).toBeTruthy();
    expect(screen.getByText(/Reserva de gas/i)).toBeTruthy();
    expect(screen.getByText(/Swaps planeados/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Revisar y preparar firma/i }));

    await waitFor(() => expect(uniswapApi.prepareCreatePosition).toHaveBeenCalledWith(expect.objectContaining({
      fundingSelections: expect.arrayContaining([
        expect.objectContaining({ assetId: 'native', amount: '0.3', enabled: true }),
      ]),
    })));

    expect(await screen.findByText(/Paso 4: Review y firma/i)).toBeTruthy();
    expect(screen.getByText(/Activos fuente seleccionados/i)).toBeTruthy();
    expect(screen.getByText(/Transacciones a firmar \(3\)/i)).toBeTruthy();
    expect(screen.getByText(/Approve USDC/i)).toBeTruthy();
    expect(screen.getByText(/Swap USDC -> WETH/i)).toBeTruthy();
    expect(screen.getByText(/Mint new position/i)).toBeTruthy();
  }, 15000);

  it('usa la red activa de la página y muestra diagnóstico accionable cuando falla el fondeo', async () => {
    const fundingError = new Error('No hay capital suficiente en Ethereum después de reservar 0.01 ETH para gas.');
    fundingError.code = 'INSUFFICIENT_BALANCE_AFTER_GAS_RESERVE';
    fundingError.details = {
      network: 'ethereum',
      gasReserve: {
        symbol: 'ETH',
        reservedAmount: '0.01',
        nativeBalance: '0.00059',
        usableNative: '0',
      },
      totalUsdTarget: 1000,
      deployableUsd: 0,
      missingUsd: 1000,
      availableFundingAssets: [
        { id: 'native', symbol: 'ETH', balance: '0.00059', usableBalance: '0' },
      ],
    };
    uniswapApi.smartCreateFundingPlan.mockRejectedValueOnce(fundingError);

    render(
      <SmartCreatePoolModal
        wallet={{ address: '0x00000000000000000000000000000000000000FF' }}
        sendTransaction={vi.fn()}
        defaults={{ network: 'arbitrum', version: 'v3' }}
        meta={{ networks: [{ id: 'ethereum', label: 'Ethereum', versions: ['v3'] }, { id: 'arbitrum', label: 'Arbitrum', versions: ['v3', 'v4'] }] }}
        onClose={vi.fn()}
        onFinalized={vi.fn()}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalledWith('arbitrum'));

    await userEvent.selectOptions(screen.getByLabelText(/Token 0/i), '0x00000000000000000000000000000000000000AA');
    await userEvent.selectOptions(screen.getByLabelText(/Token 1/i), '0x00000000000000000000000000000000000000BB');
    await userEvent.clear(screen.getByLabelText(/Valor total objetivo/i));
    await userEvent.type(screen.getByLabelText(/Valor total objetivo/i), '1000');
    await userEvent.click(screen.getByRole('button', { name: /Analizar pool y rango/i }));
    await screen.findByText(/Paso 2: Rango y composición/i);

    await userEvent.click(screen.getByRole('button', { name: /Continuar a fondeo/i }));

    await screen.findByText(/Saldo insuficiente después de reservar gas/i);
    expect(screen.getByText(/Fondos en otras redes no se consideran automáticamente/i)).toBeTruthy();
    expect(screen.getByText(/Cambiar red en la página/i)).toBeTruthy();
    expect(uniswapApi.smartCreateSuggest).toHaveBeenCalledWith(expect.objectContaining({ network: 'arbitrum' }));
    expect(uniswapApi.smartCreateFundingPlan).toHaveBeenCalledWith(expect.objectContaining({ network: 'arbitrum' }));
  }, 15000);

  it('espera confirmación on-chain de cada tx y corta si una falla', async () => {
    const sendTransaction = vi
      .fn()
      .mockResolvedValueOnce('0xaaa')
      .mockResolvedValueOnce('0xbbb');
    const waitForTransactionReceipt = vi
      .fn()
      .mockResolvedValueOnce({ status: 1 })
      .mockResolvedValueOnce({ status: 0 });

    render(
      <SmartCreatePoolModal
        wallet={{ address: '0x00000000000000000000000000000000000000FF' }}
        sendTransaction={sendTransaction}
        waitForTransactionReceipt={waitForTransactionReceipt}
        defaults={{ network: 'arbitrum', version: 'v3' }}
        meta={{ networks: [{ id: 'arbitrum', label: 'Arbitrum', versions: ['v3', 'v4'] }] }}
        onClose={vi.fn()}
        onFinalized={vi.fn()}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalledWith('arbitrum'));
    await userEvent.selectOptions(screen.getByLabelText(/Token 0/i), '0x00000000000000000000000000000000000000AA');
    await userEvent.selectOptions(screen.getByLabelText(/Token 1/i), '0x00000000000000000000000000000000000000BB');
    await userEvent.clear(screen.getByLabelText(/Valor total objetivo/i));
    await userEvent.type(screen.getByLabelText(/Valor total objetivo/i), '1000');
    await userEvent.click(screen.getByRole('button', { name: /Analizar pool y rango/i }));
    await screen.findByText(/Paso 2: Rango y composición/i);
    await userEvent.click(screen.getByRole('button', { name: /Continuar a fondeo/i }));
    await screen.findByText(/Paso 3: Capital fuente y swaps/i);
    await userEvent.click(screen.getByRole('button', { name: /Revisar y preparar firma/i }));
    await screen.findByText(/Paso 4: Review y firma/i);
    await userEvent.click(screen.getByRole('button', { name: /Firmar con wallet/i }));

    expect((await screen.findAllByText(/Swap USDC -> WETH/)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/falló on-chain/i)).toBeTruthy();
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(waitForTransactionReceipt).toHaveBeenNthCalledWith(1, '0xaaa');
    expect(waitForTransactionReceipt).toHaveBeenNthCalledWith(2, '0xbbb');
    expect(uniswapApi.finalizeCreatePosition).not.toHaveBeenCalled();
  }, 15000);

  it('permite reintentar desde la tx fallida sin repetir las completadas', async () => {
    const sendTransaction = vi
      .fn()
      .mockResolvedValueOnce('0xaaa')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('0xbbb')
      .mockResolvedValueOnce('0xccc');
    const waitForTransactionReceipt = vi
      .fn()
      .mockResolvedValueOnce({ status: 1 })
      .mockResolvedValueOnce({ status: 1 })
      .mockResolvedValueOnce({ status: 1 });

    render(
      <SmartCreatePoolModal
        wallet={{ address: '0x00000000000000000000000000000000000000FF' }}
        sendTransaction={sendTransaction}
        waitForTransactionReceipt={waitForTransactionReceipt}
        defaults={{ network: 'arbitrum', version: 'v3' }}
        meta={{ networks: [{ id: 'arbitrum', label: 'Arbitrum', versions: ['v3', 'v4'], explorerUrl: 'https://arbiscan.io' }] }}
        onClose={vi.fn()}
        onFinalized={vi.fn()}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalledWith('arbitrum'));
    await userEvent.selectOptions(screen.getByLabelText(/Token 0/i), '0x00000000000000000000000000000000000000AA');
    await userEvent.selectOptions(screen.getByLabelText(/Token 1/i), '0x00000000000000000000000000000000000000BB');
    await userEvent.clear(screen.getByLabelText(/Valor total objetivo/i));
    await userEvent.type(screen.getByLabelText(/Valor total objetivo/i), '1000');
    await userEvent.click(screen.getByRole('button', { name: /Analizar pool y rango/i }));
    await screen.findByText(/Paso 2: Rango y composición/i);
    await userEvent.click(screen.getByRole('button', { name: /Continuar a fondeo/i }));
    await screen.findByText(/Paso 3: Capital fuente y swaps/i);
    await userEvent.click(screen.getByRole('button', { name: /Revisar y preparar firma/i }));
    await screen.findByText(/Paso 4: Review y firma/i);
    await userEvent.click(screen.getByRole('button', { name: /Firmar con wallet/i }));

    // Tx 1 OK, Tx 2 cancelled → error with retry
    expect(await screen.findByText(/no devolvió un hash/i)).toBeTruthy();
    expect(screen.getByText(/Transacciones completadas exitosamente/i)).toBeTruthy();
    expect(screen.getByText(/Reintentar desde aquí/i)).toBeTruthy();

    // Retry — should resume from tx 2
    await userEvent.click(screen.getByRole('button', { name: /Reintentar desde aquí/i }));

    await waitFor(() => expect(uniswapApi.finalizeCreatePosition).toHaveBeenCalled());
    expect(sendTransaction).toHaveBeenCalledTimes(4);
  }, 20000);

  it('muestra links al explorador en DONE y no cierra automáticamente', async () => {
    const sendTransaction = vi.fn().mockResolvedValue('0xabc123def456');
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 1 });
    const onClose = vi.fn();

    uniswapApi.prepareCreatePosition.mockResolvedValue({
      quoteSummary: { token0: { symbol: 'WETH' }, token1: { symbol: 'USDC' } },
      fundingPlan: { selectedFundingAssets: [] },
      txPlan: [{ label: 'Mint new position' }],
      warnings: [],
    });

    render(
      <SmartCreatePoolModal
        wallet={{ address: '0x00000000000000000000000000000000000000FF' }}
        sendTransaction={sendTransaction}
        waitForTransactionReceipt={waitForTransactionReceipt}
        defaults={{ network: 'arbitrum', version: 'v3' }}
        meta={{ networks: [{ id: 'arbitrum', label: 'Arbitrum', versions: ['v3', 'v4'], explorerUrl: 'https://arbiscan.io' }] }}
        onClose={onClose}
        onFinalized={vi.fn()}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalled());
    await userEvent.selectOptions(screen.getByLabelText(/Token 0/i), '0x00000000000000000000000000000000000000AA');
    await userEvent.selectOptions(screen.getByLabelText(/Token 1/i), '0x00000000000000000000000000000000000000BB');
    await userEvent.clear(screen.getByLabelText(/Valor total objetivo/i));
    await userEvent.type(screen.getByLabelText(/Valor total objetivo/i), '1000');
    await userEvent.click(screen.getByRole('button', { name: /Analizar pool y rango/i }));
    await screen.findByText(/Paso 2/i);
    await userEvent.click(screen.getByRole('button', { name: /Continuar a fondeo/i }));
    await screen.findByText(/Paso 3/i);
    await userEvent.click(screen.getByRole('button', { name: /Revisar y preparar firma/i }));
    await screen.findByText(/Paso 4/i);
    await userEvent.click(screen.getByRole('button', { name: /Firmar con wallet/i }));

    // DONE state: success message, explorer link, no auto-close
    expect(await screen.findByText(/Posición LP creada correctamente/i)).toBeTruthy();
    expect(screen.getByText(/Transacciones confirmadas/i)).toBeTruthy();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toContain('arbiscan.io/tx/0xabc123def456');
    expect(onClose).not.toHaveBeenCalled();

    // Manual close — use the primary "Cerrar" button (not the header ✕)
    const closeButtons = screen.getAllByRole('button', { name: /Cerrar/i });
    const primaryClose = closeButtons.find((btn) => btn.classList.contains('_primaryBtn_55922a')) || closeButtons[closeButtons.length - 1];
    await userEvent.click(primaryClose);
    expect(onClose).toHaveBeenCalledTimes(1);
  }, 20000);

  it('muestra error de expiración si el plan es viejo', async () => {
    uniswapApi.prepareCreatePosition.mockResolvedValue({
      quoteSummary: { token0: { symbol: 'WETH' }, token1: { symbol: 'USDC' } },
      fundingPlan: { selectedFundingAssets: [] },
      txPlan: [{ label: 'Mint new position' }],
      warnings: [],
      preparedAt: Date.now() - 700_000,
      expiresAt: Date.now() - 100_000,
    });

    render(
      <SmartCreatePoolModal
        wallet={{ address: '0x00000000000000000000000000000000000000FF' }}
        sendTransaction={vi.fn()}
        defaults={{ network: 'arbitrum', version: 'v3' }}
        meta={{ networks: [{ id: 'arbitrum', label: 'Arbitrum', versions: ['v3', 'v4'] }] }}
        onClose={vi.fn()}
        onFinalized={vi.fn()}
      />
    );

    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalled());
    await userEvent.selectOptions(screen.getByLabelText(/Token 0/i), '0x00000000000000000000000000000000000000AA');
    await userEvent.selectOptions(screen.getByLabelText(/Token 1/i), '0x00000000000000000000000000000000000000BB');
    await userEvent.clear(screen.getByLabelText(/Valor total objetivo/i));
    await userEvent.type(screen.getByLabelText(/Valor total objetivo/i), '1000');
    await userEvent.click(screen.getByRole('button', { name: /Analizar pool y rango/i }));
    await screen.findByText(/Paso 2/i);
    await userEvent.click(screen.getByRole('button', { name: /Continuar a fondeo/i }));
    await screen.findByText(/Paso 3/i);
    await userEvent.click(screen.getByRole('button', { name: /Revisar y preparar firma/i }));
    await screen.findByText(/Paso 4/i);
    await userEvent.click(screen.getByRole('button', { name: /Firmar con wallet/i }));

    // Should show expiry error and stay on REVIEW step
    expect(await screen.findByText(/El plan expiró/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Firmar con wallet/i })).toBeTruthy();
  }, 15000);
});
