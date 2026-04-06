import { useCallback, useEffect, useState } from 'react';
import { uniswapApi } from '../../../services/api';
import { formatUsd, formatCompactPrice } from '../utils/pool-formatters';
import styles from './ClaimFeesModal.module.css';

const STEP = {
  PREPARE: 'prepare',
  REVIEW: 'review',
  SIGNING: 'signing',
  CONFIRMING: 'confirming',
  DONE: 'done',
  ERROR: 'error',
};

export default function ClaimFeesModal({
  pool,
  wallet,
  onClose,
  onFinalized,
  sendTransaction,
}) {
  const [step, setStep] = useState(STEP.PREPARE);
  const [claimData, setClaimData] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const network = pool.network;
  const version = pool.version;
  const positionIdentifier = pool.identifier || pool.positionIdentifier;

  // Step 1: prepare
  const handlePrepare = useCallback(async () => {
    setStep(STEP.PREPARE);
    setError(null);
    try {
      const data = await uniswapApi.prepareClaimFees({
        network,
        version,
        positionIdentifier,
        walletAddress: wallet.address,
      });
      setClaimData(data);
      setStep(STEP.REVIEW);
    } catch (err) {
      setError(err.message);
      setStep(STEP.ERROR);
    }
  }, [network, version, positionIdentifier, wallet]);

  // Auto-prepare on mount
  useEffect(() => {
    handlePrepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 2: sign & send
  const handleSign = useCallback(async () => {
    if (!claimData?.tx) return;
    setStep(STEP.SIGNING);
    setError(null);

    const hash = await sendTransaction(claimData.tx);
    if (!hash) {
      setStep(STEP.REVIEW);
      return;
    }

    setTxHash(hash);
    setStep(STEP.CONFIRMING);

    // Step 3: finalize
    try {
      const finalResult = await uniswapApi.finalizeClaimFees({
        network,
        version,
        positionIdentifier,
        walletAddress: wallet.address,
        txHash: hash,
      });
      setResult(finalResult);
      setStep(STEP.DONE);
      if (onFinalized) onFinalized(finalResult);
    } catch (err) {
      setError(err.message);
      setStep(STEP.ERROR);
    }
  }, [claimData, sendTransaction, network, version, positionIdentifier, wallet, onFinalized]);

  const summary = claimData?.claimSummary;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Claim Fees</span>
            <h2 className={styles.title}>
              {summary
                ? `${summary.token0.symbol} / ${summary.token1.symbol}`
                : pool.token0?.symbol && pool.token1?.symbol
                  ? `${pool.token0.symbol} / ${pool.token1.symbol}`
                  : 'Reclamar fees'}
            </h2>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Loading / Prepare */}
        {step === STEP.PREPARE && (
          <div className={styles.section}>
            <p className={styles.statusText}>Preparando transaccion...</p>
          </div>
        )}

        {/* Review */}
        {step === STEP.REVIEW && summary && (
          <>
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Resumen del claim</h3>
              <div className={styles.summaryGrid}>
                <div className={styles.summaryItem}>
                  <span className={styles.label}>Red</span>
                  <strong>{summary.networkLabel}</strong>
                </div>
                <div className={styles.summaryItem}>
                  <span className={styles.label}>Version</span>
                  <strong>{summary.version.toUpperCase()}</strong>
                </div>
                <div className={styles.summaryItem}>
                  <span className={styles.label}>Position ID</span>
                  <strong>#{summary.positionIdentifier}</strong>
                </div>
                <div className={styles.summaryItem}>
                  <span className={styles.label}>Destinatario</span>
                  <strong className={styles.mono}>{summary.recipient.slice(0, 6)}...{summary.recipient.slice(-4)}</strong>
                </div>
              </div>
              {pool.unclaimedFeesUsd != null && (
                <div className={styles.feesEstimate}>
                  <span className={styles.label}>Fees estimadas</span>
                  <strong className={styles.feesValue}>{formatUsd(pool.unclaimedFeesUsd)}</strong>
                </div>
              )}
              {(pool.unclaimedFees0 != null || pool.unclaimedFees1 != null) && (
                <div className={styles.feesBreakdown}>
                  {pool.unclaimedFees0 != null && (
                    <span>{formatCompactPrice(pool.unclaimedFees0)} {summary.token0.symbol}</span>
                  )}
                  {pool.unclaimedFees1 != null && (
                    <span>{formatCompactPrice(pool.unclaimedFees1)} {summary.token1.symbol}</span>
                  )}
                </div>
              )}
            </div>
            <div className={styles.actions}>
              <button className={styles.cancelBtn} onClick={onClose}>Cancelar</button>
              <button className={styles.confirmBtn} onClick={handleSign}>
                Firmar con MetaMask
              </button>
            </div>
          </>
        )}

        {/* Signing */}
        {step === STEP.SIGNING && (
          <div className={styles.section}>
            <p className={styles.statusText}>Firma la transaccion en MetaMask...</p>
          </div>
        )}

        {/* Confirming */}
        {step === STEP.CONFIRMING && (
          <div className={styles.section}>
            <p className={styles.statusText}>Esperando confirmacion on-chain...</p>
            {txHash && (
              <p className={styles.txHash}>
                tx: <span className={styles.mono}>{txHash.slice(0, 10)}...{txHash.slice(-8)}</span>
              </p>
            )}
          </div>
        )}

        {/* Done */}
        {step === STEP.DONE && (
          <>
            <div className={styles.section}>
              <p className={styles.successText}>Fees reclamadas exitosamente</p>
              {txHash && (
                <p className={styles.txHash}>
                  tx: <span className={styles.mono}>{txHash.slice(0, 10)}...{txHash.slice(-8)}</span>
                </p>
              )}
              {result?.receipt && (
                <p className={styles.receiptInfo}>Bloque #{result.receipt.blockNumber} · Gas: {result.receipt.gasUsed}</p>
              )}
            </div>
            <div className={styles.actions}>
              <button className={styles.confirmBtn} onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}

        {/* Error */}
        {step === STEP.ERROR && (
          <>
            <div className={styles.section}>
              <p className={styles.errorText}>{error || 'Error desconocido'}</p>
              {txHash && (
                <p className={styles.txHash}>
                  tx: <span className={styles.mono}>{txHash.slice(0, 10)}...{txHash.slice(-8)}</span>
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <button className={styles.cancelBtn} onClick={onClose}>Cerrar</button>
              <button className={styles.confirmBtn} onClick={handlePrepare}>Reintentar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
