import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatUsd, formatCompactPrice } from '../utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
import { POSITION_ACTION_STEP as STEP, usePositionActionFlow } from '../../../features/uniswap-pools/hooks/usePositionActionFlow';
import styles from './PositionActionModal.module.css';
import { ACTION_LABELS } from './position-action/constants';
import { getInitialState, buildPayload } from './position-action/form-state';
import ModifyRangeFields from './position-action/ModifyRangeFields';

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
  const initialFormState = useMemo(() => getInitialState(action, pool, defaults), [action, pool, defaults]);
  const {
    error,
    finalResult,
    formState,
    prepareData,
    quoteSummary,
    setFormState,
    step,
    txHashes,
    handleExecute,
    handlePrepare,
  } = usePositionActionFlow({
    action,
    initialFormState,
    buildPayload,
    sendTransaction,
    waitForTransactionReceipt,
    onFinalized,
    autoPrepare: action === 'collect-fees',
  });

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

  const showRangeFields = action === 'modify-range' || action === 'rebalance' || action === 'create-position';
  const showAmountFields = action === 'increase-liquidity' || action === 'create-position';
  const showSlippageField = action !== 'close-keep-assets';
  const isCloseAction = action === 'close-to-usdc' || action === 'close-keep-assets';
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
