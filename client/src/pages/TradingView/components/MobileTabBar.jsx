import { IndicatorsIcon, PencilIcon, ReplayIcon, SlidersIcon } from './icons';
import styles from './MobileChrome.module.css';

// Barra de pestañas inferior (móvil): cuatro destinos en la zona del pulgar.
export default function MobileTabBar({
  indicatorsCount,
  replayActive,
  replayOpen,
  onIndicators,
  onDraw,
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
