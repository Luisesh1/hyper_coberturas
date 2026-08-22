import { formatTransactionRequest } from 'viem';

const PROMPT_LOCKS = new Set();

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Normaliza el `status` de un transaction receipt a 1 (éxito) o 0 (revert).
 *
 * Distintos clientes RPC devuelven el status en formatos distintos:
 *   - viem 2.x devuelve la string literal 'success' o 'reverted'
 *   - ethers y JSON-RPC plano devuelven 1/0 como number, bigint, o '0x1'/'0x0'
 *   - Algunos providers (legacy) devuelven 'true'/'false'
 *
 * Devolvemos `null` solo cuando NO podemos determinar el estado (status
 * undefined / null / sin sentido). El caller debería tratar `null` como
 * "desconocido" en vez de "fallido".
 */
export function normalizeReceiptStatus(status) {
  if (status == null) return null;
  if (typeof status === 'number') return status === 1 ? 1 : 0;
  if (typeof status === 'bigint') return status === 1n ? 1 : 0;
  if (typeof status === 'boolean') return status ? 1 : 0;
  if (typeof status === 'string') {
    const trimmed = status.trim().toLowerCase();
    if (trimmed === 'success' || trimmed === 'true' || trimmed === '1' || trimmed === '0x1') return 1;
    if (trimmed === 'reverted' || trimmed === 'failed' || trimmed === 'false' || trimmed === '0' || trimmed === '0x0') return 0;
    if (trimmed.startsWith('0x')) {
      const hex = Number.parseInt(trimmed, 16);
      return Number.isFinite(hex) ? (hex === 1 ? 1 : 0) : null;
    }
    const dec = Number.parseInt(trimmed, 10);
    if (Number.isFinite(dec)) return dec === 1 ? 1 : 0;
    return null;
  }
  return null;
}

