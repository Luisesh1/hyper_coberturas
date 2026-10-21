import { IndicatorsIcon, OverlayIcon, PencilIcon, ReplayIcon, SlidersIcon } from './icons';
import styles from './MobileChrome.module.css';

// Barra de pestañas inferior (móvil): cinco destinos en la zona del pulgar.
export default function MobileTabBar({
  indicatorsCount,
  overlaysCount = 0,
  replayActive,
  replayOpen,
  onIndicators,
  onDraw,
  onOverlays,
  onReplay,
  onSettings,
}) {
  return (
    <nav className={styles.tabBar} aria-label="Herramientas del gráfico">
      <button type="button" className={styles.tab} onClick={onIndicators}>
        <IndicatorsIcon size={22} />
        Indicadores
        {indicatorsCount > 0 && <span className={styles.tabBadge}>{indicatorsCount}</span>}
      </button>
      <button type="button" className={styles.tab} onClick={onDraw}>
        <PencilIcon size={22} />
        Dibujar
      </button>
      <button
        type="button"
        className={styles.tab}
        onClick={onOverlays}
        aria-haspopup="dialog"
        aria-label={overlaysCount > 0 ? `Superponer, ${overlaysCount} superposiciones` : 'Superponer'}
      >
        <OverlayIcon size={22} />
        Superponer
        {overlaysCount > 0 && <span className={styles.tabBadge} aria-hidden="true">{overlaysCount}</span>}
      </button>
      <button
        type="button"
        className={`${styles.tab} ${replayOpen ? styles.tabActive : ''}`}
        onClick={onReplay}
        aria-pressed={replayOpen}
        aria-label={replayActive ? 'Replay (activo)' : 'Replay'}
      >
        <ReplayIcon size={22} />
        Replay
        {replayActive && <span className={styles.tabDot} aria-hidden="true" />}
      </button>
      <button type="button" className={styles.tab} onClick={onSettings}>
        <SlidersIcon size={22} />
        Ajustes
      </button>
    </nav>
  );
}
