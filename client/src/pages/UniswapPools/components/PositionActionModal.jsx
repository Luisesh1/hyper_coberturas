import { useCallback, useEffect, useMemo, useState } from 'react';
import { uniswapApi } from '../../../services/api';
import { formatUsd, formatCompactPrice } from '../utils/pool-formatters';
import styles from './PositionActionModal.module.css';

const STEP = {
  FORM: 'form',
  PREPARING: 'preparing',
  REVIEW: 'review',
  SIGNING: 'signing',
  FINALIZING: 'finalizing',
  DONE: 'done',
  ERROR: 'error',
};

const ACTION_LABELS = {
  'increase-liquidity': 'Agregar liquidez',
  'decrease-liquidity': 'Reducir liquidez',
  'collect-fees': 'Cobrar fees',
  'reinvest-fees': 'Reinvertir fees',
  'modify-range': 'Modificar rango',
  rebalance: 'Rebalancear activos',
  'create-position': 'Crear posición LP',
};

function getInitialState(action, pool, defaults) {
  if (action === 'create-position') {
    return {
      network: defaults.network || 'ethereum',
      version: defaults.version || 'v3',
      walletAddress: defaults.walletAddress || '',
      token0Address: pool?.token0Address || '',
      token1Address: pool?.token1Address || '',
      fee: pool?.fee ? String(pool.fee) : '3000',
      amount0Desired: '',
      amount1Desired: '',
      rangeLowerPrice: '',
      rangeUpperPrice: '',
      slippageBps: '100',
    };
  }

  return {
    network: pool?.network || defaults.network || 'ethereum',
    version: pool?.version || defaults.version || 'v3',
    walletAddress: defaults.walletAddress || '',
    positionIdentifier: String(pool?.identifier || pool?.positionIdentifier || ''),
    amount0Desired: pool?.positionAmount0 != null ? String(pool.positionAmount0) : '',
    amount1Desired: pool?.positionAmount1 != null ? String(pool.positionAmount1) : '',
    liquidityPercent: '25',
    rangeLowerPrice: pool?.rangeLowerPrice != null ? String(pool.rangeLowerPrice) : '',
    rangeUpperPrice: pool?.rangeUpperPrice != null ? String(pool.rangeUpperPrice) : '',
    targetWeightToken0Pct: '50',
    slippageBps: '100',
  };
}

function buildPayload(action, formState) {
  switch (action) {
    case 'increase-liquidity':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        amount0Desired: formState.amount0Desired,
        amount1Desired: formState.amount1Desired,
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'decrease-liquidity':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        liquidityPercent: Number(formState.liquidityPercent || 100),
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'collect-fees':
    case 'reinvest-fees':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'modify-range':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        rangeLowerPrice: Number(formState.rangeLowerPrice),
        rangeUpperPrice: Number(formState.rangeUpperPrice),
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'rebalance':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        targetWeightToken0Pct: Number(formState.targetWeightToken0Pct),
        rangeLowerPrice: Number(formState.rangeLowerPrice),
        rangeUpperPrice: Number(formState.rangeUpperPrice),
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'create-position':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        token0Address: formState.token0Address,
        token1Address: formState.token1Address,
        fee: Number(formState.fee),
        amount0Desired: formState.amount0Desired,
        amount1Desired: formState.amount1Desired,
        rangeLowerPrice: Number(formState.rangeLowerPrice),
        rangeUpperPrice: Number(formState.rangeUpperPrice),
        slippageBps: Number(formState.slippageBps || 100),
      };
    default:
      return formState;
  }
}

function SummaryRows({ data }) {
  if (!data) return null;

  return (
    <div className={styles.summaryGrid}>
      {Object.entries(data).map(([key, value]) => {
        if (value == null || value === '') return null;
        if (typeof value === 'object' && !Array.isArray(value)) {
          return (
            <div key={key} className={styles.summaryItemWide}>
              <span className={styles.label}>{key}</span>
              <code className={styles.pre}>{JSON.stringify(value, null, 2)}</code>
            </div>
          );
        }
        return (
          <div key={key} className={styles.summaryItem}>
            <span className={styles.label}>{key}</span>
            <strong>{String(value)}</strong>
          </div>
        );
      })}
    </div>
  );
}