export function shortenAddress(address) {
  const value = String(address || '');
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function normalizeRpcMessage(err) {
  return String(
    err?.shortMessage
    || err?.details
    || err?.message
    || err?.cause?.message
    || 'Error desconocido'
  );
}

export function extractTxHash(value, seen = new Set()) {
  if (!value || seen.has(value)) return null;
  if (typeof value === 'string') {
    return /^0x[a-fA-F0-9]{64}$/.test(value) ? value : null;
  }
  if (typeof value !== 'object') return null;
  seen.add(value);

  const directCandidates = [
    value.hash,
    value.txHash,
    value.transactionHash,
    value?.data?.hash,
    value?.data?.txHash,
    value?.data?.transactionHash,
    value?.error?.hash,
    value?.error?.txHash,
    value?.error?.transactionHash,
    value?.error?.data?.hash,
    value?.error?.data?.txHash,
    value?.error?.data?.transactionHash,
  ];
  for (const candidate of directCandidates) {
    const hash = extractTxHash(candidate, seen);
    if (hash) return hash;
  }

  for (const nested of Object.values(value)) {
    const hash = extractTxHash(nested, seen);
    if (hash) return hash;
  }

  return null;
}

export function parseHexOrDecimalBigInt(value) {
  if (value == null || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const stringValue = String(value);
  if (stringValue.startsWith('0x')) return BigInt(stringValue);
  return BigInt(stringValue);
}

/**
 * Un plan de transacción sin `to` o sin `data` no es firmable: la wallet lo
 * rechaza con un mensaje genérico ("Missing or invalid parameters") que no
 * dice nada del origen real. Lo detectamos antes de llamar a la wallet para
 * poder explicar qué pasó. `data` puede faltar legítimamente en un envío de
 * ETH puro, así que solo se exige cuando el plan no mueve valor.
 */
export function findInvalidTxPlanReason(tx) {
  if (!tx || typeof tx !== 'object') return 'el plan de transacción está vacío';
  const isHexAddress = typeof tx.to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(tx.to.trim());
  if (!isHexAddress) return `destino inválido (to=${tx.to ?? 'ausente'})`;
  const hasData = typeof tx.data === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(tx.data.trim());
  const movesValue = tx.value && tx.value !== '0x0' && tx.value !== '0x';
  if (!hasData && !movesValue) return `calldata inválida (data=${tx.data ?? 'ausente'})`;
  return null;
}

/**
 * Un QUANTITY de JSON-RPC es hex compacto y sin ceros a la izquierda: `0x1`,
 * nunca `0x01`. Los nodos estrictos (Arbitrum Nitro y cualquier geth) rechazan
 * la tx entera con "hex number with leading zero digits" y la wallet lo
 * reporta como parametros faltantes o invalidos, sin decir cual. Normalizamos
 * aca para que un valor mal codificado del servidor no llegue nunca a firmar.
 */
export function toRpcQuantity(value) {
  try {
    return `0x${parseHexOrDecimalBigInt(value).toString(16)}`;
  } catch {
    return '0x0';
  }
}

/**
 * Kinds cuyo gas estimamos nosotros en vez de dejarselo a la wallet. Son las
 * txs pesadas — crear/modificar posicion y los wrap/unwrap — donde la
 * estimacion interna de la wallet falla seguido y devuelve un error opaco
 * ("Missing or invalid parameters [codigo -32000]") que no dice ni cual de las
 * txs del plan fallo.
 *
 * Se matchea por PREFIJO a proposito: la comparacion era exacta contra
 * 'mint_position', y cuando llego v4 las kinds pasaron a llamarse
 * `create_position_v4`, `increase_liquidity_v4`, etc. Ninguna volvio a
 * matchear, asi que TODO el flujo v4 se quedo sin gas pre-estimado sin que
 * nadie lo notara.
 */
const GAS_ESTIMATE_KINDS = [
  'mint_position',
  'wrap_native',
  // Solo el equivalente v4 de mint_position. Ampliar esta lista a increase /
  // decrease / close / reinvest cambia el comportamiento de flujos v3 que ya
  // andaban: para esas kinds el gas del preflight se descartaba y se volvia a
  // estimar contra la wallet. Si se vuelve a tocar, probarlo en v3 primero.
  'create_position_v4',
];

/**
 * Un plan de creacion de LP son 5 transacciones. Si la wallet rechaza una con
 * su mensaje generico, el usuario ve el mismo texto sin importar cual fallo, y
 * diagnosticar obliga a reconstruir el plan entero desde el servidor. Pegamos
 * la etiqueta de la tx al mensaje para no perder ese dato.
 */
export function withFailingTxContext(normalizedError, tx) {
  const label = tx?.label || tx?.kind;
  if (!normalizedError || !label) return normalizedError;
  return {
    ...normalizedError,
    message: `${normalizedError.message} (transacción: ${label})`,
    failingTxLabel: label,
    failingTxKind: tx?.kind || null,
  };
}

export function prefersEstimatedGas(kind) {
  const normalized = String(kind || '');
  if (!normalized) return false;
  return GAS_ESTIMATE_KINDS.some((base) => normalized === base || normalized.startsWith(`${base}_`));
}

export function buildTransactionParams({ address, tx, includeGas = true }) {
  const txParams = {
    from: address,
    to: tx.to,
    data: tx.data,
    value: toRpcQuantity(tx.value || '0x0'),
  };

  if (includeGas) {
    const gas = tx.gas || tx.gasEstimate || tx.gasLimit;
    if (gas) txParams.gas = toRpcQuantity(gas);
  }

  return txParams;
}

export function addGasBuffer(hexGas, multiplier = 1.2) {
  try {
    const numeric = BigInt(hexGas);
    return `0x${(((numeric * BigInt(Math.round(multiplier * 100))) + 99n) / 100n).toString(16)}`;
  } catch {
    return hexGas;
  }
}

/**
 * Los contratos de Uniswap v4 revierten con custom errors (4 bytes + args),
 * no con strings. Ni MetaMask ni viem tienen el ABI para decodificarlos, asi
 * que el usuario ve siempre el mismo texto inutil: "Execution reverted for an
 * unknown reason". Traducimos los que se pueden disparar desde nuestros
 * planes para que el mensaje diga que hacer.
 *
 * Los selectores son `keccak256(firma)[0..4]` de v4-periphery / v4-core.
 */
const KNOWN_REVERT_SELECTORS = {
  // PositionManager.onlyIfApproved — firmar con una wallet que no es la
  // dueña del NFT de la posicion (ni tiene approval sobre el).
  '0x0ca968d8': { code: 'not_position_owner', arg: 'address' },
  '0xbfb22adf': { code: 'deadline_passed' },
  '0x31e30ad0': { code: 'v4_maximum_amount_exceeded' },
  '0x12816f22': { code: 'v4_minimum_amount_insufficient' },
  '0x5212cba1': { code: 'v4_currency_not_settled' },
  '0x486aa307': { code: 'v4_pool_not_initialized' },
};

/**
 * Busca el blob de revert data en la cadena de causas del error. viem lo
 * cuelga en `cause.data` (a veces ya parseado como objeto con `.data`),
 * ethers en `info.error.data`, y los providers crudos en `error.data`.
 */
function findRevertData(value, seen = new Set()) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^0x[0-9a-fA-F]{8,}$/.test(trimmed) && (trimmed.length - 2) % 2 === 0 ? trimmed : null;
  }
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);

  const candidates = [
    value.data,
    value.error?.data,
    value.info?.error?.data,
    value.cause,
  ];
  for (const candidate of candidates) {
    const found = findRevertData(candidate, seen);
    if (found) return found;
  }
  return null;
}

