import { UNTRADED_COLOR } from './useChartOverlays';
import styles from './OverlayLegend.module.css';

const DRAWN = (s) => s !== 'hidden' && s !== 'isMain';

// Color de la muestra "Prima negociada": la opción enfocada si está dibujada;
// si no, la primera opción dibujada. null si no hay ninguna (sin leyenda).
export function optionLegendColor(items = [], status = {}, focusedId = null) {
  const drawn = items.filter((o) => o.kind === 'option' && DRAWN(status[o.id]));
  if (!drawn.length) return null;
  return (drawn.find((o) => o.id === focusedId) ?? drawn[0]).color;
}

// Leyenda de las líneas de prima: continua (negociada) y discontinua gris
// (sin operaciones, último precio arrastrado). Escritorio: fila al pie del
// gráfico. Móvil (`compact`): una línea dentro de la barra de lectura.
export default function OverlayLegend({ color, compact = false }) {
  if (!color) return null;
  return (
    <div className={`${styles.legend} ${compact ? styles.compact : ''}`} aria-label="Leyenda de la prima">
      <span className={styles.item}>
        <span className={styles.solid} style={{ background: color }} aria-hidden="true" />
        Prima negociada
      </span>
      <span className={styles.item}>
        <span className={styles.dashed} style={{ borderTopColor: UNTRADED_COLOR }} aria-hidden="true" />
        {compact ? 'Sin operaciones (precio arrastrado)' : 'Sin operaciones (último precio arrastrado)'}
      </span>
    </div>
  );
}
