import styles from './SkeletonCard.module.css';

export default function SkeletonCard() {
  return (
    <div className={styles.skeleton}>
      <div className={styles.row}>
        <div className={`${styles.line} ${styles.title}`} />
        <div className={`${styles.line} ${styles.badge}`} />
      </div>
      <div className={styles.metrics}>
        <div className={styles.line} />
        <div className={styles.line} />
        <div className={styles.line} />
        <div className={styles.line} />
      </div>
      <div className={`${styles.line} ${styles.range}`} />
    </div>
  );
}
