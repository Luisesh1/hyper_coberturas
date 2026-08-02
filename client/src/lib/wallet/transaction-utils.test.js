import { describe, it, expect, vi } from 'vitest';
import {
  findInvalidTxPlanReason,
  buildTransactionParams,
  prefersEstimatedGas,
  withFailingTxContext,
  sendWalletTransactionDetailed,
} from './transaction-utils';

// El mint v4 llegaba a MetaMask sin gas: la comparacion era exacta contra
// 'mint_position' y las kinds de v4 se llaman 'create_position_v4',
// 'increase_liquidity_v4', etc. Todo el flujo v4 quedo sin gas pre-estimado y
// la wallet devolvia "Missing or invalid parameters [codigo -32000]".
describe('prefersEstimatedGas', () => {
  it('cubre las kinds de v4, no solo las de v3', () => {
    for (const kind of [
      'create_position_v4',
      'mint_position_v4',
      'increase_liquidity_v4',
      'decrease_liquidity_v4',
      'reinvest_fees_v4',
      'close_keep_assets_v4',
      'close_to_usdc_v4_withdraw',
    ]) {
      expect(prefersEstimatedGas(kind), `${kind} deberia llevar gas pre-estimado`).toBe(true);
    }
  });

  it('sigue cubriendo v3 y los wraps', () => {
    expect(prefersEstimatedGas('mint_position')).toBe(true);
    expect(prefersEstimatedGas('wrap_native')).toBe(true);
    expect(prefersEstimatedGas('unwrap_native')).toBe(true);
  });

  it('no estima approvals ni kinds vacías', () => {
    expect(prefersEstimatedGas('approval')).toBe(false);
    expect(prefersEstimatedGas('permit2_approval')).toBe(false);
    expect(prefersEstimatedGas(undefined)).toBe(false);
    expect(prefersEstimatedGas('')).toBe(false);
  });
});

describe('withFailingTxContext', () => {
  it('agrega la etiqueta de la tx que fallo', () => {
    const result = withFailingTxContext(
      { code: 'unknown', message: 'No se pudo enviar la transacción. [codigo -32000]' },
      { label: 'Create position (v4)', kind: 'create_position_v4' }
    );
    expect(result.message).toContain('Create position (v4)');
    expect(result.failingTxKind).toBe('create_position_v4');
  });

  it('no rompe si no hay error o no hay etiqueta', () => {
    expect(withFailingTxContext(null, { label: 'x' })).toBeNull();
    const sinLabel = { code: 'unknown', message: 'boom' };
    expect(withFailingTxContext(sinLabel, {})).toEqual(sinLabel);
  });
});

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

  // Arbitrum Nitro rechaza la tx entera si el value trae ceros a la izquierda
  // ("hex number with leading zero digits"), y la wallet lo reporta como
  // "Missing or invalid parameters [codigo -32000]". El servidor ya lo emite
  // canonico, pero normalizamos igual para que no vuelva a llegar a firmar.
  it('normaliza value y gas a QUANTITY sin ceros a la izquierda', () => {
    const tx = validTx({ value: '0x0de0b6b3a7640000', gas: '0x05208' });
    const params = buildTransactionParams({ address: '0xme', tx });
    expect(params.value).toBe('0xde0b6b3a7640000');
    expect(params.gas).toBe('0x5208');
  });

  it('acepta un value decimal del servidor', () => {
    const params = buildTransactionParams({ address: '0xme', tx: validTx({ value: '1000000000000000000' }) });
    expect(params.value).toBe('0xde0b6b3a7640000');
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
