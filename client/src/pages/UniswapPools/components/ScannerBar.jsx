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
  const scanDisabled = isScanning || !meta || !hasApiKey;

  return (
    <section className={styles.bar}>
      <form className={styles.form} onSubmit={onSubmit}>
        <div className={styles.walletInputWrap}>
          <span className={styles.walletIcon}>⬡</span>
          <input
            className={styles.walletInput}
            type="text"
            placeholder="Dirección de wallet (0x...)"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            required
            aria-label="Dirección de wallet a escanear"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <select
          className={styles.select}
          value={network}
          onChange={(e) => setNetwork(e.target.value)}
          aria-label="Red blockchain"
          title="Selecciona la red blockchain a escanear"
        >
          {(meta?.networks || []).map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>

        <select
          className={styles.select}
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          aria-label="Versión del protocolo"
          title="Selecciona la versión del protocolo Uniswap"
        >
          {availableVersions.map((item) => (
            <option key={item} value={item}>{item.toUpperCase()}</option>
          ))}
        </select>

        <button
          className={styles.scanBtn}
          type="submit"
          disabled={scanDisabled}
          title={
            !hasApiKey ? 'Configura tu API key de Etherscan en Configuración primero'
              : !meta ? 'Cargando configuración...'
                : 'Buscar posiciones LP en esta wallet'
          }
        >
          {isScanning
            ? <><span className={styles.spinner} /> Escaneando...</>
            : '🔍 Escanear wallet'}
        </button>
      </form>

      {/* Estadísticas de pools protegidos */}
      <div className={styles.statsRow}>
        <div className={styles.stats}>
          <span className={styles.stat} title="Protecciones activas en este momento">
            <strong>{protectedSummary.active}</strong>
            {' '}protección{protectedSummary.active !== 1 ? 'es' : ''} activa{protectedSummary.active !== 1 ? 's' : ''}
          </span>
          {protectedSummary.outside > 0 && (
            <span className={`${styles.stat} ${styles.statAlert}`} title="Pools con el precio fuera del rango de liquidez">
              ⚠ <strong>{protectedSummary.outside}</strong> fuera de rango
            </span>
          )}
          {protectedSummary.active > 0 && protectedRefreshedAt && (
            <span className={styles.statMuted} title="Última actualización de datos">
              Actualizado {formatRelativeTimestamp(protectedRefreshedAt)}
            </span>
          )}
        </div>

        {/* Indicadores de estado del sistema */}
        <div className={styles.status}>
          <span
            className={hasApiKey ? styles.statusOk : styles.statusWarn}
            title={hasApiKey ? 'Etherscan API key configurada correctamente' : 'Falta configurar la API key de Etherscan'}
          >
            {hasApiKey ? '✓' : '!'} Etherscan
          </span>
          <span className={styles.dot}>·</span>
          <span
            className={accounts.length ? styles.statusOk : styles.statusWarn}
            title={accounts.length ? `${accounts.length} cuenta${accounts.length > 1 ? 's' : ''} de Hyperliquid configurada${accounts.length > 1 ? 's' : ''}` : 'Sin cuentas de Hyperliquid configuradas'}
          >
            {accounts.length ? `✓ ${accounts.length} cuenta${accounts.length > 1 ? 's' : ''} HL` : '! Sin cuentas HL'}
          </span>
          <span className={styles.dot}>·</span>
          <span className={styles.statusNeutral} title="Red y versión de protocolo seleccionadas">
            {selectedNetwork?.label || network} · {version.toUpperCase()}
          </span>
        </div>
      </div>
    </section>
  );
}
