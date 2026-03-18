import styles from './ConfigSection.module.css';

function ConfigSection({ title, defaultOpen = false, children }) {
  return (
    <details className={styles.section} open={defaultOpen || undefined}>
      <summary className={styles.summary}>
        <span className={styles.title}>{title}</span>
        <span className={styles.chevron} />
      </summary>
      <div className={styles.content}>
        {children}
      </div>
    </details>
  );
}

export default ConfigSection;
