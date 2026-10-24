import { SIGNAL_FILTER_OPTIONS } from './botView';
import SignalsTimeline from './visual/SignalsTimeline';
import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';

const EMPTY_TEXT = {
  all: 'Todavía no ha llegado ninguna señal de sus alertas.',
  traded: 'Ninguna señal ha abierto o cerrado posiciones todavía.',
  ignored: 'No hay señales ignoradas.',
};

export function SignalFilter({ value, onChange }) {
  return (
    <div role="group" aria-label="Filtrar señales" className={styles.filters}>
      {SIGNAL_FILTER_OPTIONS.map((f) => (
        <button
          key={f.key}
          type="button"
          className={`${styles.filterBtn} ${value === f.key ? styles.filterBtnOn : ''}`}
          aria-pressed={value === f.key}
          onClick={() => onChange(f.key)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// Registro «Señales recibidas y decisiones»: cronología; en el teléfono la
// variante compacta (sin la línea de alerta y puntaje).
export default function SignalsFeed({ signals, filter, loading = false, error = null, mobile = false }) {
  if (error && !signals.length) {
    return <p className={`${ui.alert} ${ui.alertError}`} role="alert">No se pudieron cargar las señales: {error.message}</p>;
  }
  if (!signals.length) {
    return <p className={ui.empty}>{loading ? 'Cargando señales…' : EMPTY_TEXT[filter] || EMPTY_TEXT.all}</p>;
  }

  return <SignalsTimeline signals={signals} compact={mobile} />;
}
