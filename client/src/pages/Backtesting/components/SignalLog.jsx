import { useState } from 'react';
import { formatDate, formatNumber } from '../../../utils/formatters';
import styles from './BottomPanel.module.css';

const PAGE_SIZE = 100;

function SignalLog({ signals }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const all = (signals || []).slice().reverse();
  const visible = all.slice(0, limit);

  return (
    <div className={styles.tabContent}>
      <div className={styles.filterBar}>
        <span className={styles.filterCount}>{all.length} senales</span>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Signal</th>
              <th>Action</th>
              <th>Precio</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item, i) => (
              <tr key={`${item.closeTime}-${i}`}>
                <td>{formatDate(item.closeTime)}</td>
                <td>{item.type}</td>
                <td>{item.action}</td>
                <td>{formatNumber(item.price, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit < all.length && (
        <button
          type="button"
          className={styles.loadMoreBtn}
          onClick={() => setLimit((p) => p + PAGE_SIZE)}
        >
          Cargar mas ({all.length - limit} restantes)
        </button>
      )}
    </div>
  );
}

export default SignalLog;
