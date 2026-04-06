import { useCallback, useEffect, useMemo, useState } from 'react';
import { uniswapApi } from '../../../services/api';
import { formatUsd, formatCompactPrice } from '../utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
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
  'close-to-usdc': 'Cerrar LP a USDC',
  'close-keep-assets': 'Cerrar LP conservando activos',
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
      tickSpacing: pool?.tickSpacing != null ? String(pool.tickSpacing) : '',
      hooks: pool?.hooks || '',
      poolId: pool?.poolId || '',
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
    poolId: pool?.poolId || '',
    tickSpacing: pool?.tickSpacing != null ? String(pool.tickSpacing) : '',
    hooks: pool?.hooks || '',
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
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
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
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
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
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'modify-range':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
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
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
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
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        amount0Desired: formState.amount0Desired,
        amount1Desired: formState.amount1Desired,
        rangeLowerPrice: Number(formState.rangeLowerPrice),
        rangeUpperPrice: Number(formState.rangeUpperPrice),
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'close-to-usdc':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
        slippageBps: Number(formState.slippageBps || 100),
      };
    case 'close-keep-assets':
      return {
        network: formState.network,
        version: formState.version,
        walletAddress: formState.walletAddress,
        positionIdentifier: formState.positionIdentifier,
        poolId: formState.poolId || undefined,
        tickSpacing: formState.tickSpacing ? Number(formState.tickSpacing) : undefined,
        hooks: formState.hooks || undefined,
      };
    default:
      return formState;
  }
}

function pctToPrice(priceCurrent, pct) {
  return priceCurrent * (1 + pct / 100);
}

function priceToPct(priceCurrent, price) {
  if (!priceCurrent || priceCurrent <= 0) return 0;
  return ((price - priceCurrent) / priceCurrent) * 100;
}

