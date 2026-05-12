import { useCallback, useEffect, useMemo, useState } from 'react';
import { marketApi } from '../../../services/api';
import styles from '../AlertsPage.module.css';

const TABS = [
  { id: 'catalog',  label: '🗂  Catálogo' },
  { id: 'provider', label: '🌐  Por proveedor' },
  { id: 'volume',   label: '📊  Top volumen' },
];

function compactUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function providerCountLabel(assets) {
  const source = assets.some((asset) => asset.source === 'exchange') ? 'disponibles' : 'curados';
  return `${assets.length} activos ${source}`;
}

/**
 * Selector masivo de activos. El padre pasa:
 *   - open: boolean
 *   - currentAssets: string[] — activos ya en la alerta (para evitar duplicados)
 *   - currentDatasource: string — datasource activo de la alerta (para sugerir mismo provider)
 *   - onAdd: (symbols: string[], datasource: string) => void
 *   - onClose: () => void
 *
 * Si el usuario elige símbolos de un datasource distinto al actual, le avisamos
 * pero igual los agregamos (el server validará al guardar). Devolvemos el
 * datasource elegido para que el padre pueda re-sincronizar.
 */
export default function AssetPickerModal({ open, currentAssets, currentDatasource, onAdd, onClose }) {
  const [tab, setTab] = useState('catalog');
  const [catalog, setCatalog] = useState({ categories: {}, assets: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Filtros del tab "Catálogo"
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterDatasource, setFilterDatasource] = useState('all');
  const [search, setSearch] = useState('');

  // Selección compartida (cualquiera de los tabs alimenta el set final).
  // Map: `${datasource}:${symbol}` → { datasource, symbol }
  const [selected, setSelected] = useState(new Map());

  // Tab "Top volumen"
  const [volDatasource, setVolDatasource] = useState(
    currentDatasource === 'hyperliquid' ? 'hyperliquid' : 'binance'
  );
  const [volWindow, setVolWindow] = useState('1d');
  const [volLimit, setVolLimit] = useState(20);
  const [volRows, setVolRows] = useState([]);
  const [volLoading, setVolLoading] = useState(false);
  const [volError, setVolError] = useState(null);

  // Reset al abrir
  useEffect(() => {
    if (!open) return;
    setTab('catalog');
    setSelected(new Map());
    setSearch('');
    setFilterCategory('all');
    setFilterDatasource(currentDatasource || 'all');
    setVolDatasource(currentDatasource === 'hyperliquid' ? 'hyperliquid' : 'binance');
    setVolRows([]);
    setVolError(null);
  }, [open, currentDatasource]);

  // Cargar catálogo on demand
  useEffect(() => {
    if (!open || catalog.assets.length > 0) return;
    let cancelled = false;
    setCatalogLoading(true);
    marketApi.getCatalog()
      .then((res) => { if (!cancelled) setCatalog(res || { categories: {}, assets: [] }); })
      .catch(() => null)
      .finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [open, catalog.assets.length]);

  const currentAssetSet = useMemo(() => new Set(currentAssets || []), [currentAssets]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (catalog.assets || []).filter((a) => {
      if (filterCategory !== 'all' && a.category !== filterCategory) return false;
      if (filterDatasource !== 'all' && a.datasource !== filterDatasource) return false;
      if (q && !a.symbol.toLowerCase().includes(q) && !a.name?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalog.assets, filterCategory, filterDatasource, search]);

  const assetsByDatasource = useMemo(() => {
    const out = { hyperliquid: [], binance: [], yahoo: [] };
    for (const a of (catalog.assets || [])) {
      if (out[a.datasource]) out[a.datasource].push(a);
    }
    return out;
  }, [catalog.assets]);

  const toggle = (asset) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const k = `${asset.datasource}:${asset.symbol}`;
      if (next.has(k)) next.delete(k);
      else next.set(k, { datasource: asset.datasource, symbol: asset.symbol });
      return next;
    });
  };

  const addAll = (assets) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const a of assets) {
        const k = `${a.datasource}:${a.symbol}`;
        next.set(k, { datasource: a.datasource, symbol: a.symbol });
      }
      return next;
    });
  };

  const clear = () => setSelected(new Map());

  const loadTop = useCallback(async () => {
    setVolLoading(true);
    setVolError(null);
    try {
      const rows = await marketApi.getTopByVolume({
        datasource: volDatasource,
        window: volWindow,
        limit: Math.max(1, Math.min(100, Number(volLimit) || 20)),
      });
      setVolRows(rows || []);
    } catch (err) {
      setVolError(err.message);
      setVolRows([]);
    } finally {
      setVolLoading(false);
    }
  }, [volDatasource, volWindow, volLimit]);

  // Cargar automáticamente al cambiar a este tab la primera vez
  useEffect(() => {
    if (open && tab === 'volume' && volRows.length === 0 && !volLoading && !volError) {
      loadTop();
    }
  }, [open, tab, volRows.length, volLoading, volError, loadTop]);

  const handleConfirm = () => {
    if (selected.size === 0) {
      onClose();
      return;
    }
    // Si todos los seleccionados son del MISMO datasource, lo pasamos al
    // padre para que se sincronice. Si vienen de varios, mandamos null.
    const datasources = new Set(Array.from(selected.values()).map((s) => s.datasource));
    const ds = datasources.size === 1 ? Array.from(datasources)[0] : null;
    const symbols = Array.from(selected.values()).map((s) => s.symbol);
    onAdd(symbols, ds);
    onClose();
  };

  if (!open) return null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>Agregar activos a la alerta</h3>
          <button className={styles.modalClose} onClick={onClose} aria-label="Cerrar">×</button>
        </div>

        <div className={styles.tabBar}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.modalBody}>
          {/* ------------------------------ TAB: CATÁLOGO ------------------------------ */}
          {tab === 'catalog' && (
            <>
              <div className={styles.catalogFilters}>
                <input
                  className={styles.input}
                  type="search"
                  placeholder="Buscar símbolo o nombre…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                />
                <select className={styles.select} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
                  <option value="all">Todas las categorías</option>
                  {Object.entries(catalog.categories || {}).map(([id, label]) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
                </select>
                <select className={styles.select} value={filterDatasource} onChange={(e) => setFilterDatasource(e.target.value)}>
                  <option value="all">Todos los proveedores</option>
                  <option value="binance">Binance</option>
                  <option value="hyperliquid">Hyperliquid</option>
                  <option value="yahoo">Yahoo</option>
                </select>
                <button
                  type="button"
                  className={styles.btn + ' ' + styles.btnSecondary}
                  onClick={() => addAll(filteredCatalog)}
                  disabled={filteredCatalog.length === 0}
                  title="Selecciona todos los visibles"
                >
                  Marcar visibles ({filteredCatalog.length})
                </button>
              </div>

              <div className={styles.assetList}>
                {catalogLoading && <div className={styles.empty}>Cargando catálogo…</div>}
                {!catalogLoading && filteredCatalog.length === 0 && (
                  <div className={styles.empty}>No hay activos con esos filtros.</div>
                )}
                {filteredCatalog.map((a) => {
                  const k = `${a.datasource}:${a.symbol}`;
                  const isSelected = selected.has(k);
                  const isAlreadyInAlert = currentAssetSet.has(a.symbol);
                  return (
                    <label key={k} className={`${styles.assetRow} ${isSelected ? styles.assetRowSelected : ''}`}>
                      <input
                        type="checkbox"
                        checked={isSelected || isAlreadyInAlert}
                        disabled={isAlreadyInAlert}
                        onChange={() => toggle(a)}
                      />
                      <span className={styles.assetSymbol}>{a.symbol}</span>
                      <span className={styles.assetName}>{a.name}</span>
                      <span className={styles.assetMeta}>
                        {catalog.categories?.[a.category] || a.category} · {a.datasource}
                      </span>
                      {isAlreadyInAlert && <span className={styles.assetTag}>ya en alerta</span>}
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {/* ------------------------------ TAB: PROVEEDOR ------------------------------ */}
          {tab === 'provider' && (
            <div className={styles.providerCards}>
              {['hyperliquid', 'binance', 'yahoo'].map((ds) => {
                const list = assetsByDatasource[ds] || [];
                return (
                  <div key={ds} className={styles.providerCard}>
                    <div className={styles.providerHead}>
                      <strong>{ds === 'hyperliquid' ? 'Hyperliquid' : ds === 'binance' ? 'Binance' : 'Yahoo Finance'}</strong>
                      <span className={styles.providerCount}>{providerCountLabel(list)}</span>
                    </div>
                    <p className={styles.providerHint}>
                      {ds === 'binance' && 'Pares spot USDT (BTCUSDT, ETHUSDT…).'}
                      {ds === 'hyperliquid' && 'Perpetuos en formato corto (BTC, ETH…).'}
                      {ds === 'yahoo' && 'Acciones, índices, commodities, forex.'}
                    </p>
                    <button
                      type="button"
                      className={styles.btn + ' ' + styles.btnSecondary}
                      onClick={() => addAll(list)}
                    >
                      Agregar los {list.length} activos
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* ------------------------------ TAB: TOP VOLUMEN ------------------------------ */}
          {tab === 'volume' && (
            <>
              <div className={styles.volumeControls}>
                <div className={styles.formField}>
                  <label>Proveedor</label>
                  <select className={styles.select} value={volDatasource} onChange={(e) => { setVolDatasource(e.target.value); setVolRows([]); }}>
                    <option value="binance">Binance</option>
                    <option value="hyperliquid">Hyperliquid</option>
                  </select>
                </div>
                <div className={styles.formField}>
                  <label>Ventana</label>
                  <div className={styles.chipRow}>
                    {[
                      { v: '1d', l: '1 día' },
                      { v: '1w', l: '1 semana' },
                      { v: '1M', l: '1 mes' },
                    ].map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        className={`${styles.chipBtn} ${volWindow === opt.v ? styles.chipBtnActive : ''}`}
                        onClick={() => { setVolWindow(opt.v); setVolRows([]); }}
                        disabled={volDatasource === 'hyperliquid' && opt.v !== '1d'}
                        title={volDatasource === 'hyperliquid' && opt.v !== '1d' ? 'Hyperliquid sólo soporta 1d por ahora' : ''}
                      >
                        {opt.l}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.formField}>
                  <label>Top N</label>
                  <input
                    className={styles.input}
                    type="number" min="1" max="100" step="1"
                    value={volLimit}
                    onChange={(e) => setVolLimit(Number(e.target.value) || 20)}
                  />
                </div>
                <button
                  type="button"
                  className={styles.btn + ' ' + styles.btnPrimary}
                  onClick={loadTop}
                  disabled={volLoading}
                >
                  {volLoading ? 'Cargando…' : 'Cargar top'}
                </button>
              </div>

              {volError && <div className={styles.empty} style={{ color: '#ef4444' }}>Error: {volError}</div>}

              <div className={styles.volumeList}>
                {!volLoading && volRows.length > 0 && (
                  <div className={styles.volumeActions}>
                    <button
                      type="button"
                      className={styles.btn + ' ' + styles.btnSecondary}
                      onClick={() => addAll(volRows.map((r) => ({ datasource: r.datasource, symbol: r.symbol })))}
                    >
                      Marcar los {volRows.length}
                    </button>
                    <span className={styles.volumeHint}>
                      Ordenado por volumen {volWindow === '1d' ? '24 h' : volWindow === '1w' ? '7 d' : '30 d'} en USD.
                    </span>
                  </div>
                )}
                {volRows.map((r, i) => {
                  const k = `${r.datasource}:${r.symbol}`;
                  const isSelected = selected.has(k);
                  const isAlreadyInAlert = currentAssetSet.has(r.symbol);
                  return (
                    <label key={k} className={`${styles.assetRow} ${isSelected ? styles.assetRowSelected : ''}`}>
                      <input
                        type="checkbox"
                        checked={isSelected || isAlreadyInAlert}
                        disabled={isAlreadyInAlert}
                        onChange={() => toggle({ datasource: r.datasource, symbol: r.symbol })}
                      />
                      <span className={styles.assetRank}>#{i + 1}</span>
                      <span className={styles.assetSymbol}>{r.symbol}</span>
                      <span className={styles.assetMeta}>
                        Vol: <strong>{compactUsd(r.volumeUsd)}</strong>
                        {r.price > 0 && <> · ${r.price < 1 ? r.price.toFixed(4) : r.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}</>}
                      </span>
                      {isAlreadyInAlert && <span className={styles.assetTag}>ya en alerta</span>}
                    </label>
                  );
                })}
                {!volLoading && volRows.length === 0 && !volError && (
                  <div className={styles.empty}>Pulsa "Cargar top" para listar activos por volumen.</div>
                )}
              </div>
            </>
          )}
        </div>

        <div className={styles.modalFooter}>
          <span className={styles.modalSelCount}>
            {selected.size > 0 ? `${selected.size} activo${selected.size === 1 ? '' : 's'} seleccionado${selected.size === 1 ? '' : 's'}` : 'Sin selección'}
          </span>
          {selected.size > 0 && (
            <button type="button" className={styles.btn + ' ' + styles.btnSecondary} onClick={clear}>
              Limpiar
            </button>
          )}
          <button type="button" className={styles.btn + ' ' + styles.btnSecondary} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className={styles.btn + ' ' + styles.btnPrimary}
            onClick={handleConfirm}
            disabled={selected.size === 0}
          >
            Agregar {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
