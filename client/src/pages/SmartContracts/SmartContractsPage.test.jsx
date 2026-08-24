import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { smartContractRegistryApi } = vi.hoisted(() => ({
  smartContractRegistryApi: {
    list: vi.fn(), createContract: vi.fn(), createVersion: vi.fn(),
    recordDeployment: vi.fn(), verifyVersion: vi.fn(),
  },
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

  it('registra una nueva versión en verificación antes de que pueda desplegarse', async () => {
    smartContractRegistryApi.list.mockResolvedValue([]);
    smartContractRegistryApi.createContract.mockResolvedValue({ id: 7 });
    smartContractRegistryApi.createVersion.mockResolvedValue({ id: 11, status: 'verification' });

    render(<SmartContractsPage />);

    fireEvent.change(await screen.findByLabelText('Nombre del contrato'), { target: { value: 'Volatility Shield' } });
    fireEvent.change(screen.getByLabelText('Versión'), { target: { value: '1.0.0' } });
    fireEvent.change(screen.getByLabelText('Código fuente'), { target: { value: 'contract VolatilityShield {}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar versión' }));

    await vi.waitFor(() => {
      expect(smartContractRegistryApi.createContract).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Volatility Shield',
        contractType: 'uniswap_v4_dynamic_fee_hook',
      }));
      expect(smartContractRegistryApi.createVersion).toHaveBeenCalledWith(7, expect.objectContaining({
        version: '1.0.0',
        sourceCode: 'contract VolatilityShield {}',
      }));
    });
    expect(await screen.findByText('Versión registrada en verificación.')).toBeTruthy();
  });

  it('permite registrar un despliegue y ofrece verificarlo solo después', async () => {
    smartContractRegistryApi.list.mockResolvedValue([
      { id: 9, name: 'Volatility Shield', version: '1.0.0', status: 'verification', deployment: null },
    ]);
    smartContractRegistryApi.recordDeployment.mockResolvedValue({ id: 12 });

    render(<SmartContractsPage />);

    await screen.findByText('Volatility Shield');
    fireEvent.change(screen.getByLabelText('Versión a desplegar'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Red de despliegue'), { target: { value: 'base-sepolia' } });
    fireEvent.change(screen.getByLabelText('Dirección desplegada'), { target: { value: '0x0000000000000000000000000000000000000080' } });
    fireEvent.change(screen.getByLabelText('Hash de transacción'), { target: { value: '0xabc123' } });
    fireEvent.change(screen.getByLabelText('Hash de bytecode runtime'), { target: { value: '0xdef456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar despliegue firmado' }));

    await vi.waitFor(() => {
      expect(smartContractRegistryApi.recordDeployment).toHaveBeenCalledWith(9, expect.objectContaining({
        network: 'base-sepolia',
        address: '0x0000000000000000000000000000000000000080',
      }));
    });
    expect(await screen.findByText('Despliegue registrado. Ya puedes contrastar el bytecode en cadena.')).toBeTruthy();
  });
});