function ModifyRangeFields({ pool, formState, setFormState }) {
  const priceCurrent = Number(pool?.priceCurrent || 0);
  const [mode, setMode] = useState('absolute');
  const [lowerPct, setLowerPct] = useState(() => {
    const p = Number(formState.rangeLowerPrice || 0);
    return p > 0 && priceCurrent > 0 ? priceToPct(priceCurrent, p).toFixed(2) : '-5';
  });
  const [upperPct, setUpperPct] = useState(() => {
    const p = Number(formState.rangeUpperPrice || 0);
    return p > 0 && priceCurrent > 0 ? priceToPct(priceCurrent, p).toFixed(2) : '5';
  });

  const lowerPrice = Number(formState.rangeLowerPrice || 0);
  const upperPrice = Number(formState.rangeUpperPrice || 0);
  const lowerPctDisplay = priceCurrent > 0 && lowerPrice > 0 ? priceToPct(priceCurrent, lowerPrice) : 0;
  const upperPctDisplay = priceCurrent > 0 && upperPrice > 0 ? priceToPct(priceCurrent, upperPrice) : 0;
  const rangeWidth = upperPrice > 0 && lowerPrice > 0 ? ((upperPrice - lowerPrice) / priceCurrent) * 100 : 0;

  const handleLowerPctChange = (event) => {
    const val = event.target.value;
    setLowerPct(val);
    const num = Number(val);
    if (Number.isFinite(num) && priceCurrent > 0) {
      setFormState((prev) => ({ ...prev, rangeLowerPrice: String(pctToPrice(priceCurrent, num).toFixed(6)) }));
    }
  };

  const handleUpperPctChange = (event) => {
    const val = event.target.value;
    setUpperPct(val);
    const num = Number(val);
    if (Number.isFinite(num) && priceCurrent > 0) {
      setFormState((prev) => ({ ...prev, rangeUpperPrice: String(pctToPrice(priceCurrent, num).toFixed(6)) }));
    }
  };

  const handleAbsoluteChange = (event) => {
    const { name, value } = event.target;
    setFormState((prev) => ({ ...prev, [name]: value }));
    const num = Number(value);
    if (Number.isFinite(num) && priceCurrent > 0) {
      if (name === 'rangeLowerPrice') setLowerPct(priceToPct(priceCurrent, num).toFixed(2));
      if (name === 'rangeUpperPrice') setUpperPct(priceToPct(priceCurrent, num).toFixed(2));
    }
  };

  const token0Symbol = pool?.token0?.symbol || 'Token0';
  const token1Symbol = pool?.token1?.symbol || 'Token1';
  const totalLpValue = Number(pool?.positionValueUsd || 0);
  const amount0 = Number(pool?.positionAmount0 || 0);
  const amount1 = Number(pool?.positionAmount1 || 0);

  return (
    <>
      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <span>Precio actual</span>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ color: '#66e1db', fontSize: '1.1rem' }}>
            {formatNumber(priceCurrent, 4)} {token1Symbol}/{token0Symbol}
          </strong>
          <span style={{ color: '#97a9bd', fontSize: '0.82rem' }}>
            LP: {formatNumber(amount0, 6)} {token0Symbol} + {formatNumber(amount1, 4)} {token1Symbol}
            {totalLpValue > 0 ? ` (${formatUsd(totalLpValue)})` : ''}
          </span>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={() => setMode('absolute')}
            style={{
              padding: '6px 14px', borderRadius: '8px', border: '1px solid',
              borderColor: mode === 'absolute' ? '#66e1db' : 'rgba(133,157,181,0.2)',
              background: mode === 'absolute' ? 'rgba(102,225,219,0.12)' : 'transparent',
              color: mode === 'absolute' ? '#66e1db' : '#97a9bd', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem',
            }}
          >
            Precio absoluto
          </button>
          <button
            type="button"
            onClick={() => setMode('percent')}
            style={{
              padding: '6px 14px', borderRadius: '8px', border: '1px solid',
              borderColor: mode === 'percent' ? '#66e1db' : 'rgba(133,157,181,0.2)',
              background: mode === 'percent' ? 'rgba(102,225,219,0.12)' : 'transparent',
              color: mode === 'percent' ? '#66e1db' : '#97a9bd', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem',
            }}
          >
            % desde precio actual
          </button>
        </div>
      </div>

      {mode === 'absolute' ? (
        <>
          <label className={styles.field}>
            <span>Precio inferior</span>
            <input name="rangeLowerPrice" value={formState.rangeLowerPrice} onChange={handleAbsoluteChange} />
            <span style={{ color: '#97a9bd', fontSize: '0.75rem' }}>
              {lowerPctDisplay >= 0 ? '+' : ''}{formatNumber(lowerPctDisplay, 2)}% desde actual
            </span>
          </label>
          <label className={styles.field}>
            <span>Precio superior</span>
            <input name="rangeUpperPrice" value={formState.rangeUpperPrice} onChange={handleAbsoluteChange} />
            <span style={{ color: '#97a9bd', fontSize: '0.75rem' }}>
              {upperPctDisplay >= 0 ? '+' : ''}{formatNumber(upperPctDisplay, 2)}% desde actual
            </span>
          </label>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span>Límite inferior (%)</span>
            <input type="number" step="0.1" value={lowerPct} onChange={handleLowerPctChange} />
            <span style={{ color: '#97a9bd', fontSize: '0.75rem' }}>
              = {formatNumber(Number(formState.rangeLowerPrice || 0), 4)} {token1Symbol}/{token0Symbol}
            </span>
          </label>
          <label className={styles.field}>
            <span>Límite superior (%)</span>
            <input type="number" step="0.1" value={upperPct} onChange={handleUpperPctChange} />
            <span style={{ color: '#97a9bd', fontSize: '0.75rem' }}>
              = {formatNumber(Number(formState.rangeUpperPrice || 0), 4)} {token1Symbol}/{token0Symbol}
            </span>
          </label>
        </>
      )}

      {lowerPrice > 0 && upperPrice > 0 && priceCurrent > 0 && (
        <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
          <span>Resumen del nuevo rango</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
            <div style={{ background: 'rgba(102,225,219,0.06)', padding: '8px 12px', borderRadius: '10px' }}>
              <div style={{ color: '#97a9bd', fontSize: '0.72rem', textTransform: 'uppercase' }}>Ancho total</div>
              <strong style={{ color: '#f5f7fb' }}>{formatNumber(rangeWidth, 2)}%</strong>
            </div>
            <div style={{ background: 'rgba(102,225,219,0.06)', padding: '8px 12px', borderRadius: '10px' }}>
              <div style={{ color: '#97a9bd', fontSize: '0.72rem', textTransform: 'uppercase' }}>Inferior</div>
              <strong style={{ color: lowerPctDisplay < 0 ? '#ff7d7d' : '#3dd991' }}>
                {lowerPctDisplay >= 0 ? '+' : ''}{formatNumber(lowerPctDisplay, 2)}%
              </strong>
            </div>
            <div style={{ background: 'rgba(102,225,219,0.06)', padding: '8px 12px', borderRadius: '10px' }}>
              <div style={{ color: '#97a9bd', fontSize: '0.72rem', textTransform: 'uppercase' }}>Superior</div>
              <strong style={{ color: upperPctDisplay > 0 ? '#3dd991' : '#ff7d7d' }}>
                {upperPctDisplay >= 0 ? '+' : ''}{formatNumber(upperPctDisplay, 2)}%
              </strong>
            </div>
            <div style={{ background: 'rgba(102,225,219,0.06)', padding: '8px 12px', borderRadius: '10px' }}>
              <div style={{ color: '#97a9bd', fontSize: '0.72rem', textTransform: 'uppercase' }}>Centrado</div>
              <strong style={{ color: '#f5f7fb' }}>
                {priceCurrent >= lowerPrice && priceCurrent <= upperPrice ? 'Dentro' : 'Fuera'}
              </strong>
            </div>
          </div>
        </div>
      )}
    </>
  );
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
  waitForTransactionReceipt,
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
    for (const [index, tx] of prepareData.txPlan.entries()) {
      const txLabel = tx?.label || `Transacción ${index + 1}`;
      const txHash = await sendTransaction(tx);
      if (!txHash) {
        setError(`La firma de "${txLabel}" fue cancelada o la wallet no devolvió un hash.`);
        setStep(STEP.ERROR);
        return;
      }
      hashes.push(txHash);
      setTxHashes([...hashes]);
      if (waitForTransactionReceipt) {
        try {
          const receipt = await waitForTransactionReceipt(txHash);
          if (!receipt || Number(receipt.status) !== 1) {
            setError(`La transacción "${txLabel}" falló on-chain. Revisa la wallet antes de continuar.`);
            setStep(STEP.ERROR);
            return;
          }
        } catch (err) {
          setError(err.message || `No se pudo confirmar "${txLabel}".`);
          setStep(STEP.ERROR);
          return;
        }
      }
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
  const showSlippageField = action !== 'close-keep-assets';
  const isCloseAction = action === 'close-to-usdc' || action === 'close-keep-assets';

  const quoteSummary = useMemo(() => prepareData?.quoteSummary || null, [prepareData]);
  const isV4 = (pool?.version || formState.version) === 'v4';

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
                : action === 'close-to-usdc'
                  ? `${pairLabel}${identifier ? ` · #${identifier}` : ''} · cierre total con conversión a USDC`
                  : action === 'close-keep-assets'
                    ? `${pairLabel}${identifier ? ` · #${identifier}` : ''} · cierre total conservando token0/token1`
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

              {isCloseAction && (
                <div className={styles.infoCard} style={{ gridColumn: '1 / -1' }}>
                  <span className={styles.label}>Cierre total</span>
                  <p style={{ margin: '4px 0 0', color: '#97a9bd', fontSize: '0.82rem' }}>
                    Esta acción retirará el 100% de la liquidez y aplicará la actualización de protección solo al final, después de confirmar el estado on-chain.
                  </p>
                </div>
              )}

              {showRangeFields && action === 'modify-range' && pool?.priceCurrent > 0 && (
                <ModifyRangeFields
                  pool={pool}
                  formState={formState}
                  setFormState={setFormState}
                />
              )}

              {showRangeFields && action !== 'modify-range' && (
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
                  {formState.version === 'v4' && (
                    <>
                      <label className={styles.field}>
                        <span>Tick spacing</span>
                        <input name="tickSpacing" value={formState.tickSpacing} onChange={handleChange} />
                      </label>
                      <label className={styles.field}>
                        <span>Hooks</span>
                        <input name="hooks" value={formState.hooks} onChange={handleChange} placeholder="0x000..." />
                      </label>
                      <label className={styles.field}>
                        <span>Pool ID (opcional)</span>
                        <input name="poolId" value={formState.poolId} onChange={handleChange} />
                      </label>
                    </>
                  )}
                </>
              )}

              {showSlippageField && (
                <label className={styles.field}>
                  <span>Slippage (bps)</span>
                  <input name="slippageBps" value={formState.slippageBps} onChange={handleChange} />
                </label>
              )}
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

            {isV4 && (
              <div className={styles.infoCard}>
                <span className={styles.label}>Metadatos V4</span>
                <div className={styles.inlineMeta}>
                  {formState.poolId && <span>Pool ID: {formState.poolId}</span>}
                  {formState.tickSpacing && <span>Tick spacing: {formState.tickSpacing}</span>}
                  <span>Hooks: {formState.hooks || '0x0000000000000000000000000000000000000000'}</span>
                </div>
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
            {quoteSummary?.estimatedCosts && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Costos proyectados</h3>
                <div className={styles.summaryGrid}>
                  <div className={styles.summaryItem}>
                    <span className={styles.label}>Gas estimado</span>
                    <strong style={{ color: '#f5f7fb' }}>
                      {quoteSummary.estimatedCosts.gasCostUsd != null
                        ? formatUsd(quoteSummary.estimatedCosts.gasCostUsd)
                        : 'N/D'}
                    </strong>
                    {quoteSummary.estimatedCosts.gasCostEth != null && (
                      <span style={{ color: '#97a9bd', fontSize: '0.78rem' }}>
                        {formatNumber(quoteSummary.estimatedCosts.gasCostEth, 6)} ETH
                      </span>
                    )}
                  </div>
                  {quoteSummary.estimatedCosts.slippageCostUsd != null && quoteSummary.estimatedCosts.slippageCostUsd > 0 && (
                    <div className={styles.summaryItem}>
                      <span className={styles.label}>Slippage máx. (rebalanceo automático)</span>
                      <strong style={{ color: '#f5f7fb' }}>
                        {formatUsd(quoteSummary.estimatedCosts.slippageCostUsd)}
                      </strong>
                    </div>
                  )}
                  <div className={styles.summaryItem}>
                    <span className={styles.label}>Total estimado</span>
                    <strong style={{ color: '#ff7d7d' }}>
                      {formatUsd(quoteSummary.estimatedCosts.totalEstimatedCostUsd)}
                    </strong>
                    <span style={{ color: '#97a9bd', fontSize: '0.78rem' }}>
                      {quoteSummary.estimatedCosts.txCount} transacción{quoteSummary.estimatedCosts.txCount > 1 ? 'es' : ''}
                    </span>
                  </div>
                </div>
                {quoteSummary.estimatedCosts.txBreakdown?.length > 0 && (
                  <details style={{ marginTop: '8px', color: '#97a9bd', fontSize: '0.78rem' }}>
                    <summary style={{ cursor: 'pointer', color: '#66e1db' }}>Desglose por transacción</summary>
                    <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {quoteSummary.estimatedCosts.txBreakdown.map((item, index) => (
                        <div key={index} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{item.label}</span>
                          <span>{formatNumber(item.gasUnits, 0)} gas</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Plan de ejecución</h3>
              <div className={styles.planList}>
                {prepareData.txPlan.map((tx, index) => (
                  <div key={`${tx.kind}-${index}`} className={styles.planItem}>
                    <strong>{index + 1}. {tx.label || tx.kind}</strong>
                    <span>{tx.v4Actions?.length ? tx.v4Actions.join(' -> ') : tx.kind}</span>
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
            {prepareData.protectionImpact?.hasPotentialMigration && (
              <div className={styles.section}>
                <p className={styles.statusText}>
                  Esta operación puede crear un nuevo NFT / positionId y migrará la protección asociada si existe.
                </p>
              </div>
            )}
            {prepareData.protectionImpact?.willDeactivateProtection && (
              <div className={styles.section}>
                <p className={styles.statusText}>
                  La protección ligada a esta posición se actualizará como último paso y quedará desactivada cuando el cierre termine correctamente.
                </p>
              </div>
            )}
            {prepareData.txPlan.length > 1 && (action === 'modify-range' || action === 'rebalance') && (
              <div className={styles.section}>
                <div className={styles.infoCard}>
                  <span className={styles.label}>Nota sobre firma</span>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#97a9bd' }}>
                    MetaMask puede mostrar "Es probable que esta transacción falle" en el Mint.
                    Esto es normal — la simulación no ve el resultado de las transacciones previas (decrease, swap).
                    Firmá todas las transacciones en orden para completar la operación.
                  </p>
                </div>
              </div>
            )}
            {action === 'modify-range' && quoteSummary?.swap && (
              <div className={styles.section}>
                <div className={styles.infoCard}>
                  <span className={styles.label}>Redeploy del capital</span>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#97a9bd' }}>
                    Al cambiar el rango, el sistema rebalancea los activos antes del mint para volver a desplegar el capital del LP en la nueva banda.
                    Solo puede quedar un remanente chico por slippage o redondeos del swap.
                  </p>
                </div>
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
              <p className={styles.successText}>
                {action === 'close-to-usdc'
                  ? 'El LP se cerró y los fondos se convirtieron a USDC correctamente.'
                  : action === 'close-keep-assets'
                    ? 'El LP se cerró y los activos se devolvieron a la wallet correctamente.'
                    : 'La acción se completó correctamente.'}
              </p>
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
              {finalResult?.protectionMigration?.deactivatedCount > 0 && (
                <p className={styles.statusText}>
                  Protecciones desactivadas: {finalResult.protectionMigration.deactivatedCount}
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
