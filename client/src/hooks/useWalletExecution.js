import { useCallback, useMemo, useState } from 'react';
import { uniswapApi } from '../services/api';
import { useWalletConnection } from './useWalletConnection';
import {
  buildPlanKey,
  saveInFlightPlan,
  clearInFlightPlan,
  getInFlightPlan,
  listInFlightPlansForScope,
} from '../lib/wallet/inFlightTxPlan';

const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_OPERATION_POLL_MS = 4_000;

export const WALLET_EXECUTION_STATE = {
  IDLE: 'idle',
  PREFLIGHT: 'preflight',
  AWAITING_WALLET: 'awaiting_wallet',
  BROADCAST_SUBMITTED: 'broadcast_submitted',
  NETWORK_CONFIRMING: 'network_confirming',
  FINALIZE_PENDING: 'finalize_pending',
  DONE: 'done',
  FAILED: 'failed',
  NEEDS_RECONCILE: 'needs_reconcile',
};

function buildExecutionError(code, message, extra = {}) {
  return {
    code,
    message,
    ...extra,
  };
}

function mapReceiptError(err) {
  const normalized = err?.normalizedError;
  if (normalized) return normalized;
  return buildExecutionError('tx_timeout', err?.message || 'La red tardó demasiado en confirmar la transacción.');
}

function isTerminalOperationStatus(status) {
  return status === 'done' || status === 'failed' || status === 'needs_reconcile';
}

