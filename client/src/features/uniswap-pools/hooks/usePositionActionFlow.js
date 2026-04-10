import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uniswapApi } from '../../../services/api';
import { useWalletExecution, WALLET_EXECUTION_STATE } from '../../../hooks/useWalletExecution';

export const POSITION_ACTION_STEP = {
  FORM: 'form',
  PREPARING: 'preparing',
  REVIEW: 'review',
  SIGNING: 'signing',
  FINALIZING: 'finalizing',
  DONE: 'done',
  ERROR: 'error',
};

export function usePositionActionFlow({
  action,
  initialFormState,
  buildPayload,
  onFinalized,
  autoPrepare = false,
  prefilledPrepareResult = null,
}) {
  const initialStep = prefilledPrepareResult
    ? POSITION_ACTION_STEP.REVIEW
    : (autoPrepare ? POSITION_ACTION_STEP.PREPARING : POSITION_ACTION_STEP.FORM);
  const [formState, setFormState] = useState(initialFormState);
  const [step, setStep] = useState(initialStep);
  const [prepareData, setPrepareData] = useState(prefilledPrepareResult);
  const [finalResult, setFinalResult] = useState(null);
  const execution = useWalletExecution();
  const [error, setError] = useState(null);

  // Mantenemos `execution.reset` y `execution.runPlan` en refs estables
  // para poder invocarlos desde effects/callbacks SIN agregar `execution`
  // a sus deps. Si lo pusiéramos en deps los callbacks/effects se
  // dispararían en cada render del hook (porque `execution` es una nueva
  // referencia cada vez que su estado interno cambia: PREPARING →
  // AWAITING_WALLET → BROADCAST_SUBMITTED…), y resetearían el modal a
  // STEP.FORM justo después de que el usuario clickeó "Preparar acción".
  const executionResetRef = useRef(execution.reset);
  const executionRunPlanRef = useRef(execution.runPlan);
  useEffect(() => { executionResetRef.current = execution.reset; }, [execution.reset]);
  useEffect(() => { executionRunPlanRef.current = execution.runPlan; }, [execution.runPlan]);

  useEffect(() => {
    setFormState(initialFormState);
    setStep(prefilledPrepareResult
      ? POSITION_ACTION_STEP.REVIEW
      : (autoPrepare ? POSITION_ACTION_STEP.PREPARING : POSITION_ACTION_STEP.FORM));
    setPrepareData(prefilledPrepareResult);
    setFinalResult(null);
    executionResetRef.current?.();
    setError(null);
    // Solo se re-inicializa cuando cambian las inputs externas del modal
    // (acción / pool / autoPrepare / prefill). NO incluir `execution` aquí.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrepare, initialFormState, prefilledPrepareResult]);

  useEffect(() => {
    if (!execution.normalizedError?.message) return;
    setError(execution.normalizedError.message);
  }, [execution.normalizedError]);

  useEffect(() => {
    switch (execution.state) {
      case WALLET_EXECUTION_STATE.IDLE:
        break;
      case WALLET_EXECUTION_STATE.PREFLIGHT:
      case WALLET_EXECUTION_STATE.AWAITING_WALLET:
        setStep(POSITION_ACTION_STEP.SIGNING);
        break;
      case WALLET_EXECUTION_STATE.BROADCAST_SUBMITTED:
      case WALLET_EXECUTION_STATE.NETWORK_CONFIRMING:
      case WALLET_EXECUTION_STATE.FINALIZE_PENDING:
        setStep(POSITION_ACTION_STEP.FINALIZING);
        break;
      case WALLET_EXECUTION_STATE.DONE:
        setStep(POSITION_ACTION_STEP.DONE);
        break;
      case WALLET_EXECUTION_STATE.NEEDS_RECONCILE:
      case WALLET_EXECUTION_STATE.FAILED:
        setStep(POSITION_ACTION_STEP.ERROR);
        break;
      default:
        break;
    }
  }, [execution.state]);

  const handlePrepare = useCallback(async () => {
    setStep(POSITION_ACTION_STEP.PREPARING);
    setError(null);
    try {
      const payload = buildPayload(action, formState);
      const data = await uniswapApi.preparePositionAction(action, payload);
      setPrepareData(data);
      // Reset del execution via ref para no agregar `execution` a las
      // deps del callback (cf. el effect de re-inicialización arriba).
      executionResetRef.current?.();
      setStep(POSITION_ACTION_STEP.REVIEW);
      return data;
    } catch (err) {
      setError(err.message);
      setStep(POSITION_ACTION_STEP.ERROR);
      throw err;
    }
  }, [action, buildPayload, formState]);

  useEffect(() => {
    if (!autoPrepare) return undefined;
    handlePrepare().catch(() => {});
    return undefined;
  }, [autoPrepare, handlePrepare]);

  const handleExecute = useCallback(async () => {
    if (!prepareData?.txPlan?.length) {
      setError('No hay transacciones preparadas para ejecutar.');
      setStep(POSITION_ACTION_STEP.ERROR);
      return null;
    }

    setError(null);
    const finalizePayload = {
      network: prepareData.network,
      version: prepareData.version,
      walletAddress: prepareData.walletAddress,
      positionIdentifier: prepareData.positionIdentifier,
    };

    const result = await executionRunPlanRef.current?.({
      action,
      chainId: prepareData.txPlan[0]?.chainId || null,
      txPlan: prepareData.txPlan,
      finalizePayload,
      finalizeKind: 'position_action',
    });
    if (result) {
      setFinalResult(result);
      if (result.status === 'done') {
        onFinalized?.(result);
      }
      return result;
    }
    return null;
  }, [action, onFinalized, prepareData]);

  return {
    error,
    finalResult,
    formState,
    prepareData,
    quoteSummary: useMemo(() => prepareData?.quoteSummary || null, [prepareData]),
    setError,
    setFormState,
    setStep,
    step,
    txHashes: execution.txHashes,
    handleExecute,
    handlePrepare,
  };
}
