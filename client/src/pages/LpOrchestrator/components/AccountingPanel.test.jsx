import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import AccountingPanel from './AccountingPanel';

const ACCOUNTING = {
  lpFeesUsd: 9.39,
  gasSpentUsd: 0,
  swapSlippageUsd: 0,
  priceDriftUsd: -3.35,
  hedgeRealizedPnlUsd: -11.63,
  hedgeUnrealizedPnlUsd: 0.59,
  hedgeFundingUsd: -0.24,
  hedgeExecutionFeesUsd: 0.8,
  hedgeSlippageUsd: 1.09,
  totalNetPnlUsd: -7.13,
};

describe('AccountingPanel · P&L neto total', () => {
  it('muestra el neto en dolares y como % del capital inicial', () => {
    // Caso real de #45: -$7.13 sobre $330 de capital = -2.16%.
    render(<AccountingPanel accounting={ACCOUNTING} initialTotalUsd={330} />);
    const fila = screen.getByText('P&L neto total').closest('div');
    expect(fila.textContent).toContain('-$7.13');
    expect(fila.textContent).toContain('-2.16%');
  });

  it('un neto positivo lleva el signo + explicito', () => {
    // Sin el `+`, un porcentaje pelado al lado de un importe con signo se lee
    // como si fueran de signos distintos.
    render(<AccountingPanel accounting={{ ...ACCOUNTING, totalNetPnlUsd: 4.5 }} initialTotalUsd={450} />);
    const fila = screen.getByText('P&L neto total').closest('div');
    expect(fila.textContent).toContain('+1.00%');
  });

  it('sin capital inicial omite el porcentaje en vez de inventar un 0%', () => {
    // Dividir por 0 (o por ausente) daria Infinity o NaN; un "0.00%" ahi seria
    // una afirmacion falsa sobre el rendimiento.
    for (const capital of [null, 0, undefined]) {
      const { unmount } = render(<AccountingPanel accounting={ACCOUNTING} initialTotalUsd={capital} />);
      const fila = screen.getByText('P&L neto total').closest('div');
      expect(fila.textContent).toContain('-$7.13');
      expect(fila.textContent).not.toMatch(/%/);
      unmount();
    }
  });
});
