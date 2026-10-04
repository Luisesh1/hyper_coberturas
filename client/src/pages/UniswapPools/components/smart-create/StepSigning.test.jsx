import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StepSigning from './StepSigning';

const PLAN = { txPlan: [{ kind: 'wrap', label: 'Wrap native to WETH' }] };

describe('StepSigning — cancelar la espera de la wallet', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ofrece cancelar tras 20 s esperando a la wallet', () => {
    const onCancelWait = vi.fn();
    render(
      <StepSigning prepareData={PLAN} completedTxIndex={-1} currentTxIndex={0} txHashes={[]}
        awaitingWallet onCancelWait={onCancelWait} />
    );
    expect(screen.queryByText('Cancelar espera')).toBeNull();

    act(() => { vi.advanceTimersByTime(20_000); });
    fireEvent.click(screen.getByText('Cancelar espera'));

    expect(onCancelWait).toHaveBeenCalledTimes(1);
  });

  it('no lo ofrece mientras no se espera a la wallet', () => {
    render(
      <StepSigning prepareData={PLAN} completedTxIndex={-1} currentTxIndex={0} txHashes={[]}
        awaitingWallet={false} onCancelWait={vi.fn()} />
    );
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText('Cancelar espera')).toBeNull();
  });
});
