import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ShadowPolicyCard from './ShadowPolicyCard';

const strategyStateConSombra = {
  // Pata de cobertura real (motor legacy).
  hedgeRealizedPnlUsd: -12.5,
  hedgeUnrealizedPnlUsd: 30,
  fundingAccumUsd: -2.75,
  executionFeesUsd: 7.25,
  slippageUsd: 3.1,
  // P&L del LP: común a las dos políticas, no debe entrar en la comparativa.
  lpPnlUsd: 500,
  netProtectionPnlUsd: 504.4,
  lastShadowSnapshotAt: Date.now() - 20_000,
  shadowSnapshot: {
    actualQty: 0.8,
    averageEntryPrice: 1950,
    realizedPnlUsd: -8.2,
    unrealizedPnlUsd: 28.1,
    executionFeesUsd: 3.1,
    slippageUsd: 1.05,
    slippageEwmaBps: 4.2,
    fundingUsd: -2.75,
  },
};

describe('ShadowPolicyCard', () => {
  it('no se renderiza si la protección no está midiendo nada en sombra', () => {
    const { container } = render(<ShadowPolicyCard strategyState={{ netProtectionPnlUsd: 12 }} />);
    expect(container.innerHTML).toBe('');
  });

  it('compara solo la pata de cobertura y deja fuera el P&L del LP', () => {
    render(<ShadowPolicyCard strategyState={strategyStateConSombra} />);

    // real:   -12.50 + 30.00 - 2.75 - 7.25 - 3.10 = +4.40
    // sombra:  -8.20 + 28.10 - 2.75 - 3.10 - 1.05 = +13.00
    expect(screen.getByText('+$4.4')).toBeTruthy();
    expect(screen.getByText('+$13')).toBeTruthy();
    // Ventaja del contrafactual: 13.00 - 4.40 = +8.60
    expect(screen.getByText('+$8.6')).toBeTruthy();
    // Los 500 USD del LP no pueden aparecer por ningún lado.
    expect(screen.queryByText(/\$50[04]/)).toBeNull();
  });

  it('trata las comisiones y el slippage como restas en las dos columnas', () => {
    render(<ShadowPolicyCard strategyState={strategyStateConSombra} />);
    expect(screen.getByText('-$7.25')).toBeTruthy();
    expect(screen.getByText('-$1.05')).toBeTruthy();
    // -$3.1 sale dos veces: slippage real y comisiones de la sombra.
    expect(screen.getAllByText('-$3.1')).toHaveLength(2);
  });
});
