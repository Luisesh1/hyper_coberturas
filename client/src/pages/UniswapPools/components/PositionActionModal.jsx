import { useCallback, useEffect, useMemo, useState } from 'react';
import { shortenAddress } from '../../../lib/wallet/transaction-utils';
import { formatUsd, formatCompactPrice } from '../utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
import { POSITION_ACTION_STEP as STEP, usePositionActionFlow } from '../../../features/uniswap-pools/hooks/usePositionActionFlow';
import ModalShell from '../../../components/shared/ModalShell/ModalShell';
import ui from '../../../styles/modal-controls.module.css';
import styles from './PositionActionModal.module.css';
import { ACTION_LABELS } from './position-action/constants';
import { getInitialState, buildPayload } from './position-action/form-state';
import ModifyRangeFields from './position-action/ModifyRangeFields';

// Las claves vienen en camelCase del backend; en mayúsculas y sin separar
// quedan ilegibles ("ESTIMATEDCURRENTAMOUNTS") y además no parten de línea.
function humanizeKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function SummaryRows({ data }) {
  if (!data) return null;

  return (
    <div className={ui.grid3}>
      {Object.entries(data).map(([key, value]) => {
        if (value == null || value === '') return null;
        if (typeof value === 'object' && !Array.isArray(value)) {
          return (
            <div key={key} className={ui.metricCard}>
              <span className={ui.metricLabel}>{humanizeKey(key)}</span>
              <code className={styles.pre}>{JSON.stringify(value, null, 2)}</code>
            </div>
          );
        }
        return (
          <div key={key} className={ui.metricCard}>
            <span className={ui.metricLabel}>{humanizeKey(key)}</span>
            {/* metricValue aporta el overflow-wrap: sin él, un poolId o una
                dirección hex desbordan la tarjeta y sacan scroll horizontal. */}
            <strong className={ui.metricValue}>{String(value)}</strong>
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
  prefilledPrepareResult = null,
  // Dueña del NFT de la posición. Cuando viene, es la única wallet que puede
  // firmar: el resto revierte en el PositionManager con `NotApproved`.
  ownerAddress = null,
  onClose,
  onFinalized,
}) {
  const [isSwitchingWallet, setIsSwitchingWallet] = useState(false);
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
    autoPrepare: action === 'collect-fees' && !prefilledPrepareResult,
    prefilledPrepareResult,
  });

  // Si conocemos la dueña de la posición, el prepare SIEMPRE va contra ella:
  // pisarla con la wallet conectada hacía que "Reintentar" pidiera el LP a una
  // wallet que no es su dueña y el backend lo rechazara con un 400.
  useEffect(() => {
    setFormState((prev) => ({
      ...prev,
      walletAddress: ownerAddress || wallet?.address || prev.walletAddress,
    }));
  }, [wallet?.address, ownerAddress]);

  const signerAddress = wallet?.address || null;
  const expectedSigner = ownerAddress || prepareData?.walletAddress || null;
  const walletMismatch = !!signerAddress
    && !!expectedSigner
    && signerAddress.toLowerCase() !== expectedSigner.toLowerCase();

  const handleChangeWallet = useCallback(async () => {
    if (!wallet?.changeWallet) return;
    setIsSwitchingWallet(true);
    try {
      await wallet.changeWallet();
    } catch {
      // `changeWallet` ya publica el error en el estado de la wallet; acá
      // solo evitamos la promesa sin manejar cuando el usuario cancela.
    } finally {
      setIsSwitchingWallet(false);
    }
  }, [wallet]);

  const targetStableSymbol = prepareData?.quoteSummary?.targetStableSymbol || null;
  const title = action === 'close-to-usdc' && targetStableSymbol
    ? `Cerrar LP a ${targetStableSymbol}`
    : (ACTION_LABELS[action] || action);
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

  const subtitle = action === 'create-position'
    ? 'Nueva posición LP desde la plataforma'
    : action === 'close-to-usdc'
      ? `${pairLabel}${identifier ? ` · #${identifier}` : ''} · cierre total con conversión a ${targetStableSymbol || 'stablecoin'}`
      : action === 'close-keep-assets'
        ? `${pairLabel}${identifier ? ` · #${identifier}` : ''} · cierre total conservando token0/token1`
        : `${pairLabel}${identifier ? ` · #${identifier}` : ''}`;

  // Cada paso trae su propio pie; el shell solo lo coloca.
  const footer = (() => {
    if (step === STEP.FORM) {
      return (
        <>
          <button type="button" className={ui.btnSecondary} onClick={onClose}>Cancelar</button>
          <button type="button" className={ui.btnPrimary} onClick={handlePrepare}>Preparar acción</button>
        </>
      );
    }
    if (step === STEP.REVIEW && prepareData) {
      return (
        <>
          <button type="button" className={ui.btnSecondary} onClick={onClose}>Cancelar</button>
          <button type="button" className={ui.btnPrimary} onClick={handleExecute}>
            Firmar {prepareData.txPlan.length} transacción{prepareData.txPlan.length > 1 ? 'es' : ''}
          </button>
        </>
      );
    }
    if (step === STEP.DONE) {
      return <button type="button" className={ui.btnPrimary} onClick={onClose}>Cerrar</button>;
    }
    if (step === STEP.ERROR) {
      return (
        <>
          <button type="button" className={ui.btnSecondary} onClick={onClose}>Cerrar</button>
          <button type="button" className={ui.btnPrimary} onClick={handlePrepare}>Reintentar</button>
        </>
      );
    }
    // PREPARING / SIGNING / FINALIZING: sin acciones, la operación está en curso.
    return null;
  })();

  const isBusyStep = step === STEP.PREPARING || step === STEP.SIGNING || step === STEP.FINALIZING;

  return (
    <ModalShell
      eyebrow="Uniswap Actions"
      title={title}
      desc={subtitle}
      ariaLabel={title}
      size="lg"
      stacked
      onClose={onClose}
      closeDisabled={isBusyStep}
      footer={footer}
    >
      <>
        {/* La posición la tiene que firmar su dueña. Mostramos con qué cuenta
            se está trabajando y dejamos cambiarla acá mismo: mandar al usuario
            a la extensión, sin decirle qué cuenta hace falta, era el paso
            donde el cierre se trababa con un revert sin motivo legible. */}
        {(signerAddress || expectedSigner) && (
          <div className={`${styles.walletBar} ${walletMismatch ? styles.walletBarWarn : ''}`}>
            <div className={styles.walletBarInfo}>
              <span className={ui.metricLabel}>Firmando con</span>
              <strong className={styles.walletBarAddress} title={signerAddress || ''}>
                {signerAddress ? shortenAddress(signerAddress) : 'Sin wallet conectada'}
              </strong>
            </div>
            {wallet?.changeWallet && (
              <button
                type="button"
                className={ui.btnGhost}
                onClick={handleChangeWallet}
                disabled={isBusyStep || isSwitchingWallet}
              >
                {isSwitchingWallet ? 'Abriendo wallet…' : 'Cambiar wallet'}
              </button>
            )}
          </div>
        )}

        {walletMismatch && (
          <div className={ui.noticeWarn}>
            Esta posición es de <strong title={expectedSigner}>{shortenAddress(expectedSigner)}</strong>
            {' '}y estás firmando con <strong>{shortenAddress(signerAddress)}</strong>.
            {wallet?.changeWallet ? ' Cambiá de wallet acá arriba' : ' Cambiá de cuenta en la wallet'} antes
            de firmar: con otra cuenta la transacción revierte.
          </div>
        )}

        {step === STEP.FORM && (
          <>
            <div className={ui.grid2}>
              {showAmountFields && (
                <>
                  <label className={ui.field}>
                    <span className={ui.fieldLabel}>Monto token0</span>
                    <input name="amount0Desired" value={formState.amount0Desired} onChange={handleChange} />
                  </label>
                  <label className={ui.field}>
                    <span className={ui.fieldLabel}>Monto token1</span>
                    <input name="amount1Desired" value={formState.amount1Desired} onChange={handleChange} />
                  </label>
                </>
              )}

              {action === 'decrease-liquidity' && (
                <label className={ui.field}>
                  <span className={ui.fieldLabel}>% de liquidez a retirar</span>
                  <input name="liquidityPercent" value={formState.liquidityPercent} onChange={handleChange} />
                </label>
              )}

              {isCloseAction && (
                <div className={ui.metricCard} style={{ gridColumn: '1 / -1' }}>
                  <span className={ui.metricLabel}>Cierre total</span>
                  <p className={ui.sectionHint} style={{ margin: "4px 0 0" }}>
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
                  <label className={ui.field}>
                    <span className={ui.fieldLabel}>Precio inferior</span>
                    <input name="rangeLowerPrice" value={formState.rangeLowerPrice} onChange={handleChange} />
                  </label>
                  <label className={ui.field}>
                    <span className={ui.fieldLabel}>Precio superior</span>
                    <input name="rangeUpperPrice" value={formState.rangeUpperPrice} onChange={handleChange} />
                  </label>
                </>
              )}

              {action === 'rebalance' && (
                <label className={ui.field}>
                  <span className={ui.fieldLabel}>Peso objetivo token0 (%)</span>
                  <input name="targetWeightToken0Pct" value={formState.targetWeightToken0Pct} onChange={handleChange} />
                </label>
              )}

              {action === 'create-position' && (
                <>
                  <label className={ui.field}>
                    <span className={ui.fieldLabel}>Token0 address</span>
                    <input name="token0Address" value={formState.token0Address} onChange={handleChange} />
                  </label>
                  <label className={ui.field}>
                    <span className={ui.fieldLabel}>Token1 address</span>
                    <input name="token1Address" value={formState.token1Address} onChange={handleChange} />
                  </label>
                  <label className={ui.field}>
                    <span className={ui.fieldLabel}>Fee tier</span>
                    <input name="fee" value={formState.fee} onChange={handleChange} />
                  </label>
                  {formState.version === 'v4' && (
                    <>
                      <label className={ui.field}>
                        <span className={ui.fieldLabel}>Tick spacing</span>
                        <input name="tickSpacing" value={formState.tickSpacing} onChange={handleChange} />
                      </label>
                      <label className={ui.field}>
                        <span className={ui.fieldLabel}>Hooks</span>
                        <input name="hooks" value={formState.hooks} onChange={handleChange} placeholder="0x000..." />
                      </label>
                      <label className={ui.field}>
                        <span className={ui.fieldLabel}>Pool ID (opcional)</span>
                        <input name="poolId" value={formState.poolId} onChange={handleChange} />
                      </label>
                    </>
                  )}
                </>
              )}

              {showSlippageField && (
                <label className={ui.field}>
                  <span className={ui.fieldLabel}>Slippage (bps)</span>
                  <input name="slippageBps" value={formState.slippageBps} onChange={handleChange} />
                </label>
              )}
            </div>

            {pool?.unclaimedFeesUsd != null && (
              <div className={ui.metricCard}>
                <span className={ui.metricLabel}>Fees actuales</span>
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
              <div className={ui.metricCard}>
                <span className={ui.metricLabel}>Metadatos V4</span>
                <div className={styles.inlineMeta}>
                  {formState.poolId && <span>Pool ID: {formState.poolId}</span>}
                  {formState.tickSpacing && <span>Tick spacing: {formState.tickSpacing}</span>}
                  <span>Hooks: {formState.hooks || '0x0000000000000000000000000000000000000000'}</span>
                </div>
              </div>
            )}
          </>
        )}

        {step === STEP.PREPARING && (
          <div className={ui.section}>
            <p className={ui.sectionHint}>Preparando transacciones y cotización...</p>
          </div>
        )}

        {step === STEP.REVIEW && prepareData && (
          <>
            <div className={ui.section}>
              <h3 className={ui.sectionTitle}>Resumen</h3>
              <SummaryRows data={quoteSummary} />
            </div>
            {quoteSummary?.estimatedCosts && (
              <div className={ui.section}>
                <h3 className={ui.sectionTitle}>Costos proyectados</h3>
                <div className={ui.grid3}>
                  <div className={ui.metricCard}>
                    <span className={ui.metricLabel}>Gas estimado</span>
                    <strong className={ui.metricValue}>
                      {quoteSummary.estimatedCosts.gasCostUsd != null
                        ? formatUsd(quoteSummary.estimatedCosts.gasCostUsd)
                        : 'N/D'}
                    </strong>
                    {quoteSummary.estimatedCosts.gasCostEth != null && (
                      <span className={ui.fieldHint}>
                        {formatNumber(quoteSummary.estimatedCosts.gasCostEth, 6)} ETH
                      </span>
                    )}
                  </div>
                  {quoteSummary.estimatedCosts.slippageCostUsd != null && quoteSummary.estimatedCosts.slippageCostUsd > 0 && (
                    <div className={ui.metricCard}>
                      <span className={ui.metricLabel}>Slippage máx. (rebalanceo automático)</span>
                      <strong className={ui.metricValue}>
                        {formatUsd(quoteSummary.estimatedCosts.slippageCostUsd)}
                      </strong>
                    </div>
                  )}
                  <div className={ui.metricCard}>
                    <span className={ui.metricLabel}>Total estimado</span>
                    <strong className={ui.metricValue} style={{ color: "var(--status-error)" }}>
                      {formatUsd(quoteSummary.estimatedCosts.totalEstimatedCostUsd)}
                    </strong>
                    <span className={ui.fieldHint}>
                      {quoteSummary.estimatedCosts.txCount} transacción{quoteSummary.estimatedCosts.txCount > 1 ? 'es' : ''}
                    </span>
                  </div>
                </div>
                {quoteSummary.estimatedCosts.txBreakdown?.length > 0 && (
                  <details style={{ marginTop: '8px', color: "var(--text-secondary)", fontSize: '0.78rem' }}>
                    <summary style={{ cursor: 'pointer', color: "var(--teal)" }}>Desglose por transacción</summary>
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
            <div className={ui.section}>
              <h3 className={ui.sectionTitle}>Plan de ejecución</h3>
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
                  <h4 className={ui.sectionTitle}>Approvals</h4>
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
              <div className={ui.section}>
                <h3 className={ui.sectionTitle}>Preview final</h3>
                <SummaryRows data={prepareData.postActionPositionPreview} />
              </div>
            )}
            {prepareData.protectionImpact?.hasPotentialMigration && (
              <div className={ui.section}>
                <p className={ui.sectionHint}>
                  Esta operación puede crear un nuevo NFT / positionId y migrará la protección asociada si existe.
                </p>
              </div>
            )}
            {prepareData.protectionImpact?.willDeactivateProtection && (
              <div className={ui.section}>
                <p className={ui.sectionHint}>
                  La protección ligada a esta posición se actualizará como último paso y quedará desactivada cuando el cierre termine correctamente.
                </p>
              </div>
            )}
            {prepareData.txPlan.length > 1 && (action === 'modify-range' || action === 'rebalance') && (
              <div className={ui.section}>
                <div className={ui.notice}>
                  <strong className={ui.metricLabel}>Nota sobre firma</strong>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: "var(--text-secondary)" }}>
                    MetaMask puede mostrar "Es probable que esta transacción falle" en el Mint.
                    Esto es normal — la simulación no ve el resultado de las transacciones previas (decrease, swap).
                    Firmá todas las transacciones en orden para completar la operación.
                  </p>
                </div>
              </div>
            )}
            {action === 'modify-range' && quoteSummary?.swap && (
              <div className={ui.section}>
                <div className={ui.notice}>
                  <strong className={ui.metricLabel}>Redeploy del capital</strong>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: "var(--text-secondary)" }}>
                    Al cambiar el rango, el sistema rebalancea los activos antes del mint para volver a desplegar el capital del LP en la nueva banda.
                    Solo puede quedar un remanente chico por slippage o redondeos del swap.
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        {(step === STEP.SIGNING || step === STEP.FINALIZING) && (
          <div className={ui.section}>
            <p className={ui.sectionHint}>
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
            <div className={ui.section}>
              <p className={styles.successText}>
                {action === 'close-to-usdc'
                  ? 'El LP se cerró y los fondos se convirtieron a USDC correctamente.'
                  : action === 'close-keep-assets'
                    ? 'El LP se cerró y los activos se devolvieron a la wallet correctamente.'
                    : 'La acción se completó correctamente.'}
              </p>
              {finalResult?.positionChanges?.newPositionIdentifier && (
                <p className={ui.sectionHint}>
                  Nueva posición detectada: #{finalResult.positionChanges.newPositionIdentifier}
                </p>
              )}
              {finalResult?.protectionMigration?.migratedCount > 0 && (
                <p className={ui.sectionHint}>
                  Protecciones migradas: {finalResult.protectionMigration.migratedCount}
                </p>
              )}
              {finalResult?.protectionMigration?.deactivatedCount > 0 && (
                <p className={ui.sectionHint}>
                  Protecciones desactivadas: {finalResult.protectionMigration.deactivatedCount}
                </p>
              )}
            </div>
          </>
        )}

        {step === STEP.ERROR && (
          <>
            <div className={ui.section}>
              <p className={ui.errorBox}>{error || 'Error desconocido'}</p>
            </div>
          </>
        )}
      </>
    </ModalShell>
  );
}
