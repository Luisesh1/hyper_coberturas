import { useState } from 'react';
import { formatDate } from '../../../utils/formatters';
import { EmptyState } from '../../../components/shared/EmptyState';
import styles from './StrategySidebar.module.css';

const BUILTIN_INDICATORS = ['sma', 'ema', 'rsi', 'macd', 'atr', 'bollinger'];

export function StrategySidebar({
  strategies, indicators, selectedStrategyId, selectedIndicatorId,
  onSelectStrategy, onSelectIndicator, onNewStrategy, onNewIndicator,
  activeTab, onTabChange,
}) {
  const [search, setSearch] = useState('');
  const query = search.toLowerCase();

  const filteredStrategies = query
    ? strategies.filter((s) => s.name.toLowerCase().includes(query) || s.assetUniverse?.some((a) => a.toLowerCase().includes(query)))
    : strategies;

  const filteredIndicators = query
    ? indicators.filter((i) => i.name.toLowerCase().includes(query) || i.slug.toLowerCase().includes(query))
    : indicators;

  return (
    <aside className={styles.sidebar}>
      <input
        className={styles.search}
        placeholder="Buscar..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>Estrategias <span className={styles.count}>{strategies.length}</span></h3>
          <button className={styles.addBtn} onClick={onNewStrategy} title="Nueva estrategia">+</button>
        </div>
        <div className={styles.list}>
          {filteredStrategies.map((s) => (
            <button
              key={s.id}
              className={`${styles.item} ${Number(s.id) === Number(selectedStrategyId) && activeTab === 'strategy' ? styles.itemActive : ''}`}
              onClick={() => { onSelectStrategy(s); onTabChange('strategy'); }}
            >
              <strong className={styles.itemName}>{s.name}</strong>
              <span className={styles.itemMeta}>{s.assetUniverse?.join(', ')} · {s.timeframe}</span>
              <span className={styles.itemDate}>
                {s.latestBacktest?.summary?.trades ?? 0} trades · {formatDate(s.updatedAt)}
              </span>
            </button>
          ))}
          {!filteredStrategies.length && (
            <EmptyState icon="{ }" title="Sin estrategias" description="Crea tu primera estrategia" action="+ Nueva" onAction={onNewStrategy} />
          )}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>Indicadores <span className={styles.count}>{indicators.length}</span></h3>
          <button className={styles.addBtn} onClick={onNewIndicator} title="Nuevo indicador">+</button>
        </div>
        <div className={styles.badges}>
          {BUILTIN_INDICATORS.map((name) => (
            <span key={name} className={styles.badge}>{name}</span>
          ))}
        </div>
        <div className={styles.list}>
          {filteredIndicators.map((i) => (
            <button
              key={i.id}
              className={`${styles.item} ${Number(i.id) === Number(selectedIndicatorId) && activeTab === 'indicator' ? styles.itemActive : ''}`}
              onClick={() => { onSelectIndicator(i); onTabChange('indicator'); }}
            >
              <strong className={styles.itemName}>{i.name}</strong>
              <span className={styles.itemMeta}>@{i.slug}</span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