/**
 * Traduce el custom error del revert a `{ code, message }`, o `null` si no
 * lo conocemos (ahi conviene seguir mostrando el mensaje crudo de la wallet).
 */
export function describeKnownRevert(err) {
  const data = findRevertData(err);
  if (!data) return null;
  const known = KNOWN_REVERT_SELECTORS[data.slice(0, 10).toLowerCase()];
  if (!known) return null;

  let detail = null;
  if (known.arg === 'address' && data.length >= 74) {
    detail = `0x${data.slice(34, 74)}`;
  }
  return { code: known.code, message: formatFriendlyWalletError(known.code, null, detail) };
}

export function formatFriendlyWalletError(code, defaultMessage, detail = null) {
  switch (code) {
    case 'not_position_owner':
      return `La wallet que firma${detail ? ` (${shortenAddress(detail)})` : ''} no es dueña de esta posición ni está aprobada para operarla. `
        + 'Conectá en la wallet la cuenta dueña del LP y volvé a intentar.';
    case 'wallet_mismatch':
      return defaultMessage || 'La wallet conectada no es la que firma este plan de transacciones.';
    case 'deadline_passed':
      return 'El plan de transacciones expiró (deadline vencido). Volvé a preparar la acción.';
    case 'v4_maximum_amount_exceeded':
      return 'El pool pidió más tokens de los que autorizó el plan. Volvé a preparar la acción para recotizar.';
    case 'v4_minimum_amount_insufficient':
      return 'El pool devolvería menos tokens que el mínimo del plan (el precio se movió). Volvé a preparar la acción.';
    case 'v4_currency_not_settled':
      return 'Quedó un saldo sin liquidar en el PoolManager. Volvé a preparar la acción y reportá el caso si se repite.';
    case 'v4_pool_not_initialized':
      return 'El pool v4 no está inicializado en esta red.';
    case 'user_rejected':
      return 'Firma rechazada por el usuario.';
    case 'request_pending':
      return 'Ya hay una solicitud abierta en la wallet.';
    case 'wallet_unavailable':
      return 'No hay una wallet conectada.';
    case 'wallet_disconnected':
      return 'La wallet está desconectada de la red.';
    case 'unauthorized':
      return 'La wallet no autorizó esta solicitud.';
    case 'unsupported_method':
      return 'La wallet no soporta esta operación.';
    case 'chain_not_added':
      return 'La red no está agregada en la wallet.';
    case 'chain_switch_rejected':
      return 'Cambio de red rechazado por el usuario.';
    case 'chain_mismatch':
      return 'La wallet no está conectada a la red requerida.';
    case 'insufficient_funds':
      return 'Fondos insuficientes para ejecutar la transacción.';
    case 'preflight_reverted':
      return defaultMessage || 'La transacción fallaría on-chain con el estado actual.';
    case 'broadcast_unknown':
      return 'La wallet devolvió un estado ambiguo, pero la transacción podría haberse enviado.';
    case 'tx_cancelled':
      return 'La transacción fue cancelada desde la wallet.';
    case 'tx_reverted':
      return 'La transacción falló on-chain.';
    case 'tx_timeout':
      return 'La red está tardando demasiado en confirmar la transacción.';
    case 'invalid_tx_plan':
      return defaultMessage
        || 'El plan de transacción vino incompleto del servidor. Refrescá la posición y volvé a intentar.';
    default:
      return defaultMessage || 'No se pudo enviar la transacción.';
  }
}

