import styles from '../SmartCreatePoolModal.module.css';

/**
 * Pill indicador del paso actual del wizard (1. Pool, 2. Rango, etc.).
 */
export default function StepPill({ label, active, done }) {
  return (
    <div className={`${styles.stepPill} ${active ? styles.stepPillActive : ''} ${done ? styles.stepPillDone : ''}`}>
      {label}
    </div>
  );
}
