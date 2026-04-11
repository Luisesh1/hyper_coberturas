import { formatNumber } from '../../../../utils/formatters';
import { formatUsd } from '../../utils/pool-formatters';
import { formatFundingIssueTitle } from './helpers';
import { FEE_TIERS, STEP } from './constants';
import styles from '../SmartCreatePoolModal.module.css';

/**
 * Paso 3: Capital fuente, selección de activos y plan de swaps.
 */
export default function StepFunding({
  selectedNetwork,
  network,
  totalUsdTarget,
  fundingDiagnostics,
  fundingIssue,
  fundingPlan,
  availableAssets,
  assetSelections,
  setAssetSelections,
  setHasFundingEdits,
  importTokenAddress,
  setImportTokenAddress,
  handleAddFundingImport,
  maxSlippageBps,
  setMaxSlippageBps,
  error,
  isBusy,
  setStep,
  onClose,
  refreshFundingPlan,
  handleApplyRecommended,
  handlePrepareReview,
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.kicker}>Paso 3: Capital fuente y swaps</span>
      </div>

      <div className={styles.noticeCard}>
        <strong>Fondeo en {selectedNetwork?.label || network}</strong>
        <p>Solo se usan activos disponibles en la red seleccionada. Fondos en otras redes no se consideran automáticamente.</p>
      </div>

      {fundingDiagnostics?.gasReserve && (
        <div className={styles.noticeCard}>
          <strong>Reserva de gas</strong>
          <p>
            Se reservarán {fundingDiagnostics.gasReserve.reservedAmount} {fundingDiagnostics.gasReserve.symbol} para comisiones.
          </p>
        </div>
      )}

      {fundingDiagnostics && (
        <div className={styles.summaryGrid}>
          <div className={styles.summaryTile}>
            <span className={styles.tileLabel}>Red de fondeo</span>
            <strong className={styles.tileValue}>{selectedNetwork?.label || network}</strong>
          </div>
          <div className={styles.summaryTile}>
            <span className={styles.tileLabel}>Balance nativo</span>
            <strong className={styles.tileValue}>
              {formatNumber(Number(fundingDiagnostics?.gasReserve?.nativeBalance || fundingDiagnostics?.nativeBalance?.balance || 0), 6)} {fundingDiagnostics?.gasReserve?.symbol || fundingDiagnostics?.nativeBalance?.symbol || ''}
            </strong>
          </div>
          <div className={styles.summaryTile}>
            <span className={styles.tileLabel}>Total disponible</span>
            <strong className={styles.tileValue}>
              {formatUsd(Number(fundingDiagnostics?.usableFundingUsd || 0))}
            </strong>
            <span style={{ color: '#97a9bd', fontSize: '0.72rem' }}>
              {(fundingDiagnostics?.availableFundingAssets || []).length} activos ·{' '}
              {formatNumber(Number(fundingDiagnostics?.gasReserve?.usableNative || fundingDiagnostics?.usableNative?.balance || 0), 6)} {fundingDiagnostics?.gasReserve?.symbol || ''} nativo
            </span>
          </div>
          <div className={styles.summaryTile}>
            <span className={styles.tileLabel}>Objetivo / desplegable</span>
            <strong className={styles.tileValue}>
              {formatUsd(Number(fundingDiagnostics?.totalUsdTarget || Number(totalUsdTarget || 0)))} / {formatUsd(Number(fundingDiagnostics?.fundingPlan?.estimatedPoolValueUsd || fundingDiagnostics?.deployableUsd || 0))}
            </strong>
          </div>
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
            <button type="button" className={styles.secondaryBtn} onClick={onClose}>
              Cambiar red en la página
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={() => setStep(STEP.POOL)}>
              Reducir monto objetivo
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

          {(() => {
            const currentSwaps = fundingPlan.swapPlan?.length || 0;
            const recSwaps = fundingPlan.recommendedSwapCount;
            const recSelection = fundingPlan.recommendedFundingSelection || [];
            if (recSwaps == null || recSelection.length === 0) return null;
            if (recSwaps >= currentSwaps) return null;

            const recSymbols = recSelection
              .map((item) => (availableAssets || []).find((a) => a.id === item.assetId)?.symbol)
              .filter(Boolean)
              .join(', ');
            return (
              <div className={styles.recommendationBanner}>
                <div>
                  <strong>Configuración óptima detectada:</strong>{' '}
                  usar {recSymbols} reduce de {currentSwaps} a {recSwaps} swap{recSwaps === 1 ? '' : 's'}
                  {' '}(menos firmas, menos gas).
                </div>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={handleApplyRecommended}
                  disabled={isBusy}
                >
                  Aplicar recomendación
                </button>
              </div>
            );
          })()}

          <div className={styles.txList}>
            <h4>Swaps planeados</h4>
            {(fundingPlan.swapPlan || []).length === 0 && (
              <div className={styles.txItem}>
                <span className={styles.txLabel}>No hacen falta swaps; la wallet ya puede fondear el LP directamente.</span>
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
        <button type="button" className={styles.secondaryBtn} onClick={() => setStep(STEP.RANGE)}>
          ← Ajustar rango
        </button>
        <button type="button" className={styles.secondaryBtn} onClick={() => refreshFundingPlan({ preserveSelections: true })}>
          Recalcular plan
        </button>
        <button type="button" className={styles.primaryBtn} onClick={handlePrepareReview} disabled={!fundingPlan}>
          Revisar y preparar firma
        </button>
      </div>
    </section>
  );
}
