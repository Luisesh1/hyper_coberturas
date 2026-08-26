import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { smartContractRegistryApi, wallet } = vi.hoisted(() => ({
  smartContractRegistryApi: {
    listCatalog: vi.fn(),
    planDeployment: vi.fn(),
    adoptDeployment: vi.fn(),
  },
  wallet: {
    isConnected: true,
    chainId: 84532,
    switchChain: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
}));

vi.mock('../../../services/api', () => ({ smartContractRegistryApi }));
vi.mock('../../../hooks/useWalletConnection', () => ({ useWalletConnection: () => wallet }));

import ProjectContractsPanel from './ProjectContractsPanel';

const ENTRY = {
  contractName: 'VolatilityShieldV1',
  version: '1.0.0',
  network: 'base-sepolia',
  permissions: ['beforeSwap'],
  isMainnet: false,
  predictedAddress: '0x0bbA77640ac3570bf1c3D221c81b0f067C39c080',
};

beforeEach(() => {
  vi.clearAllMocks();
  wallet.isConnected = true;
  wallet.chainId = 84532;
  smartContractRegistryApi.listCatalog.mockResolvedValue([{ ...ENTRY, status: 'deployable' }]);
  smartContractRegistryApi.adoptDeployment.mockResolvedValue({
    versionId: 1, address: ENTRY.predictedAddress, status: 'registered',
  });
});

describe('ProjectContractsPanel', () => {
  it('explica el estado desplegable, avisa del gas y muestra la direccion antes de firmar', async () => {
    render(<ProjectContractsPanel />);
    expect(await screen.findByText(/Aún no está en esta red/i)).toBeTruthy();
    expect(screen.getByText(/cuesta gas/i)).toBeTruthy();
    expect(screen.getByText(ENTRY.predictedAddress)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Desplegar y firmar/i })).toBeTruthy();
  });

  it('cuando ya esta en cadena ofrece registrarlo sin gas y no ofrece firmar', async () => {
    smartContractRegistryApi.listCatalog.mockResolvedValue([{ ...ENTRY, status: 'deployed' }]);
    render(<ProjectContractsPanel />);
    expect(await screen.findByText(/Ya está en esta red/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /sin gastar gas/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desplegar y firmar/i })).toBeNull();
  });

  it('adopta sin gas, avisa al padre y no toca la wallet', async () => {
    smartContractRegistryApi.listCatalog.mockResolvedValue([{ ...ENTRY, status: 'deployed' }]);
    const onAdopted = vi.fn();
    render(<ProjectContractsPanel onAdopted={onAdopted} />);
    fireEvent.click(await screen.findByRole('button', { name: /sin gastar gas/i }));
    await waitFor(() => expect(smartContractRegistryApi.adoptDeployment)
      .toHaveBeenCalledWith('VolatilityShieldV1', 'base-sepolia', undefined));
    await waitFor(() => expect(onAdopted).toHaveBeenCalled());
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('bloquea la direccion ocupada y no ofrece ninguna accion', async () => {
    smartContractRegistryApi.listCatalog.mockResolvedValue([{ ...ENTRY, status: 'address_taken' }]);
    render(<ProjectContractsPanel />);
    expect(await screen.findByText(/ocupada por otro código/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desplegar y firmar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sin gastar gas/i })).toBeNull();
  });

  it('exige confirmacion aparte en redes de dinero real', async () => {
    smartContractRegistryApi.listCatalog.mockResolvedValue([
      { ...ENTRY, network: 'base', isMainnet: true, status: 'deployable' },
    ]);
    render(<ProjectContractsPanel />);
    const boton = await screen.findByRole('button', { name: /Desplegar y firmar/i });
    expect(boton.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Entiendo que es dinero real/i));
    expect(boton.disabled).toBe(false);
  });

  it('no deja firmar sin wallet conectada', async () => {
    wallet.isConnected = false;
    render(<ProjectContractsPanel />);
    const boton = await screen.findByRole('button', { name: /Desplegar y firmar/i });
    expect(boton.disabled).toBe(true);
    expect(screen.getByText(/Conecta tu wallet/i)).toBeTruthy();
  });

  it('firma, espera el recibo y adopta con el txHash', async () => {
    smartContractRegistryApi.planDeployment.mockResolvedValue({
      predictedAddress: ENTRY.predictedAddress,
      chainId: 84532,
      tx: { to: '0x4e59b44847b379578588920cA78FbF26c0B4956C', data: '0xabc', value: '0x0', chainId: 84532 },
    });
    wallet.sendTransaction.mockResolvedValue('0xhash');
    wallet.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    render(<ProjectContractsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Desplegar y firmar/i }));

    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalled());
    await waitFor(() => expect(smartContractRegistryApi.adoptDeployment)
      .toHaveBeenCalledWith('VolatilityShieldV1', 'base-sepolia', '0xhash'));
    expect(wallet.switchChain).not.toHaveBeenCalled();
  });
});
