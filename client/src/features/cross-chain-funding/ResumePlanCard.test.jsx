import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ResumePlanCard, { wizardDefaultsFromPlan } from './ResumePlanCard';

const { crossChainApi } = vi.hoisted(() => ({
  crossChainApi: { getConfig: vi.fn(), getActivePlan: vi.fn(), discardPlan: vi.fn() },
}));
vi.mock('../../services/api', () => ({ crossChainApi }));

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const PLAN = {
  id: 9,
  destinationNetwork: 'base',
  profile: 'low',
  status: 'executing',
  request: {
    network: 'base', version: 'v4', totalUsdTarget: 1000,
    token0: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH' },
    token1: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC' },
    wizardContext: { fee: 500, token0Address: '0x0000000000000000000000000000000000000000', token1Address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  },
  steps: [{ order: 1, status: 'delivered' }, { order: 2, status: 'source_confirmed' }],
};

describe('ResumePlanCard', () => {
  beforeEach(() => {
    crossChainApi.getConfig.mockResolvedValue({ mode: 'execute' });
    crossChainApi.getActivePlan.mockResolvedValue(PLAN);
    crossChainApi.discardPlan.mockResolvedValue({ ...PLAN, status: 'discarded' });
  });

  it('muestra el plan en curso con su progreso y lo retoma', async () => {
    const onResume = vi.fn();
    render(<ResumePlanCard walletAddress={WALLET} onResume={onResume} />);
    await waitFor(() => expect(screen.getByText(/Tienes un plan de fondeo en curso/)).toBeTruthy());
    expect(screen.getByText(/1 de 2 envíos entregados/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Continuar trayendo fondos/ }));
    expect(onResume).toHaveBeenCalledWith(PLAN);
  });

  it('descartar no mueve fondos y oculta el aviso', async () => {
    render(<ResumePlanCard walletAddress={WALLET} onResume={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Descartar plan/ })).toBeTruthy());
    expect(screen.getByText(/Descartar no mueve fondos/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Descartar plan/ }));
    expect(crossChainApi.discardPlan).toHaveBeenCalledWith(9);
    await waitFor(() => expect(screen.queryByText(/plan de fondeo en curso/)).toBeNull());
  });

  it('sin plan, o con la función apagada, no muestra nada', async () => {
    crossChainApi.getActivePlan.mockResolvedValue(null);
    const { container } = render(<ResumePlanCard walletAddress={WALLET} onResume={vi.fn()} />);
    await waitFor(() => expect(crossChainApi.getActivePlan).toHaveBeenCalled());
    expect(container.textContent).toBe('');

    crossChainApi.getActivePlan.mockClear();
    crossChainApi.getConfig.mockResolvedValue({ mode: 'off' });
    render(<ResumePlanCard walletAddress={WALLET} onResume={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(crossChainApi.getActivePlan).not.toHaveBeenCalled();
  });

  it('arma los defaults del asistente desde el plan', () => {
    expect(wizardDefaultsFromPlan(PLAN)).toEqual({
      network: 'base',
      version: 'v4',
      token0Address: '0x0000000000000000000000000000000000000000',
      token1Address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      fee: 500,
      totalUsdTarget: 1000,
    });
  });
});
