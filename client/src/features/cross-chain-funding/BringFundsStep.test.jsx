import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import BringFundsStep from './BringFundsStep';

const LABELS = { arbitrum: 'Arbitrum One', base: 'Base' };
const step = (overrides) => ({
  order: 1, sourceNetwork: 'arbitrum', status: 'pending', token: { symbol: 'USDC', decimals: 6, isNative: false },
  amountRaw: '345000000', amountUsd: 345, receivedUsd: 344.89, deliveryToken: { symbol: 'USDC', decimals: 6 },
  provider: 'across', estCostUsd: 0.15, realCostUsd: null, isSlow: false, txHash: null, ...overrides,
});
const plan = (steps, status = 'executing') => ({ id: 3, destinationNetwork: 'base', profile: 'low', status, steps });

function renderStep(props) {
  const handlers = {
    onStart: vi.fn(), onAnswerConfirm: vi.fn(), onSpeedUp: vi.fn(), onSkip: vi.fn(),
    onContinueWithArrived: vi.fn(), onDiscard: vi.fn(), onContinueToLp: vi.fn(),
  };
  render(<BringFundsStep networkLabels={LABELS} running={false} {...handlers} {...props} />);
  return handlers;
}

describe('BringFundsStep', () => {
  it('muestra el progreso y firma los envíos pendientes', async () => {
    const h = renderStep({ plan: plan([step({ status: 'delivered', realCostUsd: 0.14 }), step({ order: 2, token: { symbol: 'ETH', decimals: 18, isNative: true }, amountRaw: '200000000000000000' })]) });
    expect(screen.getByText(/1 de 2 envíos entregados/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Firmar envíos/ }));
    expect(h.onStart).toHaveBeenCalled();
  });

  it('una tx enviada que no entra ofrece acelerar', async () => {
    const h = renderStep({ plan: plan([step({ status: 'signed', txHash: '0xa' })]) });
    const item = screen.getByRole('listitem', { name: /Envío 1/ });
    await userEvent.click(within(item).getByRole('button', { name: /Acelerar/ }));
    expect(h.onSpeedUp).toHaveBeenCalledWith(1);
  });

  it('un bridge lento ofrece seguir con lo que llegó', async () => {
    const h = renderStep({ plan: plan([step({ status: 'source_confirmed', isSlow: true })]) });
    expect(screen.getByText(/tarda más de lo previsto/i)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Seguir con lo que llegó/ }));
    expect(h.onContinueWithArrived).toHaveBeenCalled();
  });

  it('un paso fallido se puede saltar', async () => {
    const h = renderStep({ plan: plan([step({ status: 'failed', errorMessage: 'revirtió' })]) });
    expect(screen.getByText('revirtió')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Saltar envío 1/ }));
    expect(h.onSkip).toHaveBeenCalledWith(1);
  });

  it('si el costo subió pide confirmar', async () => {
    const h = renderStep({ plan: plan([step()]), confirm: { order: 1, previousCostUsd: 0.2, newCostUsd: 0.5 } });
    expect(screen.getByRole('alertdialog').textContent).toMatch(/\$0\.20.*\$0\.50/);
    await userEvent.click(screen.getByRole('button', { name: /Firmar igual/ }));
    expect(h.onAnswerConfirm).toHaveBeenCalledWith(true);
  });

  it('avisa si la wallet ignoró las fees del perfil', () => {
    renderStep({ plan: plan([step({ status: 'source_confirmed', walletOverrodeFees: true })]) });
    expect(screen.getByText(/la wallet pagó más/i)).toBeTruthy();
  });

  it('al terminar muestra estimado vs real y deja continuar con el LP', async () => {
    const h = renderStep({ plan: plan([step({ status: 'delivered', estCostUsd: 0.15, realCostUsd: 0.14 })], 'delivered') });
    const table = screen.getByRole('table', { name: /estimado vs real/i });
    // la fila del envío y la de total
    expect(within(table).getAllByText('$0.15')).toHaveLength(2);
    expect(within(table).getAllByText('$0.14')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: /Continuar con el LP/ }));
    expect(h.onContinueToLp).toHaveBeenCalled();
  });

  it('un plan descartado no deja continuar con el LP', () => {
    renderStep({ plan: plan([step()], 'discarded') });
    expect(screen.queryByRole('button', { name: /Continuar con el LP/ })).toBeNull();
    expect(screen.getByText(/descartado/i)).toBeTruthy();
  });
});
