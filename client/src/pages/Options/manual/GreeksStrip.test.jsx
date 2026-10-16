import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import GreeksStrip from './GreeksStrip';

describe('fondos de la cuenta Binance Opciones', () => {
  it('muestra saldo USDT real sin establecer un balance fijo de 300', () => {
    render(<GreeksStrip account={{ balanceUsdt: 300.45, marginUsedUsdt: 21,
      unrealizedPnlUsdt: 0, greeks: {} }} />);
    expect(screen.getByText('Fondos de opciones')).toBeTruthy();
    expect(screen.getByText('300,45 USDT')).toBeTruthy();
  });

  it('si el saldo no fue confirmado nunca lo muestra como cero', () => {
    render(<GreeksStrip account={{ balanceUsdt: null, marginUsedUsdt: null,
      unrealizedPnlUsdt: 0, greeks: {} }} />);
    const label = screen.getByText('Fondos de opciones');
    expect(label.parentElement?.textContent).toContain('—');
    expect(label.parentElement?.textContent).not.toContain('0,00 USDT');
  });
});
