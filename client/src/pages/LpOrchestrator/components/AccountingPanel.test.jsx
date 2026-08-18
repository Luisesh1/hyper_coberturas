import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AccountingPanel from './AccountingPanel';

const accountingBase = {
  lpFeesUsd: 40,
  gasSpentUsd: 5,
  swapSlippageUsd: 1,
  priceDriftUsd: -2,
  lpCount: 1,
  totalNetPnlUsd: 32,
};

// Pata real: -12.50 + 30.00 - 2.75 - 7.25 - 3.10 = +4.40
const conHedge = {
  ...accountingBase,
  hedgeRealizedPnlUsd: -12.5,
  hedgeUnrealizedPnlUsd: 30,
  hedgeFundingUsd: -2.75,
  hedgeExecutionFeesUsd: 7.25,
  hedgeSlippageUsd: 3.1,
};

// Sombra: -8.20 + 28.10 - 2.75 - 3.10 - 1.05 = +13.00
const conSombra = {
  ...conHedge,
  shadowRealizedPnlUsd: -8.2,
  shadowUnrealizedPnlUsd: 28.1,
  shadowFundingUsd: -2.75,
  shadowExecutionFeesUsd: 3.1,
  shadowSlippageUsd: 1.05,
  shadowNetPnlUsd: 13,
};

describe('AccountingPanel · cobertura sombra', () => {
  it('oculta la sección cuando la política sombra no corrió', () => {
    render(<AccountingPanel accounting={conHedge} />);
    expect(screen.queryByText('Sombra (net profit)')).toBeNull();
    // La pata real sí se muestra, con su neto.
    expect(screen.getByText('Protección (delta-neutral)')).toBeTruthy();
    expect(screen.getByText('+$4.4')).toBeTruthy();
  });

  it('muestra el desglose de la sombra y la ventaja sobre la cobertura real', () => {
    render(<AccountingPanel accounting={conSombra} />);

    expect(screen.getByText('Sombra (net profit)')).toBeTruthy();
    expect(screen.getByText('Neto sombra')).toBeTruthy();
    expect(screen.getByText('+$13')).toBeTruthy();
    // Ventaja = 13.00 - 4.40 = +8.60
    expect(screen.getByText('Ventaja del contrafactual')).toBeTruthy();
    expect(screen.getByText('+$8.6')).toBeTruthy();
  });

  it('no mezcla el contrafactual con el P&L neto total', () => {
    render(<AccountingPanel accounting={conSombra} />);
    // El neto total sigue siendo el del accounting, sin sumarle la sombra.
    expect(screen.getByText('+$32')).toBeTruthy();
  });
});
