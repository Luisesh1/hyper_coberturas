import { formatDateTime } from '../../strategies/common/format';
import { DirectionGlyph } from '../DirectionChip';
import { DIRECTION_LABEL, formatScore, normalizeDirection, signalFeeText } from '../botView';
import { relativeTime, signalOutcome } from './visualModel';
import styles from './visual.module.css';

const ICON_TONE = { bullish: 'up', bearish: 'down', neutral: 'flat' };

/**
 * Cronología de señales: icono de dirección, resultado en píldora, detalle y
 * línea de comisión («Comisión est. …» mientras la entrada espera fill).
 * `signals` ya normalizadas (normalizeSignals). `now` solo para las horas
 * relativas; `compact` quita la línea de alerta y puntaje.
 */
export default function SignalsTimeline({ signals = [], now = Date.now(), compact = false }) {
  return (
    <ol className={`${styles.timeline} ${compact ? styles.timelineCompact : ''}`} aria-label="Señales">
      {signals.map((s) => {
        const dir = normalizeDirection(s.direction);
        const outcome = signalOutcome(s);
        const fee = signalFeeText(s) ?? (outcome.noFill ? 'Sin comisión' : null);
        const meta = [s.alertName !== '—' ? s.alertName : null, s.score !== null ? formatScore(s.score) : null].filter(Boolean).join(' · ');
        return (
          <li key={s.id} className={styles.ev}>
            <span className={`${styles.ico} ${styles[`ico_${ICON_TONE[dir]}`]}`} aria-hidden="true">
              <DirectionGlyph direction={dir} size={10} />
            </span>
            <div className={styles.evBody}>
              <div className={styles.evTitle}>
                <span>{DIRECTION_LABEL[dir]}</span>
                <span className={`${styles.pill} ${styles[`pill_${outcome.tone}`]}`}>{outcome.label}</span>
                {s.simulated && <span className={`${styles.pill} ${styles.pill_sim}`} title="Señal de prueba: solo operó en sombra">Simulada</span>}
                {s.underlying && <span className={styles.underlying} title={s.asset || undefined}>{s.underlying}</span>}
              </div>
              {s.detail && <div className={styles.evDetail}>{s.detail}</div>}
              {!compact && meta && <div className={styles.evMeta}>{meta}</div>}
              {fee && <span className={styles.fee}>{fee}</span>}
            </div>
            <time className={styles.evTime} dateTime={s.at ? new Date(s.at).toISOString() : undefined} title={formatDateTime(s.at)}>
              {relativeTime(s.at, now)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
