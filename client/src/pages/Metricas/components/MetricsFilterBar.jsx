import styles from '../MetricasPage.module.css';

export const RANGE_OPTIONS = [
  { id: '24h', label: '24h', ms: 24 * 60 * 60_000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 60 * 60_000 },
  { id: '30d', label: '30d', ms: 30 * 24 * 60 * 60_000 },
  { id: 'all', label: 'Todo', ms: null },
];

export const STATUS_OPTIONS = [
  { id: 'active', label: 'Activas' },
  { id: 'archived', label: 'Archivadas' },
];

export default function MetricsFilterBar({
  range, onRangeChange,
  statusFilter, onStatusChange,
  search, onSearchChange,
}) {
  return (
    <div className={styles.filterBar}>
      <div className={styles.filterGroup}>
        <span className={styles.filterLabel}>Rango</span>
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`${styles.chip} ${range === opt.id ? styles.chipActive : ''}`}
            aria-pressed={range === opt.id}
            onClick={() => onRangeChange(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className={styles.filterGroup}>
        <span className={styles.filterLabel}>Wallets</span>
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`${styles.chip} ${statusFilter === opt.id ? styles.chipActive : ''}`}
            aria-pressed={statusFilter === opt.id}
            onClick={() => onStatusChange(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <input
        type="search"
        className={styles.searchInput}
        placeholder="Buscar dirección…"
        aria-label="Buscar wallet por dirección"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </div>
  );
}
