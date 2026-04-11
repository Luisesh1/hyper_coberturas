import { formatCompactPrice } from '../../utils/pool-formatters';
import { FEE_TIERS, STEP } from './constants';
import styles from '../SmartCreatePoolModal.module.css';

/**
 * Paso 4: Review y firma (resumen final antes de ejecutar).
 */
export default function StepReview({
  wallet,
  selectedNetwork,
  network,
  version,
  fee,
  activeRange,
  prepareData,
  reviewFundingAssets,
  reviewSwapPlan,
  error,
  setStep,
  handleExecute,
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.kicker}>Paso 4: Review y firma</span>
      </div>

      <div className={styles.summaryGrid}>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Red / versión</span>
          <strong className={styles.tileValue}>{selectedNetwork?.label || network} · {String(version).toUpperCase()}</strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Wallet</span>
          <strong className={styles.tileValue}>{wallet?.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'No conectada'}</strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Pool</span>
          <strong className={styles.tileValue}>{prepareData.quoteSummary?.token0?.symbol} / {prepareData.quoteSummary?.token1?.symbol}</strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Fee</span>
          <strong className={styles.tileValue}>{FEE_TIERS.find((item) => item.value === fee)?.label}</strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Rango</span>
          <strong className={styles.tileValue}>
            ${formatCompactPrice(activeRange?.rangeLowerPrice)} — ${formatCompactPrice(activeRange?.rangeUpperPrice)}
          </strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Gas reservado</span>
          <strong className={styles.tileValue}>
            {prepareData.fundingPlan?.gasReserve?.reservedAmount} {prepareData.fundingPlan?.gasReserve?.symbol}
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
        <button type="button" className={styles.secondaryBtn} onClick={() => setStep(STEP.FUNDING)}>
          ← Volver a fondeo
        </button>
        <button type="button" className={styles.primaryBtn} onClick={handleExecute}>
          Firmar con wallet
        </button>
      </div>
    </section>
  );
}
