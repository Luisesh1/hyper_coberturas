import { summarizeCondition } from '../lib/labels';
import styles from './MobileAlertEditor.module.css';

// Tarjeta‑resumen de una regla: número, condiciones legibles unidas por Y/O
// y «etiqueta» · peso. Toda la tarjeta es un botón que abre la regla.
export default function RuleSummaryCard({ index, rule, onOpen }) {
  const conds = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const joiners = Array.isArray(rule?.joiners) ? rule.joiners : [];
  const label = String(rule?.label || '').trim();
  const weight = Number(rule?.weight);

  return (
    <button type="button" className={styles.ruleCard} onClick={() => onOpen(index)}>
      <span className={styles.ruleNum}>
        <span className={styles.srOnly}>Regla </span>{index + 1}
      </span>
      <span className={styles.ruleBody}>
        <span className={styles.ruleSummary}>
          {conds.length === 0 && 'Sin condiciones'}
          {conds.map((c, i) => (
            <span key={c.id || i} className={styles.ruleCond}>
              {i > 0 && <span className={styles.ruleJoiner}>{(joiners[i - 1] || 'and') === 'or' ? ' O ' : ' Y '}</span>}
              {summarizeCondition(c)}
            </span>
          ))}
        </span>
        <span className={styles.ruleMeta}>
          {label ? `«${label}» · ` : ''}peso {Number.isFinite(weight) ? weight : 1}
        </span>
      </span>
      <svg className={styles.ruleChevron} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}
