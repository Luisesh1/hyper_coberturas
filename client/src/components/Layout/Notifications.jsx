import { useTradingContext } from '../../context/TradingContext';
import styles from './Notifications.module.css';

const ICONS = {
  success: '✓',
  error:   '✗',
  info:    'ℹ',
  alert:   '⚡',
};

export function Notifications() {
  const { notifications } = useTradingContext();

  if (notifications.length === 0) return null;

  return (
    <div className={styles.container}>
      {notifications.map((n) => (
        <div key={n.id} className={`${styles.notification} ${styles[n.type]}`}>
          <span className={styles.icon}>{ICONS[n.type] ?? '•'}</span>
          <span className={styles.text}>
            {n.message.split('\n').map((line, i) => (
              <span key={i} className={i === 0 ? styles.title : styles.sub}>
                {line}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
