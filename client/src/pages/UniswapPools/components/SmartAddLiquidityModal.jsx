import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd } from '../utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
import { getExplorerLink } from '../utils/pool-helpers';
import { uniswapApi } from '../../../services/api';
import { useWalletExecution, WALLET_EXECUTION_STATE } from '../../../hooks/useWalletExecution';
import styles from './SmartCreatePoolModal.module.css';
import { STEP, FEE_TIERS } from './smart-create/constants';
import {
  buildSelectionMap,
  deriveFundingIssue,
  formatFundingIssueTitle,
} from './smart-create/helpers';
import StepPill from './smart-create/StepPill';

/**
 * Wizard de "smart add liquidity" para una posición existente:
 *   1. Monto: el usuario tipea cuántos USD quiere agregar.
 *   2. Fondeo: muestra los assets de la wallet, permite seleccionar cuáles
 *      usar como fuente y arma el plan de swaps necesarios.
 *   3. Review: lista de transacciones a firmar (wraps, swaps, approvals,
 *      increase-liquidity).
 *   4. Signing: firma secuencial.
 *   5. Done.
 *
 * Reusa la misma maquinaria del SmartCreatePoolModal: el endpoint
 * `POST /uniswap/increase-liquidity/funding-plan` deriva token0/token1/range
 * desde la posición y delega en `buildFundingPlan`. La diferencia con
 * crear pool es que el rango ya está fijo, no hay paso "RANGE" ni "POOL".
 */
