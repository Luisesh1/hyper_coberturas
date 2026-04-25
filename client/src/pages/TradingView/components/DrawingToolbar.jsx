import { useEffect, useState } from 'react';
import { TOOLS } from '../drawings/catalog';
import styles from './DrawingToolbar.module.css';

const TOOL_ORDER = ['select', 'ruler', 'trendline', 'horizontal', 'rectangle', 'fib'];
// v2: cambia el default a "colapsado" en todos los viewports, así la barra
// no obstruye el chart hasta que el usuario la despliega.
const EXPANDED_STORAGE_KEY = 'tv_drawing_toolbar_expanded_v2';

function loadStoredExpanded() {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return false;
  } catch {
    return false;
  }
}

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
  const [expanded, setExpanded] = useState(loadStoredExpanded);

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? '1' : '0'); } catch { /* noop */ }
  }, [expanded]);

  if (!expanded) {
    return (
      <div className={styles.toolbarCollapsed} role="toolbar" aria-label="Herramientas de dibujo (colapsadas)">
        <button
          type="button"
          className={`${styles.tool} ${styles.toggleBtn}`}
          title="Mostrar herramientas de dibujo"
          aria-label="Mostrar herramientas de dibujo"
          aria-expanded="false"
          onClick={() => setExpanded(true)}
        >
          <span className={styles.iconExpand}>✏️</span>
          {activeTool && <span className={styles.activeDot} aria-hidden="true" />}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Herramientas de dibujo">
      <button
        type="button"
        className={`${styles.tool} ${styles.toggleBtn} ${styles.toggleBtnClose}`}
        title="Ocultar herramientas"
        aria-label="Ocultar herramientas"
        aria-expanded="true"
        onClick={() => setExpanded(false)}
      >
        <span className={styles.iconCollapse}>✕</span>
      </button>
      <div className={styles.separator} />

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
