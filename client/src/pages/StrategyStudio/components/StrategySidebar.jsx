import { useState } from 'react';
import { formatDate } from '../../../utils/formatters';
import { EmptyState } from '../../../components/shared/EmptyState';
import { STRATEGY_TEMPLATES } from '../strategy-templates';
import styles from './StrategySidebar.module.css';

const BUILTIN_INDICATORS = ['sma', 'ema', 'rsi', 'macd', 'atr', 'bollinger'];

export function StrategySidebar({
  strategies, indicators, selectedStrategyId, selectedIndicatorId,
  onSelectStrategy, onSelectIndicator, onNewStrategy, onNewIndicator,
  onSelectTemplate,
  activeTab, onTabChange,
}) {
  const [showTemplates, setShowTemplates] = useState(false);
  const [search, setSearch] = useState('');
  const query = search.toLowerCase();

  const filteredStrategies = query
    ? strategies.filter((s) => s.name.toLowerCase().includes(query) || s.assetUniverse?.some((a) => a.toLowerCase().includes(query)))
    : strategies;

  const filteredIndicators = query
    ? indicators.filter((i) => i.name.toLowerCase().includes(query) || i.slug.toLowerCase().includes(query))
    : indicators;

  const getHealthClass = (strategy) => {
    const summary = strategy.latestBacktest?.summary;
    if (!summary) return styles.itemMissing;
    if (Number(summary.maxDrawdown) >= 20 || Number(summary.netPnl) < 0) return styles.itemWarning;
    return '';
  };

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
          <div className={styles.headerActions}>
            <button className={styles.templateToggle} onClick={() => setShowTemplates(!showTemplates)} title="Templates">
              {showTemplates ? '✕' : '⚡'}
            </button>
            <button className={styles.addBtn} onClick={onNewStrategy} title="Nueva en blanco">+</button>
          </div>
        </div>
        {showTemplates && (
          <div className={styles.templateList}>
            <span className={styles.templateLabel}>Crear desde template:</span>
            {STRATEGY_TEMPLATES.map((tpl) => (
              <button
                key={tpl.key}
                className={styles.templateItem}
                onClick={() => { onSelectTemplate(tpl); setShowTemplates(false); onTabChange('strategy'); }}
              >
                <strong className={styles.itemName}>{tpl.name}</strong>
                <span className={styles.itemMeta}>{tpl.description}</span>
              </button>
            ))}
          </div>
        )}
        <div className={styles.list}>
          {filteredStrategies.map((s) => (
            <button
              key={s.id}
              className={`${styles.item} ${getHealthClass(s)} ${Number(s.id) === Number(selectedStrategyId) && activeTab === 'strategy' ? styles.itemActive : ''}`}
              onClick={() => { onSelectStrategy(s); onTabChange('strategy'); }}
            >
              <strong className={styles.itemName}>{s.name}</strong>
              <span className={styles.itemMeta}>{s.assetUniverse?.join(', ')} · {s.timeframe}</span>
              <span className={styles.itemDate}>
                {s.latestBacktest?.summary
                  ? `${s.latestBacktest.summary.trades ?? 0} trades · PnL ${s.latestBacktest.summary.netPnl ?? '—'} · DD ${s.latestBacktest.summary.maxDrawdown ?? '—'}`
                  : 'Sin backtest guardado'}
              </span>
              <span className={styles.itemDate}>
                {formatDate(s.latestBacktest?.updatedAt || s.updatedAt)}
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
