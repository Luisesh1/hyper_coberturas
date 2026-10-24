import { formatDateTime } from '../strategies/common/format';
import DirectionChip from './DirectionChip';
import { SIGNAL_FILTER_OPTIONS, formatScore } from './botView';
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

function Decision({ signal }) {
  const hint = signal.decision === 'pending'
    ? 'La señal se procesó, pero todavía no hay ejecución confirmada por Binance.'
    : undefined;
  return (
    <span className={`${styles.decision} ${styles[`dec_${signal.tone}`]}`} title={hint}>
      {signal.decisionLabel}
    </span>
  );
}

function SimTag({ signal }) {
  if (!signal.simulated) return null;
  return <span className={styles.simTag} title="Señal de prueba: solo operó en sombra">Simulada</span>;
}

function SignalDetail({ detail }) {
  if (!detail) return null;
  return (
    <details className={styles.signalDisclosure}>
      <summary>Detalle</summary>
      <div className={styles.signalDetail}>{detail}</div>
    </details>
  );
}

// Registro «Señales recibidas y decisiones»: cronología en escritorio,
// tarjetas en el teléfono.
export default function SignalsFeed({ signals, filter, loading = false, error = null, mobile = false }) {
  if (error && !signals.length) {
    return <p className={`${ui.alert} ${ui.alertError}`} role="alert">No se pudieron cargar las señales: {error.message}</p>;
  }
  if (!signals.length) {
    return <p className={ui.empty}>{loading ? 'Cargando señales…' : EMPTY_TEXT[filter] || EMPTY_TEXT.all}</p>;
  }

  if (mobile) {
    return (
      <ul className={styles.signalCards} aria-label="Señales">
        {signals.map((s) => (
          <li key={s.id} className={styles.signalCard}>
            <span className={styles.signalCardRow}>
              <DirectionChip direction={s.direction} suffix={s.score !== null ? ` · ${formatScore(s.score)}` : ''} />
              <span className={`${ui.mono} ${styles.signalTime}`}>{formatDateTime(s.at)}</span>
            </span>
            <span className={styles.signalCardRow}>
              <Decision signal={s} />
              <SimTag signal={s} />
              {s.underlying && <span className={styles.underlyingTag} title={s.asset}>{s.underlying}</span>}
              <span className={styles.signalAlert}>{s.alertName}</span>
            </span>
            <SignalDetail detail={s.detail} />
          </li>
        ))}
      </ul>
    );
  }

  return <SignalsTimeline signals={signals} />;
}