export function normalizeWalletError(err, { phase = 'wallet' } = {}) {
  const rawMessage = normalizeRpcMessage(err);
  const message = rawMessage.toLowerCase();
  const numericCode = Number(err?.code);

  let code = 'unknown';

  if (numericCode === 4001) code = 'user_rejected';
  else if (numericCode === 4100) code = 'unauthorized';
  else if (numericCode === 4200) code = 'unsupported_method';
  else if (numericCode === 4900) code = 'wallet_disconnected';
  else if (numericCode === 4901) code = 'chain_mismatch';
  else if (numericCode === 4902) code = 'chain_not_added';
  else if (numericCode === -32002 || message.includes('already pending') || message.includes('request already pending')) code = 'request_pending';
  else if (message.includes('insufficient funds')) code = 'insufficient_funds';
  else if (phase === 'preflight') code = 'preflight_reverted';
  else if (phase === 'receipt' && /timeout|timed out|esperando confirmaci/i.test(message)) code = 'tx_timeout';

  // Un revert con custom error de v4 llega como "Execution reverted for an
  // unknown reason": el codigo por si solo (preflight_reverted / unknown) no
  // alcanza, hay que mirar la revert data para saber que fallo.
  const knownRevert = code === 'preflight_reverted' || code === 'unknown'
    ? describeKnownRevert(err)
    : null;
  if (knownRevert) {
    return {
      code: knownRevert.code,
      message: knownRevert.message,
      rawCode: Number.isFinite(numericCode) ? numericCode : null,
      rawMessage,
      cause: err,
    };
  }

  // Un error sin codigo reconocido no se puede diagnosticar a ciegas: el
  // mensaje de la wallet suele ser generico ("Missing or invalid parameters")
  // y no dice cual de los parametros ni por que. Adjuntamos el codigo crudo
  // para poder identificarlo sin tener que reproducir el escenario.
  const friendlyMessage = code === 'unknown' && Number.isFinite(numericCode)
    ? `${formatFriendlyWalletError(code, rawMessage)} [codigo ${numericCode}]`
    : formatFriendlyWalletError(code, rawMessage);

  return {
    code,
    message: friendlyMessage,
    rawCode: Number.isFinite(numericCode) ? numericCode : null,
    rawMessage,
    cause: err,
  };
}

export async function waitForBroadcastedHash(clientOrProvider, txHash, { attempts = 6, pollMs = 500 } = {}) {
  if (!clientOrProvider || !txHash) return false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (typeof clientOrProvider.getTransaction === 'function') {
        const tx = await clientOrProvider.getTransaction({ hash: txHash });
        if (tx) return true;
      } else if (typeof clientOrProvider.request === 'function') {
        const tx = await clientOrProvider.request({
          method: 'eth_getTransactionByHash',
          params: [txHash],
        });
        if (tx) return true;
      }
    } catch {
      // Best-effort verification only.
    }

    if (attempt < attempts - 1) {
      await sleep(pollMs);
    }
  }

  return false;
}

async function estimateTransactionGas(provider, txParams) {
  if (!provider?.request) return null;
  try {
    const estimatedGas = await provider.request({
      method: 'eth_estimateGas',
      params: [txParams],
    });
    if (typeof estimatedGas === 'string' && estimatedGas.startsWith('0x')) {
      return addGasBuffer(estimatedGas);
    }
  } catch {
    // Best-effort estimation only; fall back to wallet defaults.
  }
  return null;
}

