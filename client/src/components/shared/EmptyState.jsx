import styles from './EmptyState.module.css';

export function EmptyState({ icon = '{}', title, description, action, onAction }) {
  return (
    <div className={styles.empty}>
      <span className={styles.icon}>{icon}</span>
      <strong className={styles.title}>{title}</strong>
      {description && <p className={styles.description}>{description}</p>}
      {action && onAction && (
        <button className={styles.cta} onClick={onAction}>{action}</button>
      )}
    </div>
  );
}
