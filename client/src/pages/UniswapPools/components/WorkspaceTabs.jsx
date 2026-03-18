import styles from './WorkspaceTabs.module.css';

export default function WorkspaceTabs({ activeTab, onTabChange, protectedCount, hasResults }) {
  return (
    <div className={styles.tabs}>
      <button
        type="button"
        className={`${styles.tab} ${activeTab === 'scan' ? styles.tabActive : ''}`}
        onClick={() => onTabChange('scan')}
      >
        Resultados del scan
        {hasResults && <span className={styles.badge}>●</span>}
      </button>
      <button
        type="button"
        className={`${styles.tab} ${activeTab === 'protected' ? styles.tabActive : ''}`}
        onClick={() => onTabChange('protected')}
      >
        Pools protegidos
        {protectedCount > 0 && (
          <span className={`${styles.badge} ${styles.badgeCount}`}>{protectedCount}</span>
        )}
      </button>
    </div>
  );
}
