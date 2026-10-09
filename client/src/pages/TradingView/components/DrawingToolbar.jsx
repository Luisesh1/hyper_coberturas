import { useEffect, useState } from 'react';
import { TOOLS } from '../drawings/catalog';
import styles from './DrawingToolbar.module.css';
import { CloseIcon, DRAWING_TOOL_ICONS, PencilIcon, TrashIcon } from './icons';

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
  const Icon = DRAWING_TOOL_ICONS[toolId];
  return Icon ? <Icon size={18} /> : <span>{TOOLS[toolId]?.icon || '?'}</span>;
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
          <PencilIcon size={18} />
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
        <CloseIcon size={18} />
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
            aria-label={meta.label}
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
          aria-label="Eliminar seleccionado"
          onClick={onDeleteSelected}
        >
          <TrashIcon size={18} />
        </button>
      )}

      {hasDrawings && (
        <button
          type="button"
          className={styles.tool}
          title="Limpiar todos los dibujos"
          aria-label="Limpiar todos los dibujos"
          onClick={onClear}
        >
          <CloseIcon size={18} />
        </button>
      )}
    </div>
  );
}
