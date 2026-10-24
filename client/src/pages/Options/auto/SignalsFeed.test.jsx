import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SignalsFeed from './SignalsFeed';
import { normalizeSignals } from './botView';

const signals = normalizeSignals([
  { id: 1, alertName: 'opciones 15m', direction: 'bullish', asset: 'ETHUSDT', score: 100, decision: 'opened', createdAt: Date.now() },
]);

describe('SignalsFeed', () => {
  it('escritorio: cronología con el subyacente que disparó la alerta y su resultado', () => {
    render(<SignalsFeed signals={signals} filter="all" />);
    expect(screen.getByRole('list', { name: 'Señales' })).toBeTruthy();
    expect(screen.getByText('ETH')).toBeTruthy();
    expect(screen.getByText('Abierta')).toBeTruthy();
  });

  it('móvil: el subyacente aparece en la tarjeta', () => {
    render(<SignalsFeed signals={signals} filter="all" mobile />);
    expect(screen.getByText('ETH')).toBeTruthy();
  });
});
