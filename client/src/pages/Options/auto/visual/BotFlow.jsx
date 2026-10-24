import DirectionChip from '../DirectionChip';
import styles from './visual.module.css';

/**
 * La regla del bot en una línea: Señal → Contrato → Entrada → Salida.
 * `steps` viene de flowSteps(bot); `directions` (de botDirections) sustituye
 * el texto del paso «Señal» por los chips de dirección. `compact` lo apila
 * en filas (teléfono).
 */
export default function BotFlow({ steps = [], directions = [], compact = false }) {
  return (
    <ol className={`${styles.flow} ${compact ? styles.flowCompact : ''}`} aria-label="Cómo opera el bot">
      {steps.map((s) => (
        <li key={s.key} className={styles.step}>
          <b className={styles.stepTitle}>{s.title}</b>
          <span className={styles.stepValue}>
            {s.key === 'signal' && directions.length
              ? directions.map((d, i) => (
                <span key={d} className={styles.stepChips}>
                  {i > 0 && <span aria-hidden="true">/</span>}
                  <DirectionChip direction={d} />
                </span>
              ))
              : s.value}
          </span>
          {s.subtitle && <small className={styles.stepSub}>{s.subtitle}</small>}
        </li>
      ))}
    </ol>
  );
}
