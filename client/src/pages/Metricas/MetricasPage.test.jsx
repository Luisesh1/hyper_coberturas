import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// La tarjeta expandida monta lightweight-charts, que jsdom no sabe dibujar.
// Aqui interesa que la fila la despliegue con la serie ya en la mano, no el canvas.
vi.mock('./components/OrchestratorMetricChart', () => ({
  default: ({ orchestrator, snapshots }) => (
    <div data-testid="chart">
      {orchestrator.name}: {snapshots.length} snapshots
    </div>
  ),
}));

vi.mock('../../services/api', () => ({
  lpOrchestratorApi: { list: vi.fn() },
  metricsApi: { getSnapshots: vi.fn() },
}));

const { lpOrchestratorApi, metricsApi } = await import('../../services/api');
const MetricasPage = (await import('./MetricasPage')).default;

const HOUR = 3_600_000;
const now = Date.now();

function snapshot(offsetHours, totalUsd, pnl, tracking) {
  return {
    capturedAt: now - offsetHours * HOUR,
    totalUsd,
    walletUsd: 0,
    lpUsd: totalUsd,
    hlAccountUsd: 0,
    breakdown: { accounting: { totalNetPnlUsd: pnl }, hedgeTracking: tracking },
  };
}

const ORCHESTRATORS = [
  {
    id: 1, name: 'ETH-uno', status: 'active', network: 'arbitrum', version: 'v3',
    token0Symbol: 'ETH', token1Symbol: 'USDC', initialTotalUsd: 1000,
    activeProtectedPoolId: 7,
    accounting: { totalNetPnlUsd: 120, capitalAdjustmentsUsd: 0 },
  },
  {
    id: 2, name: 'ARB-dos', status: 'active', network: 'arbitrum', version: 'v4',
    token0Symbol: 'ARB', token1Symbol: 'USDC', initialTotalUsd: 500,
    activeProtectedPoolId: null,
    accounting: { totalNetPnlUsd: -30, capitalAdjustmentsUsd: 0 },
  },
];

const SNAPSHOTS = {
  1: [
    snapshot(3, 1000, 100, { hasHedge: true, distanceToLiqPct: 45, projectedDailyFundingUsd: 2 }),
    snapshot(1, 1180, 120, { hasHedge: true, distanceToLiqPct: 42, projectedDailyFundingUsd: 2 }),
  ],
  2: [],
};

describe('MetricasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lpOrchestratorApi.list.mockResolvedValue(ORCHESTRATORS);
    metricsApi.getSnapshots.mockImplementation((id) => Promise.resolve(SNAPSHOTS[id] ?? []));
  });

  it('resume el portafolio y lista una fila por orquestador', async () => {
    render(<MetricasPage />);

    expect(await screen.findByText(/ETH-uno · ETH\/USDC/)).toBeTruthy();
    expect(screen.getByText(/ARB-dos · ARB\/USDC/)).toBeTruthy();

    // 120 + (−30) de la contabilidad viva de ambos.
    const strip = screen.getByLabelText('Resumen del portafolio');
    expect(strip.textContent).toContain('+$90.00');
    expect(strip.textContent).toContain('P&L neto · 2 orquestadores');
    // Solo el primero reporta capital: la cifra es cierta pero parcial y lo dice.
    await waitFor(() => expect(strip.textContent).toContain('1 de 2'));
  });

  it('marca al que no tiene cobertura ni snapshots sin inventarle cifras', async () => {
    render(<MetricasPage />);
    await screen.findByText(/ARB-dos/);

    expect(screen.getByText('Sin cobertura')).toBeTruthy();
    // El badge solo aparece cuando la carga termino: durante el fetch ninguna
    // fila puede afirmar que no tiene snapshots.
    await waitFor(() => expect(screen.getByText('Sin snapshots aún')).toBeTruthy());
  });

  it('despliega la tarjeta con la serie que ya trae la fila, sin volver a pedirla', async () => {
    const user = userEvent.setup();
    render(<MetricasPage />);

    const row = await screen.findByRole('button', { name: /ETH-uno/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    const callsBefore = metricsApi.getSnapshots.mock.calls.length;

    await user.click(row);

    await waitFor(() => expect(screen.getByTestId('chart').textContent).toContain('ETH-uno: 2 snapshots'));
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(metricsApi.getSnapshots.mock.calls).toHaveLength(callsBefore);
  });

  it('el acordeon deja una sola tarjeta abierta', async () => {
    const user = userEvent.setup();
    render(<MetricasPage />);

    await user.click(await screen.findByRole('button', { name: /ETH-uno/ }));
    await user.click(screen.getByRole('button', { name: /ARB-dos/ }));

    const charts = screen.getAllByTestId('chart');
    expect(charts).toHaveLength(1);
    expect(charts[0].textContent).toContain('ARB-dos: 0 snapshots');
  });
});
