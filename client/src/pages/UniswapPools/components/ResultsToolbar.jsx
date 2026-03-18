import styles from './ResultsToolbar.module.css';

const FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'eligible', label: 'Protegibles' },
  { key: 'protected', label: 'Protegidos' },
];

export default function ResultsToolbar({
  searchTerm, setSearchTerm,
  resultFilter, setResultFilter,
  sortBy, setSortBy,
  filteredCount, totalCount,
  filterCounts,
}) {
  return (
    <div className={styles.toolbar}>
      <input
        className={styles.search}
        type="text"
        placeholder="Buscar par, red o activo..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />

      <div className={styles.chips}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`${styles.chip} ${resultFilter === f.key ? styles.chipActive : ''}`}
            onClick={() => setResultFilter(f.key)}
          >
            {f.label}
            <span className={styles.chipCount}>{filterCounts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <select className={styles.sort} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
        <option value="value">Mas valor</option>
        <option value="recent">Mas reciente</option>
        <option value="out_of_range">Fuera de rango</option>
        <option value="yield">Mejor rendimiento</option>
      </select>

      <span className={styles.count}>{filteredCount} de {totalCount}</span>
    </div>
  );
}
