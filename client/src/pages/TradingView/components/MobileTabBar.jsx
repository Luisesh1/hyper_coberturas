import { BellIcon, IndicatorsIcon, OverlayIcon, PencilIcon, ReplayIcon, SlidersIcon } from './icons';
import styles from './MobileChrome.module.css';

// Barra de pestañas inferior (móvil): seis destinos en la zona del pulgar.
// A 360 px cada pestaña mide ~56 px de ancho (zona táctil ≥ 44 px).
export default function MobileTabBar({
  indicatorsCount,
  overlaysCount = 0,
  alertsCount = 0,
  replayActive,
  replayOpen,
  onIndicators,
  onDraw,
  onOverlays,
  onAlerts,
  onReplay,
  onSettings,
}) {
  return (
    <nav className={styles.tabBar} aria-label="Herramientas del gráfico">
      <button type="button" className={styles.tab} onClick={onIndicators}>
        <IndicatorsIcon size={22} />
        <span className={styles.tabLabel}>Indicadores</span>
        {indicatorsCount > 0 && <span className={styles.tabBadge}>{indicatorsCount}</span>}
      </button>
      <button type="button" className={styles.tab} onClick={onDraw}>
        <PencilIcon size={22} />
        <span className={styles.tabLabel}>Dibujar</span>
      </button>
      <button
        type="button"
        className={styles.tab}
        onClick={onOverlays}
        aria-haspopup="dialog"
        aria-label={overlaysCount > 0 ? `Superponer, ${overlaysCount} superposiciones` : 'Superponer'}
      >
        <OverlayIcon size={22} />
        <span className={styles.tabLabel}>Superponer</span>
        {overlaysCount > 0 && <span className={styles.tabBadge} aria-hidden="true">{overlaysCount}</span>}
      </button>
      <button
        type="button"
        className={styles.tab}
        onClick={onAlerts}
        aria-haspopup="dialog"
        aria-label={alertsCount > 0 ? `Alertas, ${alertsCount} en el gráfico` : 'Alertas'}
      >
        <BellIcon size={22} />
        <span className={styles.tabLabel}>Alertas</span>
        {alertsCount > 0 && <span className={styles.tabBadge} aria-hidden="true">{alertsCount}</span>}
      </button>
      <button
        type="button"
        className={`${styles.tab} ${replayOpen ? styles.tabActive : ''}`}
        onClick={onReplay}
        aria-pressed={replayOpen}
        aria-label={replayActive ? 'Replay (activo)' : 'Replay'}
      >
        <ReplayIcon size={22} />
        <span className={styles.tabLabel}>Replay</span>
        {replayActive && <span className={styles.tabDot} aria-hidden="true" />}
      </button>
      <button type="button" className={styles.tab} onClick={onSettings}>
        <SlidersIcon size={22} />
        <span className={styles.tabLabel}>Ajustes</span>
      </button>
    </nav>
  );
}
