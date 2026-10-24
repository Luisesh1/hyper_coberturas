import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  lpOrchestratorApi: { listSegments: vi.fn(), getSegment: vi.fn() },
}));

import { lpOrchestratorApi } from '../../../services/api';
import SegmentsSection from './SegmentsSection';

function seg(seq, over = {}) {
  return {
    id: seq, seq, status: 'closed', accuracy: 'exact', openedAt: 1_700_000_000_000, closedAt: 1_700_003_600_000,
    rangeLowerPrice: 2400, rangeUpperPrice: 2600, openPrice: 2500, closePrice: 2610,
    openReason: 'rerange', closeReason: 'range_exit_above',
    accounting: { lpFeesUsd: 3, totalNetPnlUsd: 2 }, coverage: { avgPct: 95 },
    ...over,
  };
}

function mockList(segments, differenceUsd = 0) {
  lpOrchestratorApi.listSegments.mockResolvedValue({
    segments,
    totals: { sumNetPnlUsd: 0, orchestratorNetPnlUsd: differenceUsd, differenceUsd },
  });
}

async function open() {
  fireEvent.click(screen.getByRole('button', { name: /Tramos/ }));
  await waitFor(() => expect(lpOrchestratorApi.listSegments).toHaveBeenCalled());
}

describe('SegmentsSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no pide nada hasta que se despliega', () => {
    mockList([seg(1)]);
    render(<SegmentsSection orchestratorId={5} />);
    expect(lpOrchestratorApi.listSegments).not.toHaveBeenCalled();
  });

  it('pinta la insignia «aproximado» solo en tramos reconstruidos', async () => {
    mockList([seg(2), seg(1, { accuracy: 'approximate' })]);
    render(<SegmentsSection orchestratorId={5} />);
    await open();
    expect(await screen.findByText('#2')).toBeTruthy();
    expect(screen.getAllByText('aproximado')).toHaveLength(1);
  });

  it('la línea «Diferencia de reconstrucción» solo aparece si es distinta de cero', async () => {
    mockList([seg(1)], 0);
    const { unmount } = render(<SegmentsSection orchestratorId={5} />);
    await open();
    await screen.findByText('#1');
    expect(screen.queryByText('Diferencia de reconstrucción')).toBeNull();
    unmount();

    vi.clearAllMocks();
    mockList([seg(1)], -2.5);
    render(<SegmentsSection orchestratorId={5} />);
    await open();
    expect(await screen.findByText('Diferencia de reconstrucción')).toBeTruthy();
  });

  it('al desplegar un tramo carga sus reajustes', async () => {
    mockList([seg(1)]);
    lpOrchestratorApi.getSegment.mockResolvedValue({
      ...seg(1),
      rebalances: [{ id: 9, createdAt: 1_700_000_100_000, reason: 'price_move', actualQtyAfter: 1.5, targetQtyAfter: 1.5 }],
    });
    render(<SegmentsSection orchestratorId={5} />);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /#1/ }));
    expect(await screen.findByText('Fees LP ganadas')).toBeTruthy();
    expect(await screen.findByText('Reajustes del short')).toBeTruthy();
    expect(lpOrchestratorApi.getSegment).toHaveBeenCalledWith(5, 1);
  });
});