async function pollOperation(operationId, { timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, pollMs = DEFAULT_OPERATION_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastOperation = null;

  while (Date.now() < deadline) {
    const operation = await uniswapApi.getOperation(operationId);
    lastOperation = operation;
    if (isTerminalOperationStatus(operation?.status)) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const timeoutError = new Error('El backend sigue conciliando la operación.');
  timeoutError.normalizedError = buildExecutionError(
    'server_finalize_pending',
    'Las transacciones ya se firmaron y el backend sigue conciliando el resultado.'
  );
  timeoutError.lastOperation = lastOperation;
  throw timeoutError;
}

export function useWalletExecution() {
  const wallet = useWalletConnection();
  const [state, setState] = useState(WALLET_EXECUTION_STATE.IDLE);
  const [currentTx, setCurrentTx] = useState(null);
  const [progress, setProgress] = useState({
    total: 0,
    completed: 0,
    operationId: null,
    step: WALLET_EXECUTION_STATE.IDLE,
  });
  const [normalizedError, setNormalizedError] = useState(null);
  const [txHashes, setTxHashes] = useState([]);
  const [finalResult, setFinalResult] = useState(null);

  const reset = useCallback(() => {
    setState(WALLET_EXECUTION_STATE.IDLE);
    setCurrentTx(null);
    setProgress({
      total: 0,
      completed: 0,
      operationId: null,
      step: WALLET_EXECUTION_STATE.IDLE,
    });
    setNormalizedError(null);
    setTxHashes([]);
    setFinalResult(null);
  }, []);

  const runPlan = useCallback(async ({
    action,
    chainId,
    txPlan,
    finalizePayload,
    finalizeKind = 'position_action',
    scope = null,
    resumeFromIndex = null,
    initialHashes = null,
  }) => {
    reset();

    if (!wallet?.isConnected || !wallet?.address) {
      const err = buildExecutionError('wallet_unavailable', 'Conecta una wallet antes de continuar.');
      setNormalizedError(err);
      setState(WALLET_EXECUTION_STATE.FAILED);
      return null;
    }

    if (!Array.isArray(txPlan) || txPlan.length === 0) {
      const err = buildExecutionError('unknown', 'No hay transacciones preparadas para firmar.');
      setNormalizedError(err);
      setState(WALLET_EXECUTION_STATE.FAILED);
      return null;
    }

    // Persistencia del plan en localStorage para resumir si el modal se
    // cierra a la mitad. La key es estable por (scope, action, txPlan).
    const planKey = buildPlanKey({ scope, action, txPlan });
    const startIndex = Number.isInteger(resumeFromIndex) && resumeFromIndex > 0 ? resumeFromIndex : 0;
    const hashes = Array.isArray(initialHashes) ? [...initialHashes] : [];
    const persistProgress = (status, completedIndex, extra = {}) => {
      saveInFlightPlan({
        planKey,
        scope: scope || null,
        action,
        txPlan,
        finalizePayload,
        finalizeKind,
        chainId: Number(chainId || wallet.chainId || 0),
        hashes: [...hashes],
        completedIndex,
        status,
        ...extra,
      });
    };

    setProgress({
      total: txPlan.length,
      completed: startIndex,
      operationId: null,
      step: WALLET_EXECUTION_STATE.PREFLIGHT,
    });
    if (startIndex > 0) {
      setTxHashes([...hashes]);
    }
    persistProgress('in_progress', startIndex - 1);

    for (let index = startIndex; index < txPlan.length; index += 1) {
      const originalTx = txPlan[index];
      let tx = originalTx;
      const txLabel = tx?.label || `Transacción ${index + 1}`;
      const effectiveChainId = Number(tx?.chainId || chainId || wallet.chainId);
      setCurrentTx({
        index,
        label: txLabel,
        clientTxId: tx?.clientTxId || `${action}-${index}`,
        hash: hashes[index] || null,
      });

      try {
        setState(WALLET_EXECUTION_STATE.PREFLIGHT);
        setProgress((prev) => ({ ...prev, step: WALLET_EXECUTION_STATE.PREFLIGHT }));
        const preflight = await wallet.preflightTransaction(tx, { chainId: effectiveChainId });
        if (preflight?.gas && !tx?.gas && !tx?.gasEstimate && !tx?.gasLimit) {
          tx = { ...tx, gasEstimate: preflight.gas };
        }
      } catch (err) {
        const normalized = err?.normalizedError || buildExecutionError('preflight_reverted', err?.message || 'La transacción fallaría on-chain.');
        setNormalizedError(normalized);
        setState(WALLET_EXECUTION_STATE.FAILED);
        persistProgress('failed', index - 1, { failedAtIndex: index, failureReason: normalized.code });
        return null;
      }

      setState(WALLET_EXECUTION_STATE.AWAITING_WALLET);
      setProgress((prev) => ({ ...prev, step: WALLET_EXECUTION_STATE.AWAITING_WALLET }));
      const sendResult = await wallet.submitTransactionDetailed(tx, {
        actionKey: `${action}:${index}`,
      });

      if (!sendResult?.hash) {
        setNormalizedError(sendResult?.normalizedError || buildExecutionError('unknown', `No se pudo enviar "${txLabel}".`));
        setState(WALLET_EXECUTION_STATE.FAILED);
        persistProgress('failed', index - 1, { failedAtIndex: index, failureReason: 'no_hash_returned' });
        return null;
      }

      hashes[index] = sendResult.hash;
      setTxHashes([...hashes]);
      setCurrentTx((prev) => (prev ? { ...prev, hash: sendResult.hash } : prev));
      setState(WALLET_EXECUTION_STATE.BROADCAST_SUBMITTED);
      setProgress((prev) => ({ ...prev, step: WALLET_EXECUTION_STATE.BROADCAST_SUBMITTED }));
      // Persistimos en cuanto la wallet nos devuelve el hash, ANTES de
      // esperar el receipt: si el navegador crashea entre el broadcast y
      // la confirmación, queremos saber que esa tx ya está in-flight.
      persistProgress('broadcast_submitted', index - 1);

      let replacementInfo = null;
      try {
        setState(WALLET_EXECUTION_STATE.NETWORK_CONFIRMING);
        setProgress((prev) => ({ ...prev, step: WALLET_EXECUTION_STATE.NETWORK_CONFIRMING }));
        const receipt = await wallet.waitForTransactionReceipt(sendResult.hash, {
          chainId: effectiveChainId,
          onReplaced: (replacement) => {
            replacementInfo = replacement;
            if (replacement?.transaction?.hash) {
              hashes[index] = replacement.transaction.hash;
              setTxHashes([...hashes]);
              setCurrentTx((prev) => (prev ? { ...prev, hash: replacement.transaction.hash } : prev));
              persistProgress('broadcast_submitted', index - 1);
            }
          },
        });

        if (replacementInfo?.reason === 'cancelled') {
          const cancelled = buildExecutionError('tx_cancelled', 'La transacción fue cancelada desde la wallet.', {
            replacement: replacementInfo,
          });
          setNormalizedError(cancelled);
          setState(WALLET_EXECUTION_STATE.FAILED);
          persistProgress('failed', index - 1, { failedAtIndex: index, failureReason: 'tx_cancelled' });
          return null;
        }

        // El status del receipt viene normalizado por
        // `normalizeReceiptStatus` (1 = success, 0 = revert, null =
        // desconocido). Solo tratamos el revert explícito (== 0) como
        // fallo on-chain. Si el status es null/undefined (RPC raro,
        // receipt sin status field), confiamos en que la tx llegó al
        // bloque y seguimos — sería peor abortar acá una tx que sí pasó.
        if (!receipt) {
          const reverted = buildExecutionError('tx_reverted', `No se obtuvo receipt para "${txLabel}".`);
          setNormalizedError(reverted);
          setState(WALLET_EXECUTION_STATE.FAILED);
          persistProgress('failed', index - 1, { failedAtIndex: index, failureReason: 'no_receipt' });
          return null;
        }
        const normalizedStatus = receipt.status;
        if (normalizedStatus === 0) {
          const reverted = buildExecutionError('tx_reverted', `La transacción "${txLabel}" falló on-chain.`);
          setNormalizedError(reverted);
          setState(WALLET_EXECUTION_STATE.FAILED);
          persistProgress('failed', index - 1, { failedAtIndex: index, failureReason: 'tx_reverted' });
          return null;
        }

        hashes[index] = receipt.transactionHash || hashes[index];
        setTxHashes([...hashes]);
        setProgress((prev) => ({
          ...prev,
          completed: index + 1,
          step: WALLET_EXECUTION_STATE.NETWORK_CONFIRMING,
        }));
        // Persistimos progreso confirmado: si el navegador muere acá,
        // sabemos que la tx N ya está minada y al resumir arrancamos
        // desde N+1, sin pedir firmar de nuevo lo ya firmado.
        persistProgress('in_progress', index);
      } catch (err) {
        const normalized = mapReceiptError(err);
        setNormalizedError(normalized);
        setState(WALLET_EXECUTION_STATE.FAILED);
        persistProgress('failed', index - 1, { failedAtIndex: index, failureReason: normalized.code });
        return null;
      }
    }

    setState(WALLET_EXECUTION_STATE.FINALIZE_PENDING);
    setProgress((prev) => ({ ...prev, step: WALLET_EXECUTION_STATE.FINALIZE_PENDING }));
    persistProgress('finalize_pending', txPlan.length - 1);

    let submitResponse;
    try {
      if (finalizeKind === 'claim_fees') {
        submitResponse = await uniswapApi.finalizeClaimFees({
          ...finalizePayload,
          txHash: hashes[0],
        });
      } else {
        submitResponse = await uniswapApi.finalizePositionAction(action, {
          ...finalizePayload,
          txHashes: hashes,
        });
      }
    } catch (err) {
      const normalized = buildExecutionError(
        'server_finalize_failed',
        err?.message || 'No se pudo registrar la operación en el backend.'
      );
      setNormalizedError(normalized);
      setState(WALLET_EXECUTION_STATE.FAILED);
      // No limpiamos el plan acá: todas las txs ya están on-chain, lo que
      // falló fue la conciliación del backend. El usuario puede reintentar
      // el finalize desde el resume button.
      persistProgress('finalize_failed', txPlan.length - 1, { failureReason: normalized.code });
      return null;
    }

    let terminalOperation = submitResponse;
    if (!isTerminalOperationStatus(submitResponse?.status)) {
      setProgress((prev) => ({
        ...prev,
        operationId: submitResponse?.operationId || null,
        step: submitResponse?.step || WALLET_EXECUTION_STATE.FINALIZE_PENDING,
      }));
      try {
        terminalOperation = await pollOperation(submitResponse.operationId);
      } catch (err) {
        const normalized = err?.normalizedError || buildExecutionError('server_finalize_pending', err?.message || 'El backend sigue conciliando la operación.');
        setNormalizedError(normalized);
        setProgress((prev) => ({
          ...prev,
          operationId: submitResponse?.operationId || null,
          step: submitResponse?.step || WALLET_EXECUTION_STATE.FINALIZE_PENDING,
        }));
        setState(WALLET_EXECUTION_STATE.FAILED);
        return {
          ...submitResponse,
          txHashes: hashes,
        };
      }
    }

    const materializedResult = terminalOperation?.result
      ? {
        ...terminalOperation.result,
        txHashes: terminalOperation.txHashes || hashes,
        operationId: terminalOperation.operationId,
        status: terminalOperation.status,
      }
      : {
        ...terminalOperation,
        txHashes: terminalOperation?.txHashes || hashes,
      };

    setFinalResult(materializedResult);
    setProgress((prev) => ({
      ...prev,
      operationId: terminalOperation?.operationId || submitResponse?.operationId || null,
      step: terminalOperation?.status || submitResponse?.status || WALLET_EXECUTION_STATE.DONE,
      completed: txPlan.length,
    }));

    if (terminalOperation?.status === 'needs_reconcile') {
      setNormalizedError(buildExecutionError(
        'server_finalize_pending',
        'Las transacciones fueron confirmadas, pero el backend requiere reconciliación manual.'
      ));
      setState(WALLET_EXECUTION_STATE.NEEDS_RECONCILE);
      // No limpiamos el plan persistido: la operación todavía no se
      // resolvió del lado del backend, la podemos intentar reconciliar.
      persistProgress('needs_reconcile', txPlan.length - 1);
      return materializedResult;
    }

    if (terminalOperation?.status === 'failed') {
      setNormalizedError(buildExecutionError(
        'server_finalize_failed',
        terminalOperation?.error?.message || 'La operación falló durante la conciliación backend.'
      ));
      setState(WALLET_EXECUTION_STATE.FAILED);
      persistProgress('failed', txPlan.length - 1, { failureReason: 'server_finalize_failed' });
      return materializedResult;
    }

    setState(WALLET_EXECUTION_STATE.DONE);
    // ✓ Done: limpiamos el plan persistido. La próxima vez que el
    // usuario abra el modal no le aparece el banner de "operación
    // pendiente".
    clearInFlightPlan(planKey);
    return materializedResult;
  }, [reset, wallet]);

  // Helpers de inspección del cache de planes en localStorage. No tienen
  // estado propio: leen directamente de localStorage en cada call.
  const getInFlightPlanByKey = useCallback((planKey) => getInFlightPlan(planKey), []);
  const listPendingPlansForScope = useCallback((scope) => listInFlightPlansForScope(scope), []);
  const dropInFlightPlan = useCallback((planKey) => clearInFlightPlan(planKey), []);

  return useMemo(() => ({
    state,
    runPlan,
    reset,
    currentTx,
    progress,
    normalizedError,
    txHashes,
    finalResult,
    getInFlightPlan: getInFlightPlanByKey,
    listPendingPlansForScope,
    dropInFlightPlan,
  }), [
    currentTx,
    finalResult,
    normalizedError,
    progress,
    reset,
    runPlan,
    state,
    txHashes,
    getInFlightPlanByKey,
    listPendingPlansForScope,
    dropInFlightPlan,
  ]);
}
