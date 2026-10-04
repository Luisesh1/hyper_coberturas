import { describe, it, expect, vi } from 'vitest';
import {
  findInvalidTxPlanReason,
  buildTransactionParams,
  findReceiptDespiteError,
  prefersEstimatedGas,
  withFailingTxContext,
  sendWalletTransactionDetailed,
  describeKnownRevert,
  normalizeWalletError,
} from './transaction-utils';

// El mint v4 llegaba a MetaMask sin gas: la comparacion era exacta contra
// 'mint_position' y las kinds de v4 se llaman 'create_position_v4',
// 'increase_liquidity_v4', etc. Todo el flujo v4 quedo sin gas pre-estimado y
// la wallet devolvia "Missing or invalid parameters [codigo -32000]".
describe('prefersEstimatedGas', () => {
  it('cubre el mint de v4, que es el equivalente de mint_position', () => {
    expect(prefersEstimatedGas('create_position_v4')).toBe(true);
    expect(prefersEstimatedGas('mint_position_v4')).toBe(true);
  });

  it('sigue cubriendo v3 y los wraps', () => {
    expect(prefersEstimatedGas('mint_position')).toBe(true);
    expect(prefersEstimatedGas('wrap_native')).toBe(true);
  });

  // Ampliar la lista a estas kinds cambio el comportamiento de flujos v3 que
  // ya andaban: se descartaba el gas del preflight y se re-estimaba contra la
  // wallet. Quedan fuera a proposito.
  it('NO toca las kinds que v3 ya venia usando sin pre-estimacion', () => {
    for (const kind of ['increase_liquidity', 'decrease_liquidity', 'collect_fees', 'reinvest_fees', 'unwrap_native']) {
      expect(prefersEstimatedGas(kind), `${kind} no deberia pre-estimarse`).toBe(false);
    }
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

describe('sendWalletTransactionDetailed no reenvía una operación ambigua', () => {
  const baseArgs = {
    address: '0x1111111111111111111111111111111111111111',
    chainId: 42161,
    switchChain: vi.fn(),
  };

  it('hace un solo eth_sendTransaction cuando el usuario rechaza una tx con gas', async () => {
    const rejection = Object.assign(new Error('User rejected the request'), { code: 4001 });
    const provider = { request: vi.fn().mockRejectedValue(rejection) };

    const { hash, normalizedError } = await sendWalletTransactionDetailed({
      ...baseArgs,
      provider,
      tx: validTx({ gas: '0x5208', kind: 'approval' }),
    });

    expect(hash).toBeNull();
    expect(normalizedError.code).toBe('user_rejected');
    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(provider.request.mock.calls[0][0].method).toBe('eth_sendTransaction');
  });

  it('recupera el hash del error original sin intentar otra firma', async () => {
    const txHash = `0x${'ab'.repeat(32)}`;
    const broadcastError = Object.assign(new Error('provider disconnected after broadcast'), {
      code: -32000,
      data: { transactionHash: txHash },
    });
    const provider = { request: vi.fn().mockRejectedValue(broadcastError) };
    const publicClient = { getTransaction: vi.fn().mockResolvedValue({ hash: txHash }) };

    const result = await sendWalletTransactionDetailed({
      ...baseArgs,
      provider,
      publicClient,
      tx: validTx({ gasEstimate: '0x5208', kind: 'approval' }),
    });

    expect(result).toMatchObject({ hash: txHash, normalizedError: null, recoveredFromError: true });
    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(publicClient.getTransaction).toHaveBeenCalledWith({ hash: txHash });
  });
});

// Robinhood (2026-10-03): la hardware wallet firmó y difundió el swap por
// WalletConnect, pero la respuesta con el hash nunca volvió y el flujo quedó
// colgado para siempre con la tx ya minada. Mientras se espera a la wallet se
// vigila el nonce de la cuenta en cadena y se rescata la tx por nonce.
describe('sendWalletTransactionDetailed rescata la tx por nonce si la wallet no responde', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const baseArgs = { address, chainId: 4663, switchChain: vi.fn(), broadcastWatch: { pollMs: 5 } };
  const minedHash = `0x${'cd'.repeat(32)}`;

  // Cuenta con nonce 9 hasta el bloque 104 incluido; la tx con nonce 9 se mina en el 105.
  function chainWith({ txInBlock, minedAtBlock = 105, advanceAfterPolls = 2 }) {
    let latestPolls = 0;
    return {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getTransactionCount: vi.fn(async ({ blockNumber, blockTag }) => {
        if (blockNumber != null) return Number(blockNumber) >= minedAtBlock ? 10 : 9;
        if (blockTag === 'pending') return 9;
        latestPolls += 1;
        return latestPolls > advanceAfterPolls ? 10 : 9;
      }),
      getBlock: vi.fn(async ({ blockNumber }) => ({
        number: blockNumber,
        transactions: Number(blockNumber) === minedAtBlock ? [txInBlock] : [],
      })),
    };
  }

  it('devuelve el hash minado aunque eth_sendTransaction nunca resuelva', async () => {
    const provider = { request: vi.fn(() => new Promise(() => {})) };
    const tx = validTx({ kind: 'swap' });
    const publicClient = chainWith({
      txInBlock: { hash: minedHash, from: address.toUpperCase().replace('0X', '0x'), nonce: 9, to: tx.to, input: tx.data },
    });
    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(110n);

    const result = await sendWalletTransactionDetailed({ ...baseArgs, provider, publicClient, tx });

    expect(result).toMatchObject({ hash: minedHash, normalizedError: null, recoveredFromChain: true });
    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it('no toma como propia una tx distinta que consumió el nonce', async () => {
    let resolveWallet;
    const provider = { request: vi.fn(() => new Promise((resolve) => { resolveWallet = resolve; })) };
    const tx = validTx({ kind: 'swap' });
    const publicClient = chainWith({
      txInBlock: { hash: minedHash, from: address, nonce: 9, to: tx.to, input: '0xdeadbeef' },
    });
    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(110n);

    const pending = sendWalletTransactionDetailed({ ...baseArgs, provider, publicClient, tx });
    await vi.waitFor(() => expect(publicClient.getBlock).toHaveBeenCalled());
    const walletHash = `0x${'ef'.repeat(32)}`;
    resolveWallet(walletHash);

    expect(await pending).toMatchObject({ hash: walletHash, normalizedError: null });
  });

  it('usa la respuesta de la wallet cuando llega y deja de vigilar', async () => {
    const walletHash = `0x${'aa'.repeat(32)}`;
    const provider = { request: vi.fn().mockResolvedValue(walletHash) };
    const publicClient = chainWith({ txInBlock: null });

    const result = await sendWalletTransactionDetailed({ ...baseArgs, provider, publicClient, tx: validTx() });
    const pollsAtReturn = publicClient.getTransactionCount.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result).toMatchObject({ hash: walletHash, normalizedError: null });
    expect(publicClient.getTransactionCount.mock.calls.length).toBe(pollsAtReturn);
  });
});

// La misma wallet tampoco devolvía el rechazo: la espera no tenía salida.
describe('sendWalletTransactionDetailed permite cancelar la espera de la wallet', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const baseArgs = { address, chainId: 4663, switchChain: vi.fn(), broadcastWatch: { pollMs: 60_000 } };

  function quietChain({ consumed = false, txInBlock = null } = {}) {
    return {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getTransactionCount: vi.fn(async ({ blockNumber, blockTag }) => {
        if (blockNumber != null) return consumed && Number(blockNumber) >= 100 ? 10 : 9;
        if (blockTag === 'pending') return 9;
        return consumed ? 10 : 9;
      }),
      getBlock: vi.fn(async () => ({ transactions: txInBlock ? [txInBlock] : [] })),
    };
  }

  it('al cancelar sin tx en cadena devuelve un error explicativo', async () => {
    const controller = new AbortController();
    const provider = { request: vi.fn(() => new Promise(() => {})) };
    const pending = sendWalletTransactionDetailed({
      ...baseArgs, provider, publicClient: quietChain(), tx: validTx(), cancelSignal: controller.signal,
    });
    await vi.waitFor(() => expect(provider.request).toHaveBeenCalled());

    controller.abort();
    const result = await pending;

    expect(result.hash).toBeNull();
    expect(result.normalizedError.code).toBe('wallet_wait_cancelled');
    expect(result.normalizedError.message).toMatch(/llegaste a firmar/);
  });

  it('al cancelar, si la tx ya está en cadena la adopta en vez de cortar', async () => {
    const controller = new AbortController();
    const tx = validTx();
    const minedHash = `0x${'be'.repeat(32)}`;
    const provider = { request: vi.fn(() => new Promise(() => {})) };
    const publicClient = quietChain({
      consumed: true, txInBlock: { hash: minedHash, from: address, nonce: 9, to: tx.to, input: tx.data },
    });
    publicClient.getBlockNumber.mockResolvedValueOnce(99n).mockResolvedValue(100n);
    const pending = sendWalletTransactionDetailed({
      ...baseArgs, provider, publicClient, tx, cancelSignal: controller.signal,
    });
    await vi.waitFor(() => expect(provider.request).toHaveBeenCalled());

    controller.abort();

    expect(await pending).toMatchObject({ hash: minedHash, recoveredFromChain: true });
  });
});

// Una tx que SI se ejecuto on-chain reportada como fallida es el peor error
// posible del runner: aborta el plan a la mitad y el usuario cree que no paso
// nada. Ocurria porque observar bloques y consultar el recibo pueden caer en
// nodos distintos.
describe('findReceiptDespiteError', () => {
  it('rescata el recibo cuando aparece en un reintento', async () => {
    const getTransactionReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ transactionHash: '0xabc', status: 'success' });
    const receipt = await findReceiptDespiteError(
      { getTransactionReceipt }, '0xabc', { attempts: 3, pollMs: 1 }
    );
    expect(receipt.status).toBe('success');
    expect(getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it('devuelve null si de verdad no está', async () => {
    const getTransactionReceipt = vi.fn().mockRejectedValue(new Error('not found'));
    const receipt = await findReceiptDespiteError(
      { getTransactionReceipt }, '0xabc', { attempts: 2, pollMs: 1 }
    );
    expect(receipt).toBeNull();
  });

  it('no explota sin cliente o sin hash', async () => {
    expect(await findReceiptDespiteError(null, '0xabc')).toBeNull();
    expect(await findReceiptDespiteError({ getTransactionReceipt: vi.fn() }, null)).toBeNull();
  });
});

// Cerrar un LP del orquestador firmando con otra cuenta hacia que el
// PositionManager de v4 revirtiera con `NotApproved(address)`. Ni MetaMask ni
// viem tienen ese ABI, asi que el usuario solo veia "Execution reverted for an
// unknown reason" y reintentaba sin entender que faltaba cambiar de cuenta.
describe('normalizeWalletError traduce los custom errors de v4', () => {
  const notApproved = `0x0ca968d8${'0'.repeat(24)}${'ab'.repeat(20)}`;

  it('reconoce NotApproved y nombra la wallet que firmo', () => {
    const err = Object.assign(new Error('Execution reverted for an unknown reason.'), {
      shortMessage: 'Execution reverted for an unknown reason.',
      cause: { data: notApproved },
    });

    const normalized = normalizeWalletError(err, { phase: 'preflight' });

    expect(normalized.code).toBe('not_position_owner');
    expect(normalized.message).toContain('no es dueña de esta posición');
    expect(normalized.message).toContain('0xabab');
    expect(normalized.rawMessage).toBe('Execution reverted for an unknown reason.');
  });

  it('reconoce DeadlinePassed aunque la data venga anidada en el provider', () => {
    const err = {
      message: 'execution reverted',
      cause: { info: { error: { data: '0xbfb22adf' } } },
    };

    expect(normalizeWalletError(err, { phase: 'preflight' }).code).toBe('deadline_passed');
  });

  it('deja pasar el mensaje crudo cuando el selector no esta en la tabla', () => {
    const err = Object.assign(new Error('Execution reverted for an unknown reason.'), {
      shortMessage: 'Execution reverted for an unknown reason.',
      cause: { data: '0xdeadbeef' },
    });

    const normalized = normalizeWalletError(err, { phase: 'preflight' });

    expect(normalized.code).toBe('preflight_reverted');
    expect(normalized.message).toBe('Execution reverted for an unknown reason.');
  });

  it('no confunde una address suelta con revert data', () => {
    const err = Object.assign(new Error('boom'), { data: `0x${'cd'.repeat(20)}` });

    expect(describeKnownRevert(err)).toBeNull();
  });
});
