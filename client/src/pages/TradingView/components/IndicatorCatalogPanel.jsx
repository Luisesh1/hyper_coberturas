import { useMemo, useState } from 'react';
import { INDICATORS, INDICATOR_CATEGORIES } from '../indicators/catalog';
import styles from './IndicatorConfigModal.module.css';

export default function IndicatorCatalogPanel({ onAdd }) {
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const result = new Map();
    for (const cat of Object.keys(INDICATOR_CATEGORIES)) result.set(cat, []);
    for (const meta of Object.values(INDICATORS)) {
      if (q && !`${meta.label} ${meta.fullName}`.toLowerCase().includes(q)) continue;
      if (!result.has(meta.category)) result.set(meta.category, []);
      result.get(meta.category).push(meta);
    }
    return result;
  }, [query]);

  return (
    <>
      <p className={styles.columnTitle}>Catálogo</p>
      <input
        type="text"
        className={styles.search}
        placeholder="🔍 Buscar indicador..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {[...grouped.entries()].map(([cat, items]) => {
        if (items.length === 0) return null;
        return (
          <div key={cat} className={styles.catalogCategory}>
            <p className={styles.catalogCategoryLabel}>{INDICATOR_CATEGORIES[cat] || cat}</p>
            {items.map((meta) => (
              <div key={meta.id} className={styles.catalogItem} onClick={() => onAdd(meta.id)}>
                <span className={styles.catalogItemLabel}>{meta.label}</span>
                <span className={styles.catalogItemFull}>{meta.fullName}</span>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}
