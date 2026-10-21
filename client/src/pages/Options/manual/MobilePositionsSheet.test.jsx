import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobilePositionsSheet from './MobilePositionsSheet';

const trade = { id: 't1', symbol: 'BTC-261021-83000-C', side: 'SELL', price: 70, quantity: 0.7,
  fee: -4.9, realizedProfit: 10.5, time: Date.UTC(2026, 9, 20, 20, 5) };

function renderHistory() {
  return render(
    <MemoryRouter>
      <MobilePositionsSheet open onClose={() => {}} section="history" onSection={() => {}} configured
        account={{ greeks: {} }} positions={[]} openOrders={[]} trades={[trade]} tradesLoading={false}
        pending={false} onClosePosition={() => {}} onCloseAtPrice={() => {}} onCancelOrder={() => {}} />
    </MemoryRouter>,
  );
}

describe('historial móvil desplegable', () => {
  it('oculta el detalle hasta tocar la ejecución y luego muestra comisión y prima total', () => {
    renderHistory();
    expect(screen.queryByText('Comisión')).toBeNull();
    const toggle = screen.getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Comisión')).toBeTruthy();
    expect(screen.getByText('−4,9000')).toBeTruthy();
    expect(screen.getByText('Prima cobrada')).toBeTruthy();
    expect(screen.getByText('49,00 USDT')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText('Comisión')).toBeNull();
  });
});
