import { describe, it, expect, vi } from 'vitest';
import {
  findInvalidTxPlanReason,
  buildTransactionParams,
  sendWalletTransactionDetailed,
} from './transaction-utils';

const VALID_TO = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

function validTx(overrides = {}) {
  return { to: VALID_TO, data: '0xabcdef', value: '0x0', ...overrides };
}

// El plan que devuelve el servidor para un cierre de LP. Si llega incompleto
// (posición ya cerrada, prepare a medias), la wallet responde "Missing or
// invalid parameters" sin decir por qué — por eso lo cortamos antes.
describe('findInvalidTxPlanReason', () => {
  it('acepta un plan bien formado', () => {
    expect(findInvalidTxPlanReason(validTx())).toBeNull();
  });

  it('rechaza plan vacío o no-objeto', () => {
    expect(findInvalidTxPlanReason(null)).toMatch(/vacío/);
    expect(findInvalidTxPlanReason(undefined)).toMatch(/vacío/);
  });

  it('rechaza destino ausente o malformado', () => {
    expect(findInvalidTxPlanReason(validTx({ to: undefined }))).toMatch(/destino inválido/);
    expect(findInvalidTxPlanReason(validTx({ to: '0x123' }))).toMatch(/destino inválido/);
    expect(findInvalidTxPlanReason(validTx({ to: 'no-es-address' }))).toMatch(/destino inválido/);
  });

  it('rechaza calldata ausente cuando la tx no mueve valor', () => {
    expect(findInvalidTxPlanReason(validTx({ data: undefined }))).toMatch(/calldata inválida/);
    expect(findInvalidTxPlanReason(validTx({ data: '0xzz' }))).toMatch(/calldata inválida/);
  });

  it('permite calldata ausente en un envío de ETH puro', () => {
    expect(findInvalidTxPlanReason({ to: VALID_TO, value: '0x2386f26fc10000' })).toBeNull();
  });
});

describe('buildTransactionParams', () => {
  it('arma los params con value por defecto en 0x0', () => {
    const params = buildTransactionParams({ address: '0xme', tx: validTx({ value: undefined }) });
    expect(params).toMatchObject({ from: '0xme', to: VALID_TO, data: '0xabcdef', value: '0x0' });
  });

  it('incluye gas solo cuando se pide', () => {
    const tx = validTx({ gas: '0x5208' });
    expect(buildTransactionParams({ address: '0xme', tx, includeGas: true }).gas).toBe('0x5208');
    expect(buildTransactionParams({ address: '0xme', tx, includeGas: false }).gas).toBeUndefined();
  });
});

describe('sendWalletTransactionDetailed con plan inválido', () => {
  const baseArgs = { address: '0xme', chainId: 42161, switchChain: vi.fn() };

  it('no llama a la wallet y devuelve un error explicativo', async () => {
    const provider = { request: vi.fn() };
    const { hash, normalizedError } = await sendWalletTransactionDetailed({
      ...baseArgs,
      provider,
      tx: validTx({ to: undefined }),
    });

    expect(provider.request).not.toHaveBeenCalled();
    expect(hash).toBeNull();
    expect(normalizedError.code).toBe('invalid_tx_plan');
    // El usuario tiene que entender qué hacer, no leer un error de MetaMask.
    expect(normalizedError.message).toMatch(/incompleto/);
    expect(normalizedError.message).toMatch(/ya se haya ejecutado/);
  });

  it('sí llama a la wallet cuando el plan es válido', async () => {
    const provider = { request: vi.fn().mockResolvedValue('0xhash') };
    const { hash, normalizedError } = await sendWalletTransactionDetailed({
      ...baseArgs,
      provider,
      tx: validTx(),
    });

    expect(provider.request).toHaveBeenCalledOnce();
    expect(provider.request.mock.calls[0][0].method).toBe('eth_sendTransaction');
    expect(hash).toBe('0xhash');
    expect(normalizedError).toBeNull();
  });
});
