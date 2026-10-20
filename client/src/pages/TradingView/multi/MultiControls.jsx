// Controles compartidos por los dos modos de la pantalla multi
// (Multi‑TF y Multi‑activo).
import { SYNC_COLORS } from './crosshairSync';
import styles from './MultiTimeframePage.module.css';

export const TOUCH_HINT = 'Mantén pulsado y arrastra sobre un gráfico';

const MODES = [
  { id: 'tf', label: 'Multi‑TF', title: 'Un activo en varias temporalidades' },
  { id: 'assets', label: 'Multi‑activo', title: 'Varios activos en pantalla dividida' },
];

export function Legend({ className }) {
  return (
    <span className={`${styles.legend} ${className || ''}`}>
      <span className={styles.legendItem}>
        <span className={styles.legendLine} style={{ borderTopStyle: 'solid', borderTopColor: SYNC_COLORS.exact }} />
        Misma apertura
      </span>
      <span className={styles.legendItem}>
        <span className={styles.legendLine} style={{ borderTopStyle: 'dashed', borderTopColor: SYNC_COLORS.near }} />
        Dentro de la vela
      </span>
    </span>
  );
}

export function SyncSwitch({ checked, onToggle, label, className }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Puntero sincronizado"
      className={`${styles.syncBtn} ${checked ? styles.syncBtnOn : ''} ${className || ''}`}
      onClick={onToggle}
    >
      <span className={styles.syncKnob} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

// Selector segmentado de modo. En móvil ocupa una fila propia bajo la
// cabecera, a todo el ancho y con botones de 44 px.
export function ModeSwitch({ mode, onChange, mobile = false }) {
  return (
    <div
      className={mobile ? styles.mModeGroup : styles.modeGroup}
      role="group"
      aria-label="Modo de la pantalla"
    >
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          title={m.title}
          className={`${mobile ? styles.mModeBtn : styles.modeBtn} ${m.id === mode ? styles.modeBtnActive : ''}`}
          aria-pressed={m.id === mode}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
