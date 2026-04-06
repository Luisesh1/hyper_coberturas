import { useCallback, useEffect, useMemo, useState } from 'react';
import { uniswapApi } from '../../../services/api';

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
  sendTransaction,
  waitForTransactionReceipt,
  onFinalized,
  autoPrepare = false,
}) {
  const [formState, setFormState] = useState(initialFormState);
  const [step, setStep] = useState(autoPrepare ? POSITION_ACTION_STEP.PREPARING : POSITION_ACTION_STEP.FORM);
  const [prepareData, setPrepareData] = useState(null);
  const [finalResult, setFinalResult] = useState(null);
  const [txHashes, setTxHashes] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    setFormState(initialFormState);
    setStep(autoPrepare ? POSITION_ACTION_STEP.PREPARING : POSITION_ACTION_STEP.FORM);
    setPrepareData(null);
    setFinalResult(null);
    setTxHashes([]);
    setError(null);
  }, [autoPrepare, initialFormState]);

  const handlePrepare = useCallback(async () => {
    setStep(POSITION_ACTION_STEP.PREPARING);
    setError(null);
    try {
      const payload = buildPayload(action, formState);
      const data = await uniswapApi.preparePositionAction(action, payload);
      setPrepareData(data);
      setTxHashes([]);
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

    setStep(POSITION_ACTION_STEP.SIGNING);
    setError(null);
    const hashes = [];

    for (const [index, tx] of prepareData.txPlan.entries()) {
      const txLabel = tx?.label || `Transacción ${index + 1}`;
      const txHash = await sendTransaction(tx);
      if (!txHash) {
        setError(`La firma de "${txLabel}" fue cancelada o la wallet no devolvió un hash.`);
        setStep(POSITION_ACTION_STEP.ERROR);
        return null;
      }

      hashes.push(txHash);
      setTxHashes([...hashes]);

      if (waitForTransactionReceipt) {
        try {
          const receipt = await waitForTransactionReceipt(txHash);
          if (!receipt || Number(receipt.status) !== 1) {
            setError(`La transacción "${txLabel}" falló on-chain. Revisa la wallet antes de continuar.`);
            setStep(POSITION_ACTION_STEP.ERROR);
            return null;
          }
        } catch (err) {
          setError(err.message || `No se pudo confirmar "${txLabel}".`);
          setStep(POSITION_ACTION_STEP.ERROR);
          return null;
        }
      }
    }

    setStep(POSITION_ACTION_STEP.FINALIZING);
    try {
      const result = await uniswapApi.finalizePositionAction(action, {
        network: prepareData.network,
        version: prepareData.version,
        walletAddress: prepareData.walletAddress,
        positionIdentifier: prepareData.positionIdentifier,
        txHashes: hashes,
      });
      setFinalResult(result);
      setStep(POSITION_ACTION_STEP.DONE);
      onFinalized?.(result);
      return result;
    } catch (err) {
      setError(err.message);
      setStep(POSITION_ACTION_STEP.ERROR);
      return null;
    }
  }, [action, onFinalized, prepareData, sendTransaction, waitForTransactionReceipt]);

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
    txHashes,
    handleExecute,
    handlePrepare,
  };
}