export async function sendWalletTransactionDetailed({
  provider,
  publicClient,
  address,
  chainId,
  tx,
  switchChain,
  actionKey,
}) {
  if (!provider?.request) {
    return {
      hash: null,
      normalizedError: {
        code: 'wallet_unavailable',
        message: formatFriendlyWalletError('wallet_unavailable'),
        rawCode: null,
        rawMessage: 'wallet unavailable',
      },
    };
  }

  if (actionKey && PROMPT_LOCKS.has(actionKey)) {
    return {
      hash: null,
      normalizedError: {
        code: 'request_pending',
        message: formatFriendlyWalletError('request_pending'),
        rawCode: -32002,
        rawMessage: 'request already pending',
      },
    };
  }

  const invalidPlanReason = findInvalidTxPlanReason(tx);
  if (invalidPlanReason) {
    return {
      hash: null,
      normalizedError: {
        code: 'invalid_tx_plan',
        message: formatFriendlyWalletError(
          'invalid_tx_plan',
          `El plan de transacción vino incompleto (${invalidPlanReason}). `
          + 'Refrescá la posición y volvé a intentar — puede que la acción ya se haya ejecutado.'
        ),
        rawCode: null,
        rawMessage: `invalid tx plan: ${invalidPlanReason}`,
      },
    };
  }

  try {
    if (actionKey) PROMPT_LOCKS.add(actionKey);
    if (tx?.chainId && chainId && Number(tx.chainId) !== Number(chainId)) {
      const switched = await switchChain?.(Number(tx.chainId));
      if (!switched) {
        return {
          hash: null,
          normalizedError: {
            code: 'chain_switch_rejected',
            message: formatFriendlyWalletError('chain_switch_rejected'),
            rawCode: 4001,
            rawMessage: 'chain switch rejected',
          },
        };
      }
    }

    const baseTxParams = buildTransactionParams({ address, tx, includeGas: false });
    const shouldPreferEstimatedGas = prefersEstimatedGas(tx?.kind);
    const estimatedGas = shouldPreferEstimatedGas ? await estimateTransactionGas(provider, baseTxParams) : null;

    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        ...buildTransactionParams({
          address,
          tx,
          includeGas: !shouldPreferEstimatedGas,
        }),
        ...(estimatedGas ? { gas: estimatedGas } : {}),
      }],
    });
    const extractedHash = extractTxHash(txHash);
    if (extractedHash) {
      return { hash: extractedHash, normalizedError: null };
    }
    if (typeof txHash === 'string') return { hash: txHash, normalizedError: null };
    if (typeof txHash?.hash === 'string') return { hash: txHash.hash, normalizedError: null };
    if (typeof txHash?.transactionHash === 'string') return { hash: txHash.transactionHash, normalizedError: null };

    return {
      hash: null,
      normalizedError: normalizeWalletError({ message: 'wallet returned without tx hash' }),
    };
  } catch (originalErr) {
    // `eth_sendTransaction` no es idempotente: un error puede llegar después
    // de que la wallet ya haya difundido la transacción. Reenviarla sin gas
    // abriría una segunda firma y podría ejecutar dos veces la misma acción.
    // Conservamos el error original para rescatar cualquier hash embebido y el
    // usuario decide explícitamente si quiere volver a intentar.
    const err = originalErr;
    const hashFromError = extractTxHash(err);
    if (hashFromError) {
      const wasBroadcasted = await waitForBroadcastedHash(publicClient || provider, hashFromError);
      if (wasBroadcasted) {
        return { hash: hashFromError, normalizedError: null, recoveredFromError: true };
      }
      return {
        hash: hashFromError,
        normalizedError: {
          code: 'broadcast_unknown',
          message: formatFriendlyWalletError('broadcast_unknown'),
          rawCode: Number.isFinite(Number(err?.code)) ? Number(err.code) : null,
          rawMessage: normalizeRpcMessage(err),
          cause: err,
        },
        recoveredFromError: true,
      };
    }

    return {
      hash: null,
      normalizedError: withFailingTxContext(normalizeWalletError(err), tx),
    };
  } finally {
    if (actionKey) PROMPT_LOCKS.delete(actionKey);
  }
}

export function buildPreparedTransactionRequest(tx, address) {
  return formatTransactionRequest({
    account: address,
    to: tx.to,
    data: tx.data,
    value: parseHexOrDecimalBigInt(tx.value || '0x0'),
    ...(tx.gas ? { gas: parseHexOrDecimalBigInt(tx.gas) } : {}),
    ...(tx.gasEstimate ? { gas: parseHexOrDecimalBigInt(tx.gasEstimate) } : {}),
  });
}

/**
 * Busca el recibo directo, reintentando, cuando `waitForTransactionReceipt`
 * ya se dio por vencido. Existe porque observar bloques y consultar el recibo
 * pueden resolverse contra nodos distintos: una tx que SI se ejecuto aparece
 * como no encontrada, el plan se aborta a la mitad y el usuario cree que no
 * paso nada. Devuelve null si de verdad no esta.
 */
export async function findReceiptDespiteError(publicClient, txHash, { attempts = 5, pollMs = 1200 } = {}) {
  if (!publicClient?.getTransactionReceipt || !txHash) return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (receipt) return receipt;
    } catch {
      // Todavia no visible en el nodo que respondio; reintentamos.
    }
    if (attempt < attempts - 1) await sleep(pollMs);
  }
  return null;
}