export default function SmartAddLiquidityModal({
  wallet,
  sendTransaction,
  waitForTransactionReceipt,
  defaults,
  pool,
  onClose,
  onFinalized,
}) {
  const network = defaults?.network || pool?.network || 'arbitrum';
  const version = defaults?.version || pool?.version || 'v3';
  const positionIdentifier = String(
    defaults?.positionIdentifier || pool?.identifier || pool?.positionIdentifier || ''
  );
  const explorerUrl = pool?.explorerUrl || null;
  const initialUsdTarget = Number(defaults?.defaultTotalUsdTarget) > 0
    ? String(Math.round(Number(defaults.defaultTotalUsdTarget)))
    : '500';

  const [step, setStep] = useState('amount'); // amount | funding | review | signing | done | error
  const [totalUsdTarget, setTotalUsdTarget] = useState(initialUsdTarget);
  const [maxSlippageBps, setMaxSlippageBps] = useState('50');
  const [importTokenAddress, setImportTokenAddress] = useState('');
  const [importedFundingTokens, setImportedFundingTokens] = useState([]);
  const [assetSelections, setAssetSelections] = useState({});
  const [hasFundingEdits, setHasFundingEdits] = useState(false);
  const [availableAssets, setAvailableAssets] = useState([]);
  const [fundingPlan, setFundingPlan] = useState(null);
  const [fundingIssue, setFundingIssue] = useState(null);
  const [prepareData, setPrepareData] = useState(null);
  const [txHashes, setTxHashes] = useState([]);
  const [completedTxIndex, setCompletedTxIndex] = useState(-1);
  const [currentTxIndex, setCurrentTxIndex] = useState(-1);
  const [failedTxLabel, setFailedTxLabel] = useState('');
  const [error, setError] = useState('');
  const [loadingMessage, setLoadingMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const execution = useWalletExecution();

  // Guard contra setStates después de unmount (mismo patrón que
  // SmartCreatePoolModal tras el fix de race en refreshFundingPlan).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!execution.normalizedError?.message) return;
    setError(execution.normalizedError.message);
  }, [execution.normalizedError]);

  useEffect(() => {
    setTxHashes(execution.txHashes);
    setCompletedTxIndex(execution.progress.completed - 1);
    setCurrentTxIndex(execution.currentTx?.index ?? -1);

    if (execution.state === WALLET_EXECUTION_STATE.PREFLIGHT) {
      setLoadingMessage('Validando transacciones antes de abrir la wallet...');
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.AWAITING_WALLET) {
      setLoadingMessage(execution.currentTx?.label
        ? `Firma "${execution.currentTx.label}" en tu wallet...`
        : 'Firma la transacción en tu wallet...');
      setStep('signing');
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.BROADCAST_SUBMITTED || execution.state === WALLET_EXECUTION_STATE.NETWORK_CONFIRMING) {
      setLoadingMessage(execution.currentTx?.label
        ? `Esperando confirmación on-chain de "${execution.currentTx.label}"...`
        : 'Esperando confirmación on-chain...');
      setStep('signing');
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.FINALIZE_PENDING) {
      setLoadingMessage('Conciliando recibos y finalizando el aumento de liquidez...');
      setStep('signing');
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.DONE) {
      setLoadingMessage('');
      setStep('done');
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.NEEDS_RECONCILE || execution.state === WALLET_EXECUTION_STATE.FAILED) {
      setLoadingMessage('');
      setStep('error');
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.IDLE) {
      setLoadingMessage('');
    }
  }, [execution.currentTx, execution.progress.completed, execution.state, execution.txHashes]);

  const normalizedFundingSelections = useMemo(() => (
    Object.entries(assetSelections)
      .filter(([, value]) => value?.enabled)
      .map(([assetId, value]) => ({
        assetId,
        amount: value.amount,
        enabled: true,
      }))
  ), [assetSelections]);

  async function refreshFundingPlan({ preserveSelections = false } = {}) {
    if (!wallet?.address || !positionIdentifier) return;
    if (!Number(totalUsdTarget) || Number(totalUsdTarget) <= 0) {
      setError('Define un monto en USD mayor que cero.');
      return;
    }
    setError('');
    setIsBusy(true);
    setLoadingMessage('Construyendo plan de fondeo y swaps...');

    try {
      const assetsData = await uniswapApi.getSmartCreateAssets({
        network,
        walletAddress: wallet.address,
        importTokenAddresses: importedFundingTokens,
      });
      if (!isMountedRef.current) return;
      setAvailableAssets(assetsData.assets || []);

      const plan = await uniswapApi.smartIncreaseLiquidityFundingPlan({
        network,
        version,
        walletAddress: wallet.address,
        positionIdentifier,
        totalUsdTarget: Number(totalUsdTarget),
        maxSlippageBps: Number(maxSlippageBps || 50),
        importTokenAddresses: importedFundingTokens,
        fundingSelections: preserveSelections ? normalizedFundingSelections : undefined,
      });
      if (!isMountedRef.current) return;

      setAvailableAssets(plan.availableFundingAssets || assetsData.assets || []);
      setFundingPlan(plan);
      setFundingIssue(null);
      if (!preserveSelections || !hasFundingEdits) {
        setAssetSelections(buildSelectionMap(plan.selectedFundingAssets || []));
      }
      setStep('funding');
    } catch (err) {
      if (!isMountedRef.current) return;
      setFundingPlan(null);
      setFundingIssue(deriveFundingIssue(err));
      setError('');
      setStep('funding');
    } finally {
      if (isMountedRef.current) {
        setIsBusy(false);
        setLoadingMessage('');
      }
    }
  }

  async function handleContinueToFunding() {
    if (!Number(totalUsdTarget) || Number(totalUsdTarget) <= 0) {
      setError('Ingresa un monto en USD mayor que cero.');
      return;
    }
    setHasFundingEdits(false);
    await refreshFundingPlan({ preserveSelections: false });
  }

  async function handlePrepareReview() {
    if (!fundingPlan) {
      setError('Genera primero un plan de fondeo.');
      return;
    }
    setError('');
    setIsBusy(true);
    setLoadingMessage('Validando el plan final y preparando transacciones...');
    try {
      const data = await uniswapApi.prepareIncreaseLiquidity({
        network,
        version,
        walletAddress: wallet.address,
        positionIdentifier,
        totalUsdTarget: Number(totalUsdTarget),
        maxSlippageBps: Number(maxSlippageBps || 50),
        importTokenAddresses: importedFundingTokens,
        fundingSelections: normalizedFundingSelections,
      });
      if (!isMountedRef.current) return;
      setPrepareData(data);
      setFundingIssue(null);
      setStep('review');
    } catch (err) {
      if (!isMountedRef.current) return;
      setFundingIssue(deriveFundingIssue(err));
      setError('');
      setStep('funding');
    } finally {
      if (isMountedRef.current) {
        setIsBusy(false);
        setLoadingMessage('');
      }
    }
  }

  async function handleExecute() {
    if (!prepareData?.txPlan?.length) {
      setError('No hay transacciones preparadas para firmar.');
      return;
    }
    setError('');
    setFailedTxLabel('');
    const finalizeResult = await execution.runPlan({
      action: 'increase-liquidity',
      chainId: prepareData.txPlan[0]?.chainId || null,
      txPlan: prepareData.txPlan,
      finalizePayload: {
        network,
        version,
        walletAddress: wallet.address,
        positionIdentifier,
      },
      finalizeKind: 'position_action',
    });

    if (finalizeResult?.status === 'done') {
      onFinalized?.(finalizeResult);
    } else if (!finalizeResult && execution.currentTx?.label) {
      setFailedTxLabel(execution.currentTx.label);
    }
  }

  function handleAddFundingImport() {
    const normalized = importTokenAddress.trim();
    if (!normalized) return;
    if (!importedFundingTokens.includes(normalized)) {
      setImportedFundingTokens((prev) => [...prev, normalized]);
    }
    setImportTokenAddress('');
    setHasFundingEdits(true);
  }

  const reviewFundingAssets = prepareData?.fundingPlan?.selectedFundingAssets || fundingPlan?.selectedFundingAssets || [];
  const reviewSwapPlan = prepareData?.swapPlan || fundingPlan?.swapPlan || [];
  const fundingDiagnostics = fundingPlan || fundingIssue?.details || null;
  const positionLabel = pool?.token0?.symbol && pool?.token1?.symbol
    ? `${pool.token0.symbol} / ${pool.token1.symbol} · #${positionIdentifier}`
    : `Posición #${positionIdentifier}`;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Agregar liquidez con USD"
      >
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Agregar liquidez (smart)</span>
            <h2 className={styles.title}>{positionLabel}</h2>
            <p className={styles.desc}>
              Define cuántos USD agregar; el sistema arma los swaps necesarios desde tu wallet y aumenta la liquidez del LP.
            </p>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <div className={styles.stepper}>
          <StepPill label="1. Monto" active={step === 'amount'} done={['funding', 'review', 'signing', 'done'].includes(step)} />
          <StepPill label="2. Fondeo" active={step === 'funding'} done={['review', 'signing', 'done'].includes(step)} />
          <StepPill label="3. Review" active={step === 'review' || step === 'signing' || step === 'done'} done={['signing', 'done'].includes(step)} />
        </div>

        {isBusy && (
          <section className={styles.section}>
            <div className={styles.loading}>
              <div className={styles.spinner} />
              <p>{loadingMessage || 'Trabajando...'}</p>
            </div>
          </section>
        )}

        {!isBusy && step === 'amount' && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Paso 1: ¿Cuánto querés agregar?</span>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Monto en USD</span>
              <input
                type="number"
                min="1"
                value={totalUsdTarget}
                onChange={(event) => setTotalUsdTarget(event.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Slippage máximo (bps)</span>
              <input
                type="number"
                min="1"
                max="200"
                value={maxSlippageBps}
                onChange={(event) => setMaxSlippageBps(event.target.value)}
              />
            </label>

            <div className={styles.noticeCard}>
              <strong>El rango y los tokens ya están fijos por la posición.</strong>
              <p>El sistema calculará automáticamente el ratio óptimo de token0/token1 según el rango actual del LP, y armará los swaps que hagan falta.</p>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.buttonGroup}>
              <button type="button" className={styles.secondaryBtn} onClick={onClose}>
                Cancelar
              </button>
              <button type="button" className={styles.primaryBtn} onClick={handleContinueToFunding}>
                Continuar a fondeo →
              </button>
            </div>
          </section>
        )}

        {!isBusy && step === 'funding' && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Paso 2: Capital fuente y swaps</span>
            </div>

            <div className={styles.noticeCard}>
              <strong>Fondeo en {network}</strong>
              <p>Solo se usan activos disponibles en la red de la posición. Fondos en otras redes no se consideran automáticamente.</p>
            </div>

            {fundingDiagnostics?.gasReserve && (
              <div className={styles.noticeCard}>
                <strong>Reserva de gas</strong>
                <p>
                  Se reservarán {fundingDiagnostics.gasReserve.reservedAmount} {fundingDiagnostics.gasReserve.symbol} para comisiones.
                </p>
              </div>
            )}

            {fundingIssue && (
              <div className={styles.error}>
                <strong>{formatFundingIssueTitle(fundingIssue)}</strong>
                <div>{fundingIssue.message}</div>
                {fundingIssue.details?.missingUsd > 0 && (
                  <div>Falta estimada: {formatUsd(fundingIssue.details.missingUsd)}</div>
                )}
                {(fundingIssue.details?.warnings || []).length > 0 && (
                  <div style={{ marginTop: '8px' }}>
                    <div style={{ fontSize: '0.78rem', color: '#f5a623', marginBottom: '4px' }}>
                      Diagnóstico por activo:
                    </div>
                    <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.78rem', color: '#97a9bd' }}>
                      {fundingIssue.details.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className={styles.inlineActions}>
                  <button type="button" className={styles.secondaryBtn} onClick={() => setStep('amount')}>
                    Reducir monto
                  </button>
                  <button type="button" className={styles.secondaryBtn} onClick={() => refreshFundingPlan({ preserveSelections: true })}>
                    Reintentar
                  </button>
                </div>
              </div>
            )}

            <div className={styles.inlineActions}>
              <input
                type="text"
                placeholder="Importar token por dirección"
                value={importTokenAddress}
                onChange={(event) => setImportTokenAddress(event.target.value)}
              />
              <button type="button" className={styles.secondaryBtn} onClick={handleAddFundingImport}>
                Añadir token
              </button>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Slippage máximo (bps)</span>
              <input
                type="number"
                value={maxSlippageBps}
                min="1"
                max="200"
                onChange={(event) => {
                  setMaxSlippageBps(event.target.value);
                  setHasFundingEdits(true);
                }}
              />
            </label>

            <div className={styles.assetList}>
              {availableAssets.map((asset) => {
                const selection = assetSelections[asset.id] || { enabled: false, amount: '' };
                return (
                  <div key={asset.id} className={styles.assetRow}>
                    <label className={styles.assetCheckbox}>
                      <input
                        type="checkbox"
                        checked={selection.enabled}
                        onChange={(event) => {
                          setAssetSelections((prev) => ({
                            ...prev,
                            [asset.id]: {
                              enabled: event.target.checked,
                              amount: prev[asset.id]?.amount || asset.usableBalance || asset.balance,
                            },
                          }));
                          setHasFundingEdits(true);
                        }}
                      />
                      <span>{asset.symbol}</span>
                    </label>
                    <span className={styles.assetMeta}>Balance: {formatNumber(Number(asset.balance || 0), 6)}</span>
                    <span className={styles.assetMeta}>Usable: {formatNumber(Number(asset.usableBalance || asset.balance || 0), 6)}</span>
                    <input
                      type="number"
                      value={selection.amount || ''}
                      disabled={!selection.enabled}
                      onChange={(event) => {
                        setAssetSelections((prev) => ({
                          ...prev,
                          [asset.id]: {
                            enabled: prev[asset.id]?.enabled ?? true,
                            amount: event.target.value,
                          },
                        }));
                        setHasFundingEdits(true);
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {fundingPlan && (
              <>
                <div className={styles.summaryGrid}>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Pool estimado</span>
                    <strong className={styles.tileValue}>{formatUsd(fundingPlan.fundingPlan?.estimatedPoolValueUsd || 0)}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Directo</span>
                    <strong className={styles.tileValue}>{formatUsd(fundingPlan.fundingPlan?.directValueUsd || 0)}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Por swaps</span>
                    <strong className={styles.tileValue}>{formatUsd(fundingPlan.fundingPlan?.swapValueUsd || 0)}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Swaps</span>
                    <strong className={styles.tileValue}>{fundingPlan.swapPlan?.length || 0}</strong>
                  </div>
                </div>

                <div className={styles.txList}>
                  <h4>Swaps planeados</h4>
                  {(fundingPlan.swapPlan || []).length === 0 && (
                    <div className={styles.txItem}>
                      <span className={styles.txLabel}>No hacen falta swaps; tu wallet ya puede fondear el LP directamente.</span>
                    </div>
                  )}
                  {(fundingPlan.swapPlan || []).map((swap, index) => (
                    <div key={`${swap.sourceAssetId}-${index}`} className={styles.txItem}>
                      <span className={styles.txLabel}>
                        {swap.requiresWrapNative ? `Wrap ${swap.sourceSymbol} y ` : ''}
                        swap {swap.amountIn} {swap.tokenIn.symbol} → {swap.estimatedAmountOut} {swap.tokenOut.symbol} (fee {FEE_TIERS.find((tier) => tier.value === swap.fee)?.label || swap.fee})
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.buttonGroup}>
              <button type="button" className={styles.secondaryBtn} onClick={() => setStep('amount')}>
                ← Cambiar monto
              </button>
              <button type="button" className={styles.secondaryBtn} onClick={() => refreshFundingPlan({ preserveSelections: true })}>
                Recalcular plan
              </button>
              <button type="button" className={styles.primaryBtn} onClick={handlePrepareReview} disabled={!fundingPlan}>
                Revisar y preparar firma
              </button>
            </div>
          </section>
        )}

        {!isBusy && step === 'review' && prepareData && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Paso 3: Review y firma</span>
            </div>

            <div className={styles.summaryGrid}>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Red / versión</span>
                <strong className={styles.tileValue}>{network} · {String(version).toUpperCase()}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Wallet</span>
                <strong className={styles.tileValue}>{wallet?.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'No conectada'}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Posición</span>
                <strong className={styles.tileValue}>#{positionIdentifier}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Tokens objetivo</span>
                <strong className={styles.tileValue}>
                  {prepareData.quoteSummary?.amount0Desired} {prepareData.quoteSummary?.token0?.symbol}
                  {' + '}
                  {prepareData.quoteSummary?.amount1Desired} {prepareData.quoteSummary?.token1?.symbol}
                </strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Gas reservado</span>
                <strong className={styles.tileValue}>
                  {prepareData.fundingPlan?.gasReserve?.reservedAmount} {prepareData.fundingPlan?.gasReserve?.symbol}
                </strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Pool estimado</span>
                <strong className={styles.tileValue}>
                  {formatUsd(prepareData.fundingPlan?.estimatedPoolValueUsd || 0)}
                </strong>
              </div>
            </div>

            <div className={styles.txList}>
              <h4>Activos fuente seleccionados</h4>
              {reviewFundingAssets.map((asset) => (
                <div key={`${asset.assetId}-${asset.fundingRole}`} className={styles.txItem}>
                  <span className={styles.txLabel}>
                    {asset.useAmount} {asset.symbol} · {asset.fundingRole === 'swap_source' ? 'Swap source' : 'Aporte directo'}
                  </span>
                </div>
              ))}
            </div>

            <div className={styles.txList}>
              <h4>Transacciones a firmar ({prepareData.txPlan?.length || 0})</h4>
              {prepareData.txPlan?.map((tx, index) => (
                <div key={`${tx.kind}-${index}`} className={styles.txItem}>
                  <span className={styles.txLabel}>{tx.label || `Tx ${index + 1}`}</span>
                </div>
              ))}
            </div>

            {reviewSwapPlan?.length > 0 && (
              <div className={styles.txList}>
                <h4>Swaps</h4>
                {reviewSwapPlan.map((swap, index) => (
                  <div key={`${swap.sourceAssetId}-${index}`} className={styles.txItem}>
                    <span className={styles.txLabel}>
                      {swap.amountIn} {swap.tokenIn.symbol} → min {swap.amountOutMinimum} {swap.tokenOut.symbol}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {(prepareData.warnings || []).length > 0 && (
              <div className={styles.noticeCard}>
                <strong>Advertencias</strong>
                {(prepareData.warnings || []).map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.buttonGroup}>
              <button type="button" className={styles.secondaryBtn} onClick={() => setStep('funding')}>
                ← Volver a fondeo
              </button>
              <button type="button" className={styles.primaryBtn} onClick={handleExecute}>
                Firmar con wallet
              </button>
            </div>
          </section>
        )}

        {step === 'signing' && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>
                Transacción {Math.min(currentTxIndex + 1, prepareData?.txPlan?.length || 0)} de {prepareData?.txPlan?.length || 0}
              </span>
            </div>
            <div className={styles.txProgressList}>
              {(prepareData?.txPlan || []).map((tx, index) => {
                const label = tx?.label || `Transacción ${index + 1}`;
                const isDone = index <= completedTxIndex;
                const isActive = index === currentTxIndex && !isDone;
                const hash = txHashes[index] || null;
                const txLink = hash && explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
                return (
                  <div
                    key={`${tx?.kind}-${index}`}
                    className={`${styles.txStepItem} ${isDone ? styles.txStepDone : ''} ${isActive ? styles.txStepActive : ''} ${!isDone && !isActive ? styles.txStepPending : ''}`}
                  >
                    <span className={styles.txStepIcon}>
                      {isDone ? '✓' : isActive ? '' : '○'}
                    </span>
                    <span className={styles.txStepLabel}>{label}</span>
                    {isDone && hash && (
                      <span className={styles.txStepHash}>
                        {txLink
                          ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 10)}…</a>
                          : <span>{hash.slice(0, 10)}…</span>
                        }
                      </span>
                    )}
                    {isActive && <span className={styles.txStepSpinner} />}
                  </div>
                );
              })}
            </div>
            <div className={styles.loading}>
              <p>{loadingMessage || 'Firma cada transacción en tu wallet...'}</p>
            </div>
          </section>
        )}

        {step === 'done' && (
          <section className={styles.section}>
            <div className={styles.success}>
              <div className={styles.checkmark}>✓</div>
              <p>Liquidez agregada correctamente al LP.</p>
            </div>
            {txHashes.length > 0 && (
              <div className={styles.txList}>
                <h4>Transacciones confirmadas ({txHashes.length})</h4>
                {txHashes.map((hash, index) => {
                  const label = prepareData?.txPlan?.[index]?.label || `Transacción ${index + 1}`;
                  const txLink = explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
                  return (
                    <div key={hash} className={styles.txItem}>
                      <span className={styles.txLabel}>
                        {label}
                        {' — '}
                        {txLink
                          ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 14)}…{hash.slice(-6)}</a>
                          : <span className={styles.hint}>{hash.slice(0, 14)}…{hash.slice(-6)}</span>
                        }
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={styles.buttonGroup}>
              <button type="button" className={styles.primaryBtn} onClick={onClose}>
                Cerrar
              </button>
            </div>
          </section>
        )}

        {step === 'error' && (
          <section className={styles.section}>
            <div className={styles.errorBox}>
              <p>{error || 'Ocurrió un error agregando liquidez.'}</p>
              {failedTxLabel && <p>Tx con problema: {failedTxLabel}</p>}
              {completedTxIndex >= 0 && txHashes.length > 0 && (
                <div className={styles.txList}>
                  <h4>Transacciones completadas exitosamente</h4>
                  {txHashes.map((hash, index) => {
                    const label = prepareData?.txPlan?.[index]?.label || `Transacción ${index + 1}`;
                    const txLink = explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
                    return (
                      <div key={hash} className={styles.txItem}>
                        <span className={styles.txLabel}>
                          {label}
                          {' — '}
                          {txLink
                            ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 10)}…</a>
                            : <span>{hash.slice(0, 10)}…</span>
                          }
                        </span>
                      </div>
                    );
                  })}
                  <p className={styles.hint}>
                    El aumento quedó parcialmente ejecutado on-chain. Revisa estas transacciones y prepara un plan nuevo antes de volver a firmar.
                  </p>
                </div>
              )}
            </div>
            <div className={styles.buttonGroup}>
              <button type="button" className={styles.secondaryBtn} onClick={onClose}>
                Cerrar
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
