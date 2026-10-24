import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import OrchestratorCard from './OrchestratorCard';

const BASE = {
  id: 57,
  name: 'ETH/USDC',
  token0Symbol: 'WETH',
  token1Symbol: 'USDC',
  network: 'arbitrum',
  version: 'v3',
  phase: 'lp_active',
  status: 'active',
  activePositionIdentifier: '224599',
  walletAddress: '0x00000000000000000000000000000000000000ff',
  initialTotalUsd: 1000,
  accounting: {},
  activeHedge: { hedgeValueUsd: 500 },
  lastEvaluation: null,
};

const TEXT = 'Ajuste en curso: la cobertura espera al LP nuevo';

describe('OrchestratorCard · ajuste en curso', () => {
  it('con el tramo en closing sustituye el texto de cobertura', () => {
    render(<OrchestratorCard orchestrator={{ ...BASE, activeSegment: { id: 1, seq: 3, status: 'closing' } }} />);
    expect(screen.getByText(TEXT)).toBeTruthy();
    expect(screen.queryByText(/\$500/)).toBeNull();
  });

  it('con el tramo abierto muestra la cobertura normal', () => {
    render(<OrchestratorCard orchestrator={{ ...BASE, activeSegment: { id: 1, seq: 3, status: 'open' } }} />);
    expect(screen.queryByText(TEXT)).toBeNull();
    expect(screen.getByText(/\$500/)).toBeTruthy();
  });
});
