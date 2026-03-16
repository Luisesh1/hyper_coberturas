import { useState } from 'react';
import { formatAccountIdentity } from '../../../utils/hyperliquidAccounts';
import { EmptyState } from '../../../components/shared/EmptyState';
import styles from './BotSidebar.module.css';

const FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'active', label: 'Activos' },
  { key: 'paused', label: 'Pausados' },
  { key: 'error', label: 'Errores' },
];

function statusClass(status) {
  if (status === 'active') return styles.statusActive;
  if (status === 'error') return styles.statusError;
  if (status === 'paused') return styles.statusPaused;
  return styles.statusIdle;
}

function runtimeClass(state) {
  if (state === 'retrying') return styles.runtimeRetrying;
  if (state === 'degraded') return styles.runtimeDegraded;
  if (state === 'paused_by_system') return styles.runtimePaused;
  return styles.runtimeHealthy;
}

export function BotSidebar({ bots, selectedBotId, onSelectBot, onNewBot }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const query = search.toLowerCase();
  const filtered = bots.filter((b) => {
    if (filter === 'error' && (!b.runtime?.state || b.runtime.state === 'healthy')) return false;
    if (filter !== 'all' && filter !== 'error' && b.status !== filter) return false;
    if (query && !b.asset.toLowerCase().includes(query) && !b.strategyName?.toLowerCase().includes(query)) return false;
    return true;
  });

  const counts = {
    all: bots.length,
    active: bots.filter((b) => b.status === 'active').length,
    paused: bots.filter((b) => b.status === 'paused').length,
    error: bots.filter((b) => b.runtime?.state && b.runtime.state !== 'healthy').length,
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <h3>Bots</h3>
        <button className={styles.newBtn} onClick={onNewBot}>+ Nuevo</button>
      </div>

      <div className={styles.filters}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`${styles.filterPill} ${filter === f.key ? styles.filterActive : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label} {counts[f.key] > 0 && <span className={styles.filterCount}>{counts[f.key]}</span>}
          </button>
        ))}
      </div>

      <input
        className={styles.search}
        placeholder="Buscar por asset o estrategia..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className={styles.list}>
        {filtered.map((bot) => (
          <button
            key={bot.id}
            className={`${styles.item} ${Number(bot.id) === Number(selectedBotId) ? styles.itemActive : ''}`}
            onClick={() => onSelectBot(bot)}
          >
            <div className={styles.itemTop}>
              <strong className={styles.itemName}>#{bot.id} · {bot.asset}</strong>
              <div className={styles.badges}>
                <span className={`${styles.pill} ${statusClass(bot.status)}`}>{bot.status}</span>
                {bot.runtime?.state && bot.runtime.state !== 'healthy' && (
                  <span className={`${styles.runtimePill} ${runtimeClass(bot.runtime.state)}`}>{bot.runtime.state}</span>
                )}
              </div>
            </div>
            <span className={styles.itemMeta}>{bot.strategyName}</span>
            <span className={styles.itemSub}>
              {formatAccountIdentity(bot.account)} · {bot.timeframe}
              {bot.runtime?.nextRetryAt ? ` · retry ${new Date(bot.runtime.nextRetryAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
          </button>
        ))}
        {!filtered.length && (
          <EmptyState icon="&#129302;" title="Sin bots" description={filter !== 'all' ? 'No hay bots con este filtro' : 'Crea tu primer bot'} action="+ Nuevo bot" onAction={onNewBot} />
        )}
      </div>
    </aside>
  );
}
