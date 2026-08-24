import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { smartContractRegistryApi } = vi.hoisted(() => ({
  smartContractRegistryApi: { list: vi.fn() },
}));

vi.mock('../../services/api', () => ({ smartContractRegistryApi }));

import SmartContractsPage from './SmartContractsPage';

describe('SmartContractsPage', () => {
  it('muestra al operador qué versiones siguen en verificación y cuáles están verificadas', async () => {
    smartContractRegistryApi.list.mockResolvedValue([
      { id: 1, name: 'Volatility Shield', version: '1.0.0', status: 'verification', deployment: null },
      { id: 2, name: 'Volatility Shield', version: '1.1.0', status: 'verified', deployment: { network: 'base-sepolia', address: '0x0000000000000000000000000000000000000080' } },
    ]);

    render(<SmartContractsPage />);

    expect((await screen.findAllByText('Volatility Shield')).length).toBe(2);
    expect(screen.getByText('En verificación')).toBeTruthy();
    expect(screen.getByText('Verificado')).toBeTruthy();
  });
});
