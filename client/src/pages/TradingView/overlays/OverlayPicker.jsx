import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { marketApi } from '../../../services/api';
import BottomSheet from '../components/BottomSheet';
import OptionBrowser, { CheckIcon, SearchIcon } from './OptionBrowser';
import { MAX_OVERLAYS, isSameAsMain, overlayId, shortLabel } from './overlayModel';
import styles from './OverlayPicker.module.css';

// Selector de superposiciones: pestañas "Activo" (catálogo) y "Opción"
// (Deribit). Se pueden añadir varias sin cerrar. Escritorio: modal; móvil:
// BottomSheet.

const DS_LABEL = { binance: 'Binance', hyperliquid: 'Hyperliquid', yahoo: 'Yahoo' };
const FULL_TITLE = 'Máximo 6 superposiciones';
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const TABS = [
  { id: 'asset', label: 'Activo' },
  { id: 'option', label: 'Opción · Deribit' },
];

// "ETHUSDT" → "ETH", "BTC-PERP" → "BTC".
export function mainUnderlyingOf(asset) {
  return String(asset?.symbol || '')
    .toUpperCase()
    .replace(/-PERP$/, '')
    .replace(/[-/]?(USDT|USDC|USD)$/, '');
}

function overlaySubtitle(o) {
  if (o.kind === 'option') return o.hidden ? 'Deribit · oculto' : 'Deribit';
  const ds = DS_LABEL[o.asset.datasource] || o.asset.datasource;
  return o.hidden ? `${ds} · oculto` : ds;
}