export default function PositionActionModal({
  action,
  pool = null,
  wallet,
  sendTransaction,
  defaults = {},
  onClose,
  onFinalized,
}) {
  const [formState, setFormState] = useState(() => getInitialState(action, pool, defaults));
  const [step, setStep] = useState(action === 'collect-fees' ? STEP.PREPARING : STEP.FORM);
  const [prepareData, setPrepareData] = useState(null);
  const [finalResult, setFinalResult] = useState(null);
  const [txHashes, setTxHashes] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    setFormState((prev) => ({
      ...prev,
      walletAddress: wallet?.address || prev.walletAddress,
    }));
  }, [wallet?.address]);

  const title = ACTION_LABELS[action] || action;
  const identifier = pool?.identifier || pool?.positionIdentifier;
  const pairLabel = pool?.token0?.symbol && pool?.token1?.symbol
    ? `${pool.token0.symbol} / ${pool.token1.symbol}`
    : title;

  const handleChange = useCallback((event) => {
    const { name, value } = event.target;
    setFormState((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handlePrepare = useCallback(async () => {
    setStep(STEP.PREPARING);
    setError(null);
    try {
      const payload = buildPayload(action, formState);
      const data = await uniswapApi.preparePositionAction(action, payload);
      setPrepareData(data);
      setTxHashes([]);
      setStep(STEP.REVIEW);
    } catch (err) {
      setError(err.message);
      setStep(STEP.ERROR);
    }
  }, [action, formState]);

  useEffect(() => {
    if (action === 'collect-fees') {
      handlePrepare().catch(() => {});
    }
  }, [action, handlePrepare]);

  const handleExecute = useCallback(async () => {
    if (!prepareData?.txPlan?.length) {
      setError('No hay transacciones preparadas para ejecutar.');
      setStep(STEP.ERROR);
      return;
    }

    setStep(STEP.SIGNING);
    setError(null);
    const hashes = [];
    for (const tx of prepareData.txPlan) {
      const txHash = await sendTransaction(tx);
      if (!txHash) {
        setStep(STEP.REVIEW);
        return;
      }
      hashes.push(txHash);
      setTxHashes([...hashes]);
    }

    setStep(STEP.FINALIZING);
    try {
      const result = await uniswapApi.finalizePositionAction(action, {
        network: prepareData.network,
        version: prepareData.version,
        walletAddress: prepareData.walletAddress,
        positionIdentifier: prepareData.positionIdentifier,
        txHashes: hashes,
      });
      setFinalResult(result);
      setStep(STEP.DONE);
      if (onFinalized) onFinalized(result);
    } catch (err) {
      setError(err.message);
      setStep(STEP.ERROR);
    }
  }, [action, onFinalized, prepareData, sendTransaction]);

  const showRangeFields = action === 'modify-range' || action === 'rebalance' || action === 'create-position';
  const showAmountFields = action === 'increase-liquidity' || action === 'create-position';

  const quoteSummary = useMemo(() => prepareData?.quoteSummary || null, [prepareData]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Uniswap Actions</span>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.subtitle}>
              {action === 'create-position'
                ? 'Nueva posición LP desde la plataforma'
                : `${pairLabel}${identifier ? ` · #${identifier}` : ''}`}
            </p>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {step === STEP.FORM && (
          <>
            <div className={styles.formGrid}>
              {showAmountFields && (
                <>
                  <label className={styles.field}>
                    <span>Monto token0</span>
                    <input name="amount0Desired" value={formState.amount0Desired} onChange={handleChange} />
                  </label>
                  <label className={styles.field}>
                    <span>Monto token1</span>
                    <input name="amount1Desired" value={formState.amount1Desired} onChange={handleChange} />
                  </label>
                </>
              )}

              {action === 'decrease-liquidity' && (
                <label className={styles.field}>
                  <span>% de liquidez a retirar</span>
                  <input name="liquidityPercent" value={formState.liquidityPercent} onChange={handleChange} />
                </label>
              )}

              {showRangeFields && (
                <>
                  <label className={styles.field}>
                    <span>Precio inferior</span>
                    <input name="rangeLowerPrice" value={formState.rangeLowerPrice} onChange={handleChange} />
                  </label>
                  <label className={styles.field}>
                    <span>Precio superior</span>
                    <input name="rangeUpperPrice" value={formState.rangeUpperPrice} onChange={handleChange} />
                  </label>
                </>
              )}

              {action === 'rebalance' && (
                <label className={styles.field}>
                  <span>Peso objetivo token0 (%)</span>
                  <input name="targetWeightToken0Pct" value={formState.targetWeightToken0Pct} onChange={handleChange} />
                </label>
              )}

              {action === 'create-position' && (
                <>
                  <label className={styles.field}>
                    <span>Token0 address</span>
                    <input name="token0Address" value={formState.token0Address} onChange={handleChange} />
                  </label>
                  <label className={styles.field}>
                    <span>Token1 address</span>
                    <input name="token1Address" value={formState.token1Address} onChange={handleChange} />
                  </label>
                  <label className={styles.field}>
                    <span>Fee tier</span>
                    <input name="fee" value={formState.fee} onChange={handleChange} />
                  </label>
                </>
              )}

              <label className={styles.field}>
                <span>Slippage (bps)</span>
                <input name="slippageBps" value={formState.slippageBps} onChange={handleChange} />
              </label>
            </div>

            {pool?.unclaimedFeesUsd != null && (
              <div className={styles.infoCard}>
                <span className={styles.label}>Fees actuales</span>
                <strong>{formatUsd(pool.unclaimedFeesUsd)}</strong>
                {(pool.unclaimedFees0 != null || pool.unclaimedFees1 != null) && (
                  <div className={styles.inlineMeta}>
                    {pool.unclaimedFees0 != null && <span>{formatCompactPrice(pool.unclaimedFees0)} {pool.token0?.symbol}</span>}
                    {pool.unclaimedFees1 != null && <span>{formatCompactPrice(pool.unclaimedFees1)} {pool.token1?.symbol}</span>}
                  </div>
                )}
              </div>
            )}

            <div className={styles.actions}>
              <button className={styles.cancelBtn} onClick={onClose}>Cancelar</button>
              <button className={styles.confirmBtn} onClick={handlePrepare}>Preparar acción</button>
            </div>
          </>
        )}

        {step === STEP.PREPARING && (
          <div className={styles.section}>
            <p className={styles.statusText}>Preparando transacciones y cotización...</p>
          </div>
        )}

        {step === STEP.REVIEW && prepareData && (
          <>
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Resumen</h3>
              <SummaryRows data={quoteSummary} />
            </div>
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Plan de ejecución</h3>
              <div className={styles.planList}>
                {prepareData.txPlan.map((tx, index) => (
                  <div key={`${tx.kind}-${index}`} className={styles.planItem}>
                    <strong>{index + 1}. {tx.label || tx.kind}</strong>
                    <span>{tx.kind}</span>
                  </div>
                ))}
              </div>
              {!!prepareData.requiresApproval?.length && (
                <div className={styles.requirements}>
                  <h4 className={styles.sectionTitle}>Approvals</h4>
                  {prepareData.requiresApproval.map((item) => (
                    <div key={`${item.tokenAddress}-${item.spender}`} className={styles.planItem}>
                      <strong>{item.tokenSymbol}</strong>
                      <span>{item.formattedAmount}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {prepareData.postActionPositionPreview && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Preview final</h3>
                <SummaryRows data={prepareData.postActionPositionPreview} />
              </div>
            )}
            <div className={styles.actions}>
              <button className={styles.cancelBtn} onClick={onClose}>Cancelar</button>
              <button className={styles.confirmBtn} onClick={handleExecute}>
                Firmar {prepareData.txPlan.length} transacción{prepareData.txPlan.length > 1 ? 'es' : ''}
              </button>
            </div>
          </>
        )}

        {(step === STEP.SIGNING || step === STEP.FINALIZING) && (
          <div className={styles.section}>
            <p className={styles.statusText}>
              {step === STEP.SIGNING ? 'Firma las transacciones en tu wallet...' : 'Conciliando recibos y refrescando snapshots...'}
            </p>
            {txHashes.length > 0 && (
              <div className={styles.planList}>
                {txHashes.map((hash) => (
                  <div key={hash} className={styles.planItem}>
                    <strong>tx</strong>
                    <span className={styles.mono}>{hash.slice(0, 10)}...{hash.slice(-8)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === STEP.DONE && (
          <>
            <div className={styles.section}>
              <p className={styles.successText}>La acción se completó correctamente.</p>
              {finalResult?.positionChanges?.newPositionIdentifier && (
                <p className={styles.statusText}>
                  Nueva posición detectada: #{finalResult.positionChanges.newPositionIdentifier}
                </p>
              )}
              {finalResult?.protectionMigration?.migratedCount > 0 && (
                <p className={styles.statusText}>
                  Protecciones migradas: {finalResult.protectionMigration.migratedCount}
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <button className={styles.confirmBtn} onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}

        {step === STEP.ERROR && (
          <>
            <div className={styles.section}>
              <p className={styles.errorText}>{error || 'Error desconocido'}</p>
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
