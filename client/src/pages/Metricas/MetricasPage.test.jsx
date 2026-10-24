import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// lightweight-charts no se dibuja en jsdom: aqui interesa que la fila abierta
// reciba la serie que ya trajo la pagina.
vi.mock('./components/WalletValueChart', () => ({
  LAYER_COLORS: { tokens: '#a', lp: '#b', hl: '#c' },
  default: ({ points }) => <div data-testid="chart">{points.length} puntos</div>,
}));

vi.mock('../../services/api', () => ({
  walletMetricsApi: {
    list: vi.fn(),
    getSnapshots: vi.fn(),
    get: vi.fn(),
    refresh: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
  },
}));

const { walletMetricsApi } = await import('../../services/api');
const MetricasPage = (await import('./MetricasPage')).default;

const HOUR = 3_600_000;
const now = Math.floor(Date.now() / HOUR) * HOUR;

const totals = (totalUsd, tokensUsd, lpUsd, hlUsd) => ({ totalUsd, tokensUsd, lpUsd, hlUsd });

const WALLETS = [
  {
    id: 1,
    address: '0xaaaa000000000000000000000000000000000001',
    status: 'active',
    latest: { capturedAt: now, totals: totals(1200, 200, 900, 100), isPartial: false, staleSources: [] },
  },
  {
    id: 2,
    address: '0xbbbb000000000000000000000000000000000002',
    status: 'active',
    latest: {
      capturedAt: now,
      totals: totals(300, 300, 0, 0),
      isPartial: true,
      staleSources: [{ key: 'lps:polygon', lastOkAt: now - 3 * HOUR }],
    },
  },
  {
    id: 3,
    address: '0xcccc000000000000000000000000000000000003',
    status: 'archived',
    archivedAt: now - 24 * HOUR,
    latest: { capturedAt: now - 25 * HOUR, totals: totals(50, 50, 0, 0), isPartial: false, staleSources: [] },
  },
];

const pt = (h, total) => ({ t: now - h * HOUR, total, tokens: total, lp: 0, hl: 0, partial: false });

const SERIES = {
  1: [pt(2, 1000), pt(1, 1100), pt(0, 1200)],
  // Entra a mitad de rango: su primer punto no es ganancia.
  2: [pt(1, 310), pt(0, 300)],
};

describe('MetricasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletMetricsApi.list.mockResolvedValue(WALLETS);
    walletMetricsApi.getSnapshots.mockImplementation(({ ids }) =>
      Promise.resolve(Object.fromEntries(ids.map((id) => [id, SERIES[id] || []]))));
    walletMetricsApi.get.mockImplementation((id) => Promise.resolve({
      ...WALLETS.find((w) => w.id === Number(id)),
      lastDetail: {
        capturedAt: now,
        totals: totals(1200, 200, 900, 100),
        staleSources: [],
        sources: {
          'tokens:arbitrum': {
            items: [
              { network: 'arbitrum', symbol: 'USDC', address: '0x1', balance: 200, usd: 200, priced: true },
              { network: 'arbitrum', symbol: 'SPAM', address: '0x2', balance: 9, usd: 0, priced: false },
            ],
          },
          'lps:arbitrum': {
            items: [{
              id: 'v3:arbitrum:42', network: 'arbitrum', version: 'v3', tokenId: '42',
              token0Symbol: 'WETH', token1Symbol: 'USDC', inRange: true, usd: 900, feesUsd: 3,
            }],
          },
          hl: { usd: 100, items: [], meta: { perpUsd: 100, positionsCount: 1 } },
        },
      },
    }));
  });

  it('resume solo las wallets activas: total y suma de cambios por wallet', async () => {
    render(<MetricasPage />);

    const strip = await screen.findByLabelText('Resumen de las wallets');
    expect(strip.textContent).toContain('2 wallets');
    expect(strip.textContent).toContain('$1,500.00');
    // +200 de la primera, −10 de la segunda; la entrada de $310 no es ganancia.
    await waitFor(() => expect(strip.textContent).toContain('+$190.00'));
    expect(screen.queryByText(/0xcccc/)).toBeNull();
  });

  it('marca la wallet con fuentes que usan su ultimo valor', async () => {
    render(<MetricasPage />);
    await screen.findByText('0xbbbb…0002');
    expect(screen.getByText('Parcial')).toBeTruthy();
  });

  it('al abrir una wallet muestra lo que tiene ahora y la serie ya cargada', async () => {
    const user = userEvent.setup();
    render(<MetricasPage />);

    await user.click(await screen.findByRole('button', { name: /0xaaaa…0001/ }));

    expect(await screen.findByText('WETH/USDC')).toBeTruthy();
    expect(screen.getByTestId('chart').textContent).toBe('3 puntos');
    // Los tokens sin precio quedan plegados.
    expect(screen.queryByText('SPAM')).toBeNull();
    expect(screen.getByText(/1 sin precio/)).toBeTruthy();
  });

  it('archivar llama a la API y recarga la lista', async () => {
    const user = userEvent.setup();
    walletMetricsApi.archive.mockResolvedValue({});
    render(<MetricasPage />);

    await user.click(await screen.findByRole('button', { name: /0xaaaa…0001/ }));
    await user.click(await screen.findByRole('button', { name: 'Archivar wallet' }));

    expect(walletMetricsApi.archive).toHaveBeenCalledWith(1);
    await waitFor(() => expect(walletMetricsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('la pestaña Archivadas muestra las archivadas con opcion de reactivar', async () => {
    const user = userEvent.setup();
    render(<MetricasPage />);
    await screen.findByText('0xaaaa…0001');

    await user.click(screen.getByRole('button', { name: 'Archivadas' }));
    await user.click(await screen.findByRole('button', { name: /0xcccc…0003/ }));

    expect(screen.getByText('Archivada')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Reactivar seguimiento' })).toBeTruthy();
  });

  it('enlaza los orquestadores abiertos de la wallet con su id', async () => {
    walletMetricsApi.list.mockResolvedValue([
      { ...WALLETS[0], openOrchestrators: [{ id: 42, name: 'ETH/USDC Arbitrum' }] },
      WALLETS[1],
    ]);
    render(<MemoryRouter><MetricasPage /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: /ETH\/USDC Arbitrum/ });
    expect(link.getAttribute('href')).toBe('/lp-orchestrator?focus=42');
    expect(link.textContent).toContain('#42');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
