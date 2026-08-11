import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HedgeProvider, useHedges } from './HedgeContext';

const { addNotification } = vi.hoisted(() => ({ addNotification: vi.fn() }));

vi.mock('./NotificationsContext', () => ({
  useNotifications: () => ({ addNotification }),
}));

vi.mock('../hooks/useAsyncAction', () => ({
  useAsyncAction: () => ({ run: (operation) => operation() }),
}));

vi.mock('../services/api', () => ({
  hedgeApi: {},
}));

describe('HedgeContext', () => {
  it('muestra una notificación crítica cuando la cobertura queda parcial', () => {
    let handleHedgeEvent;
    function Probe() {
      ({ handleHedgeEvent } = useHedges());
      return null;
    }

    render(<HedgeProvider><Probe /></HedgeProvider>);
    act(() => {
      handleHedgeEvent({
        type: 'hedge_event',
        event: 'partial_coverage',
        hedge: {
          id: 77,
          asset: 'SOL',
          direction: 'short',
          account: { alias: 'Principal', address: '0x1234567890123456789012345678901234567890' },
        },
        payload: { actualSize: 0.1, expectedSize: 0.2, missingSize: 0.1 },
      });
    });

    expect(addNotification).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/cobertura parcial.*SOL.*0\.1.*0\.2/is),
      12_000,
    );
  });
});
