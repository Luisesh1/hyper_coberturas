import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SignalsFeed from './SignalsFeed';
import { normalizeSignals } from './botView';

const signals = normalizeSignals([
  { id: 1, alertName: 'opciones 15m', direction: 'bullish', asset: 'ETHUSDT', score: 100, decision: 'opened', createdAt: Date.now() },
]);

describe('SignalsFeed', () => {
  it('escritorio: columna «Subyacente» con el que disparó la alerta', () => {
    render(<SignalsFeed signals={signals} filter="all" />);
    expect(screen.getByRole('columnheader', { name: 'Subyacente' })).toBeTruthy();
    expect(screen.getByText('ETH')).toBeTruthy();
  });

  it('móvil: el subyacente aparece en la tarjeta', () => {
    render(<SignalsFeed signals={signals} filter="all" mobile />);
    expect(screen.getByText('ETH')).toBeTruthy();
  });
});
