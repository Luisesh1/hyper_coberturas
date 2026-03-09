import { useTradingContext } from '../../context/TradingContext';
import styles from './Notifications.module.css';

export function Notifications() {
  const { notifications } = useTradingContext();

  if (notifications.length === 0) return null;

  return (
    <div className={styles.container}>
      {notifications.map((n) => (
        <div key={n.id} className={`${styles.notification} ${styles[n.type]}`}>
          {n.message}
        </div>
      ))}
    </div>
  );
}
