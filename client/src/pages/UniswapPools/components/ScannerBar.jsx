import { formatRelativeTimestamp } from '../utils/pool-formatters';
import styles from './ScannerBar.module.css';

export default function ScannerBar({
  wallet, setWallet,
  network, setNetwork,
  version, setVersion,
  meta, selectedNetwork, hasApiKey, accounts,
  isScanning, protectedSummary, protectedRefreshedAt,
  availableVersions,
  onSubmit,
}) {
  return (
    <section className={styles.bar}>
      <form className={styles.form} onSubmit={onSubmit}>
        <input
          className={styles.walletInput}
          type="text"
          placeholder="0x... wallet address"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          required
          aria-label="Direccion de wallet"
        />
        <select className={styles.select} value={network} onChange={(e) => setNetwork(e.target.value)}>
          {(meta?.networks || []).map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        <select className={styles.select} value={version} onChange={(e) => setVersion(e.target.value)}>
          {availableVersions.map((item) => (
            <option key={item} value={item}>{item.toUpperCase()}</option>
          ))}
        </select>
        <button className={styles.scanBtn} type="submit" disabled={isScanning || !meta || !hasApiKey}>
          {isScanning ? 'Escaneando...' : 'Escanear'}
        </button>
      </form>

      <div className={styles.stats}>
        <span className={styles.stat}>
          <strong>{protectedSummary.active}</strong> Activas
        </span>
        {protectedSummary.outside > 0 && (
          <span className={`${styles.stat} ${styles.statAlert}`}>
            <strong>{protectedSummary.outside}</strong> Fuera de rango
          </span>
        )}
        <span className={styles.statMuted}>
          {formatRelativeTimestamp(protectedRefreshedAt)}
        </span>
      </div>

      <div className={styles.status}>
        <span className={hasApiKey ? styles.statusOk : styles.statusWarn}>
          Etherscan: {hasApiKey ? 'OK' : 'Pendiente'}
        </span>
        <span className={styles.dot}>·</span>
        <span className={accounts.length ? styles.statusOk : styles.statusWarn}>
          HL: {accounts.length ? `${accounts.length} cuenta${accounts.length > 1 ? 's' : ''}` : 'Sin cuentas'}
        </span>
        <span className={styles.dot}>·</span>
        <span className={styles.statusNeutral}>
          {selectedNetwork?.label || network} · {version.toUpperCase()}
        </span>
      </div>
    </section>
  );
}
