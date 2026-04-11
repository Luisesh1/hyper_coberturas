import { FEE_TIERS } from './constants';
import styles from '../SmartCreatePoolModal.module.css';

/**
 * Paso 1: Selección del pool (red, fee, tokens, monto objetivo).
 */
export default function StepPoolSelection({
  wallet,
  selectedNetwork,
  network,
  version,
  fee,
  setFee,
  totalUsdTarget,
  setTotalUsdTarget,
  token0Address,
  setToken0Address,
  token1Address,
  setToken1Address,
  customToken0,
  setCustomToken0,
  customToken1,
  setCustomToken1,
  tokenOptions,
  error,
  handleAnalyzePool,
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.kicker}>Paso 1: Selección del pool</span>
      </div>

      <div className={styles.summaryGrid}>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Red activa</span>
          <strong className={styles.tileValue}>{selectedNetwork?.label || network}</strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Versión activa</span>
          <strong className={styles.tileValue}>{String(version).toUpperCase()}</strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.tileLabel}>Wallet conectada</span>
          <strong className={styles.tileValue}>{wallet?.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'No conectada'}</strong>
        </div>
      </div>

      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Fee</span>
          <div className={styles.buttonGroup}>
            {FEE_TIERS.map((tier) => (
              <button
                key={tier.value}
                type="button"
                className={`${styles.tierBtn} ${fee === tier.value ? styles.tierBtnSelected : ''}`}
                onClick={() => setFee(tier.value)}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Valor total objetivo (USD)</span>
          <input
            type="number"
            value={totalUsdTarget}
            onChange={(event) => setTotalUsdTarget(event.target.value)}
            min="1"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Token 0</span>
          <select className={styles.select} value={token0Address} onChange={(event) => setToken0Address(event.target.value)}>
            <option value="">— Selecciona token —</option>
            {tokenOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="O pega dirección custom"
            value={customToken0}
            onChange={(event) => setCustomToken0(event.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Token 1</span>
          <select className={styles.select} value={token1Address} onChange={(event) => setToken1Address(event.target.value)}>
            <option value="">— Selecciona token —</option>
            {tokenOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="O pega dirección custom"
            value={customToken1}
            onChange={(event) => setCustomToken1(event.target.value)}
          />
        </label>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <button type="button" className={styles.primaryBtn} onClick={handleAnalyzePool}>
        Analizar pool y rango
      </button>
    </section>
  );
}
