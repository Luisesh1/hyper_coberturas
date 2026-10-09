import { TOOLS } from '../drawings/catalog';
import { DRAWING_TOOL_ICONS, TrashIcon, UndoIcon } from './icons';
import styles from './MobileChrome.module.css';

const TOOL_ORDER = ['select', 'trendline', 'horizontal', 'rectangle', 'fib', 'ruler'];

const HINTS = {
  select: 'Toca un dibujo para seleccionarlo.',
  trendline: 'Arrastra con el dedo de un punto a otro.',
  horizontal: 'Toca el precio donde quieres la línea.',
  rectangle: 'Arrastra de una esquina a la opuesta.',
  fib: 'Arrastra del mínimo al máximo (o al revés).',
  ruler: 'Toca el punto inicial y luego el final.',
};

// Modo dibujo (móvil), parte superior: banner sobre el gráfico con la pista
// de la herramienta, Deshacer y Listo.
export function MobileDrawingBanner({ activeTool, canUndo, onUndo, onDone }) {
  const title = activeTool ? (TOOLS[activeTool]?.label || activeTool) : 'Modo dibujo';
  const hint = activeTool ? HINTS[activeTool] : 'Elige una herramienta abajo. Sin herramienta puedes mover el gráfico.';
  return (
    <div className={styles.drawBanner}>
      <div className={styles.drawBannerText} role="status">
        <span className={styles.drawBannerTitle}>{title}</span>
        <span className={styles.drawHint}>{hint}</span>
      </div>
      <button type="button" className={styles.iconBtn} aria-label="Deshacer" onClick={onUndo} disabled={!canUndo}>
        <UndoIcon size={20} />
      </button>
      <button type="button" className={styles.doneBtn} onClick={onDone}>Listo</button>
    </div>
  );
}

// Modo dibujo (móvil), parte inferior: reemplaza la barra de pestañas con la
// misma altura, así un toque sobre el gráfico no se confunde con desplazarlo
// y el gráfico no cambia de tamaño al entrar o salir.
export default function MobileDrawingBar({ activeTool, onSelectTool, selectedUid, onDeleteSelected }) {
  return (
    <div className={styles.drawBar} role="toolbar" aria-label="Herramientas de dibujo">
      {TOOL_ORDER.map((id) => {
        const Icon = DRAWING_TOOL_ICONS[id];
        const isActive = activeTool === id;
        return (
          <button
            key={id}
            type="button"
            className={`${styles.iconBtn} ${isActive ? styles.iconBtnActive : ''}`}
            aria-label={TOOLS[id]?.label || id}
            aria-pressed={isActive}
            onClick={() => onSelectTool(isActive ? null : id)}
          >
            <Icon size={20} />
          </button>
        );
      })}
      <span className={styles.drawDivider} aria-hidden="true" />
      <button
        type="button"
        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
        aria-label="Borrar dibujo seleccionado"
        onClick={onDeleteSelected}
        disabled={!selectedUid}
      >
        <TrashIcon size={20} />
      </button>
    </div>
  );
}
