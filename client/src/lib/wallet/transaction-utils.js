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

export function buildTransactionParams({ address, tx, includeGas = true }) {
  const txParams = {
    from: address,
    to: tx.to,
    data: tx.data,
    value: tx.value || '0x0',
  };

  if (includeGas) {
    if (tx.gas) txParams.gas = tx.gas;
    else if (tx.gasEstimate) txParams.gas = tx.gasEstimate;
    else if (tx.gasLimit) txParams.gas = tx.gasLimit;
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

export function formatFriendlyWalletError(code, defaultMessage) {
  switch (code) {
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

  return {
    code,
    message: formatFriendlyWalletError(code, rawMessage),
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

  const hasExplicitGas = !!(tx?.gas || tx?.gasEstimate || tx?.gasLimit);

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
    const shouldPreferEstimatedGas = tx?.kind === 'mint_position' || tx?.kind === 'wrap_native';
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
    let err = originalErr;

    if (hasExplicitGas) {
      try {
        const retryHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [buildTransactionParams({ address, tx, includeGas: false })],
        });
        const extractedRetryHash = extractTxHash(retryHash);
        if (extractedRetryHash) return { hash: extractedRetryHash, normalizedError: null };
        if (typeof retryHash === 'string') return { hash: retryHash, normalizedError: null };
        if (typeof retryHash?.hash === 'string') return { hash: retryHash.hash, normalizedError: null };
        if (typeof retryHash?.transactionHash === 'string') return { hash: retryHash.transactionHash, normalizedError: null };
      } catch (retryErr) {
        err = retryErr;
      }
    }

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
      normalizedError: normalizeWalletError(err),
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