function useCatalog(open) {
  const [catalog, setCatalog] = useState({ categories: {}, assets: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
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
      .catch((err) => { if (!cancelled) setError(err?.message || 'Error cargando catálogo'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);
  return { catalog, loading, error };
}

function AssetTab({ open, items, addedIds, full, mainAsset, onAdd, onRemove, mobile }) {
  const { catalog, loading, error } = useCatalog(open);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');

  const candidates = useMemo(
    () => catalog.assets.filter((a) => !isSameAsMain({ kind: 'asset', asset: a }, mainAsset)),
    [catalog.assets, mainAsset],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.filter((a) => {
      if (category !== 'all' && a.category !== category) return false;
      if (!q) return true;
      return a.symbol.toLowerCase().includes(q)
        || (a.name || '').toLowerCase().includes(q)
        || (a.datasource || '').includes(q);
    });
  }, [candidates, query, category]);

  return (
    <div className={styles.assetTab}>
      <label className={`${styles.searchBox} ${mobile ? styles.searchBoxMobile : ''}`}>
        <SearchIcon />
        <input
          type="search"
          placeholder="Buscar activo"
          aria-label="Buscar activo"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className={styles.categories}>
        <button
          type="button"
          aria-pressed={category === 'all'}
          className={`${styles.pill} ${category === 'all' ? styles.pillActive : ''}`}
          onClick={() => setCategory('all')}
        >
          Todos
        </button>
        {Object.entries(catalog.categories).map(([key, label]) => {
          if (!candidates.some((a) => a.category === key)) return null;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={category === key}
              className={`${styles.pill} ${category === key ? styles.pillActive : ''}`}
              onClick={() => setCategory(key)}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className={styles.assetScroll}>
        {items.length > 0 && (
          <section aria-label="En el gráfico">
            <div className={styles.groupLabel}>En el gráfico</div>
            {items.map((o) => {
              const label = shortLabel(o);
              return (
                <div key={o.id} className={styles.assetRow}>
                  <span
                    className={`${styles.dot} ${o.hidden ? styles.dotHollow : ''}`}
                    style={o.hidden ? { borderColor: o.color } : { background: o.color }}
                    aria-hidden="true"
                  />
                  <span className={styles.assetText}>
                    <span className={styles.assetName}>{label}</span>
                    <span className={styles.assetSub}>{overlaySubtitle(o)}</span>
                  </span>
                  <button type="button" className={styles.addedBtn} aria-label={`Quitar ${label}`} onClick={() => onRemove(o.id)}>
                    <CheckIcon />Añadido
                  </button>
                </div>
              );
            })}
          </section>
        )}

        <section aria-label="Catálogo">
          <div className={styles.groupLabel}>Catálogo</div>
          {loading && <div className={styles.empty}>Cargando…</div>}
          {error && !loading && <div className={styles.empty}>{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className={styles.empty}>{query ? `Sin resultados para "${query}"` : 'Sin activos'}</div>
          )}
          {!loading && !error && filtered.map((a) => {
            const spec = { kind: 'asset', asset: { symbol: a.symbol, datasource: a.datasource, name: a.name ?? a.symbol } };
            const id = overlayId(spec);
            const label = shortLabel(spec);
            const ds = DS_LABEL[a.datasource] || a.datasource;
            const sub = a.name && a.name !== a.symbol && a.name !== label ? `${ds} · ${a.name}` : ds;
            return (
              <div key={a.id ?? id} className={styles.assetRow}>
                <span className={styles.assetText}>
                  <span className={styles.assetName}>{label}</span>
                  <span className={styles.assetSub}>{sub}</span>
                </span>
                {addedIds.has(id) ? (
                  <button type="button" className={styles.addedBtn} aria-label={`Quitar ${label}`} onClick={() => onRemove(id)}>
                    <CheckIcon />Añadido
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.addBtn}
                    aria-label={`Añadir ${label}`}
                    disabled={full}
                    title={full ? FULL_TITLE : undefined}
                    onClick={() => onAdd(spec)}
                  >
                    + Añadir
                  </button>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

function PickerBody({ open, mobile, state, mainAsset, onAdd, onRemove, tab, setTab, optionVisited }) {
  const baseId = useId();
  const items = useMemo(() => state?.items ?? [], [state]);
  const addedIds = useMemo(() => new Set(items.map((o) => o.id)), [items]);
  const full = items.length >= MAX_OVERLAYS;

  const onTabKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tab === 'asset' ? 'option' : 'asset';
    setTab(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  };

  return (
    <>
      <div role="tablist" aria-label="Tipo de superposición" className={mobile ? styles.tabsMobile : styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`${baseId}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
            onKeyDown={onTabKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id={`${baseId}-panel-asset`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-asset`}
        hidden={tab !== 'asset'}
        className={styles.panel}
      >
        <AssetTab
          open={open}
          items={items}
          addedIds={addedIds}
          full={full}
          mainAsset={mainAsset}
          onAdd={onAdd}
          onRemove={onRemove}
          mobile={mobile}
        />
      </div>
      <div
        id={`${baseId}-panel-option`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-option`}
        hidden={tab !== 'option'}
        className={styles.panel}
      >
        {/* Se monta al visitarla por primera vez y se conserva al cambiar de pestaña. */}
        {optionVisited && (
          <OptionBrowser
            mobile={mobile}
            mainUnderlying={mainUnderlyingOf(mainAsset)}
            addedIds={addedIds}
            full={full}
            onAdd={onAdd}
          />
        )}
      </div>
    </>
  );
}

export default function OverlayPicker({ open, mobile = false, state, mainAsset, timeframeLabel, onAdd, onRemove, onClose }) {
  const [tab, setTabState] = useState('asset');
  const [optionVisited, setOptionVisited] = useState(false);
  const dialogRef = useRef(null);
  const count = state?.items?.length ?? 0;

  const setTab = (t) => {
    setTabState(t);
    if (t === 'option') setOptionVisited(true);
  };

  // Cada apertura empieza en "Activo" con el navegador de opciones desmontado
  // (así se corta cualquier sondeo de strikes al cerrar).
  useEffect(() => {
    if (open) return;
    setTabState('asset');
    setOptionVisited(false);
  }, [open]);

  // Escritorio: Esc cierra (BottomSheet gestiona Esc en móvil).
  useEffect(() => {
    if (!open || mobile) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, mobile, onClose]);

  // Al abrir, el foco entra (buscador del catálogo o el propio diálogo) y al
  // cerrar vuelve a quien lo tenía ("Superponer"/"Añadir").
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    if (!mobile) {
      const dialog = dialogRef.current;
      (dialog?.querySelector('input[type="search"]') ?? dialog)?.focus();
    }
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, mobile]);

  // Trampa de foco del modal: Tab y Mayús+Tab no salen del diálogo.
  const trapTab = (e) => {
    if (e.key !== 'Tab') return;
    const nodes = [...dialogRef.current.querySelectorAll(FOCUSABLE)]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]'));
    if (nodes.length === 0) { e.preventDefault(); return; }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current || !nodes.includes(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !nodes.includes(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  const body = (
    <PickerBody
      open={open}
      mobile={mobile}
      state={state}
      mainAsset={mainAsset}
      onAdd={onAdd}
      onRemove={onRemove}
      tab={tab}
      setTab={setTab}
      optionVisited={optionVisited}
    />
  );

  if (mobile) {
    return (
      <BottomSheet open title="Superponer" onClose={onClose}>
        <div className={styles.mobileRoot}>
          <span className={styles.counter}>{`${count} de ${MAX_OVERLAYS}`}</span>
          {body}
        </div>
      </BottomSheet>
    );
  }

  const mainLabel = mainAsset ? shortLabel({ kind: 'asset', asset: mainAsset }) : '';
  const title = `Superponer en ${mainLabel}${timeframeLabel ? ` · ${timeframeLabel}` : ''}`;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <span className={styles.counter}>{`${count} de ${MAX_OVERLAYS} en uso`}</span>
          <span className={styles.grow} />
          <button type="button" className={styles.closeBtn} aria-label="Cerrar" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className={styles.dialogBody}>{body}</div>
        <footer className={styles.footer}>
          <span>La prima se dibuja en USD · se pueden añadir varias sin cerrar</span>
          <span className={styles.grow} />
          <button type="button" className={styles.doneBtn} onClick={onClose}>Listo</button>
        </footer>
      </div>
    </div>
  );
}
