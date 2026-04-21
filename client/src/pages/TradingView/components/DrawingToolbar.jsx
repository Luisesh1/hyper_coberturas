import { TOOLS } from '../drawings/catalog';
import styles from './DrawingToolbar.module.css';

const TOOL_ORDER = ['select', 'ruler', 'trendline', 'horizontal', 'rectangle', 'fib'];

function ToolIcon({ toolId }) {
  switch (toolId) {
    case 'select':     return <span className={styles.iconSelect}>↖</span>;
    case 'ruler':      return <span className={styles.iconRuler}>📏</span>;
    case 'trendline':  return <span className={styles.iconLine} />;
    case 'horizontal': return <span className={styles.iconHLine} />;
    case 'rectangle':  return <span className={styles.iconRect} />;
    case 'fib':        return <span className={styles.iconFib}>φ</span>;
    default:           return <span>{TOOLS[toolId]?.icon || '?'}</span>;
  }
}

export default function DrawingToolbar({
  activeTool,
  onSelectTool,
  onClear,
  selectedUid,
  onDeleteSelected,
  hasDrawings,
}) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Herramientas de dibujo">
      {TOOL_ORDER.map((id) => {
        const meta = TOOLS[id];
        if (!meta) return null;
        const isActive = activeTool === id;
        return (
          <button
            key={id}
            type="button"
            className={`${styles.tool} ${isActive ? styles.toolActive : ''}`}
            title={meta.label}
            onClick={() => onSelectTool?.(isActive ? null : id)}
            aria-pressed={isActive}
          >
            <ToolIcon toolId={id} />
          </button>
        );
      })}

      {(selectedUid || hasDrawings) && <div className={styles.separator} />}

      {selectedUid && (
        <button
          type="button"
          className={styles.tool}
          title="Eliminar seleccionado (Delete)"
          onClick={onDeleteSelected}
        >
          <span className={styles.iconTrash}>🗑️</span>
        </button>
      )}

      {hasDrawings && (
        <button
          type="button"
          className={styles.tool}
          title="Limpiar todos los dibujos"
          onClick={onClear}
        >
          <span className={styles.iconTrash}>✕</span>
        </button>
      )}
    </div>
  );
}
