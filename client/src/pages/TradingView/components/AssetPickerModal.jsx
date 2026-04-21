import { useEffect, useCallback, useMemo, useState } from 'react';
import { marketApi } from '../../../services/api';
import styles from './AssetPickerModal.module.css';

const DATASOURCE_BADGE = {
  hyperliquid: { cls: 'badgeHL', label: 'HL' },
  binance:     { cls: 'badgeBinance', label: 'Binance' },
  yahoo:       { cls: 'badgeYahoo', label: 'Yahoo' },
};

export default function AssetPickerModal({ open, currentAsset, onSelect, onCancel }) {
  const [catalog, setCatalog] = useState({ categories: {}, assets: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onCancel?.();
  }, [onCancel]);

  useEffect(() => {
    if (!open) return undefined;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    marketApi.getCatalog()
      .then((res) => {
        if (cancelled) return;
        setCatalog({
          categories: res?.categories || {},
          assets: Array.isArray(res?.assets) ? res.assets : [],
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Error cargando catálogo');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.assets.filter((a) => {
      if (activeCategory !== 'all' && a.category !== activeCategory) return false;
      if (!q) return true;
      return (
        a.symbol.toLowerCase().includes(q)
        || (a.name || '').toLowerCase().includes(q)
        || (a.datasource || '').includes(q)
      );
    });
  }, [catalog.assets, query, activeCategory]);

  if (!open) return null;

  const currentId = currentAsset ? `${currentAsset.datasource}:${currentAsset.symbol}` : null;

  return (
    <div className={styles.overlay} onClick={onCancel} role="dialog" aria-modal="true" aria-label="Seleccionar par">
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>📊 Seleccionar par</span>
          <button type="button" className={styles.closeBtn} onClick={onCancel} aria-label="Cerrar">✕</button>
        </div>

        <div className={styles.searchWrap}>
          <input
            autoFocus
            type="text"
            className={styles.search}
            placeholder="🔍 Buscar símbolo o nombre (BTC, SPX, Apple, oro...)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${activeCategory === 'all' ? styles.tabActive : ''}`}
            onClick={() => setActiveCategory('all')}
          >
            Todos ({catalog.assets.length})
          </button>
          {Object.entries(catalog.categories).map(([key, label]) => {
            const count = catalog.assets.filter((a) => a.category === key).length;
            if (!count) return null;
            return (
              <button
                key={key}
                type="button"
                className={`${styles.tab} ${activeCategory === key ? styles.tabActive : ''}`}
                onClick={() => setActiveCategory(key)}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>

        <div className={styles.list}>
          {loading && <div className={styles.empty}>Cargando…</div>}
          {error && !loading && <div className={styles.empty}>⚠️ {error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className={styles.empty}>Sin resultados para "{query}"</div>
          )}
          {!loading && !error && filtered.map((asset) => {
            const badge = DATASOURCE_BADGE[asset.datasource] || { cls: '', label: asset.datasource };
            const selected = asset.id === currentId;
            return (
              <div
                key={asset.id}
                className={`${styles.item} ${selected ? styles.itemSelected : ''}`}
                onClick={() => onSelect(asset)}
              >
                <span className={styles.itemSymbol}>{asset.symbol}</span>
                <span className={styles.itemName}>{asset.name}</span>
                <span className={`${styles.itemBadge} ${styles[badge.cls] || ''}`}>{badge.label}</span>
              </div>
            );
          })}
        </div>

        <div className={styles.footer}>
          <span>{filtered.length} activos</span>
          <span>ESC para cerrar</span>
        </div>
      </div>
    </div>
  );
}
