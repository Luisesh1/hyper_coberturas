import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTradingContext } from '../../../context/TradingContext';
import AssetPickerModal from '../components/AssetPickerModal';
import { ChevronDownIcon, ChevronLeftIcon } from '../components/icons';
import { MOBILE_QUERY, useMediaQuery } from '../useMediaQuery';
import SyncedChart from './SyncedChart';
import {
  LAYOUTS,
  SYNC_COLORS,
  formatSyncTime,
  loadMultiPrefs,
  saveMultiPrefs,
} from './crosshairSync';
import styles from './MultiTimeframePage.module.css';

const ASSET_STORAGE_KEY = 'tv_selected_asset_v1';
const MOBILE_COUNT = 3;
const TOUCH_HINT = 'Mantén pulsado y arrastra sobre un gráfico';

function loadStoredAsset() {
  try {
    const raw = localStorage.getItem(ASSET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.symbol && parsed?.datasource) return parsed;
    return null;
  } catch {
    return null;
  }
}

function storeAsset(asset) {
  try {
    localStorage.setItem(ASSET_STORAGE_KEY, JSON.stringify({
      symbol: asset.symbol, datasource: asset.datasource, name: asset.name,
    }));
  } catch { /* noop */ }
}

function Legend({ className }) {
  return (
    <span className={`${styles.legend} ${className || ''}`}>
      <span className={styles.legendItem}>
        <span className={styles.legendLine} style={{ borderTopStyle: 'solid', borderTopColor: SYNC_COLORS.exact }} />
        Misma apertura
      </span>
      <span className={styles.legendItem}>
        <span className={styles.legendLine} style={{ borderTopStyle: 'dashed', borderTopColor: SYNC_COLORS.near }} />
        Dentro de la vela
      </span>
    </span>
  );
}

export default function MultiTimeframePage() {
  const { selectedAsset } = useTradingContext();
  const [searchParams] = useSearchParams();
  const urlSymbol = searchParams.get('symbol');
  const urlDatasource = searchParams.get('datasource');
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const [prefs, setPrefs] = useState(loadMultiPrefs);
  const [asset, setAsset] = useState(() => {
    if (urlSymbol) {
      return { symbol: urlSymbol, datasource: urlDatasource || 'binance', name: urlSymbol };
    }
    return loadStoredAsset() || {
      symbol: selectedAsset || 'ETH',
      datasource: 'hyperliquid',
      name: selectedAsset || 'ETH',
    };
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sync, setSync] = useState(null);

  // Reaccionar a cambios del query (back/forward) sin remount.
  useEffect(() => {
    if (!urlSymbol) return;
    setAsset((prev) => (prev.symbol === urlSymbol && prev.datasource === (urlDatasource || prev.datasource)
      ? prev
      : { symbol: urlSymbol, datasource: urlDatasource || 'binance', name: urlSymbol }));
  }, [urlSymbol, urlDatasource]);

  // Móvil: sube el botón de logs de dev (misma clase que TradingView).
  useEffect(() => {
    if (!isMobile) return undefined;
    document.body.classList.add('tv-mobile-chrome');
    return () => document.body.classList.remove('tv-mobile-chrome');
  }, [isMobile]);

  const updatePrefs = useCallback((patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveMultiPrefs(next);
      return next;
    });
  }, []);

  const layout = LAYOUTS.find((l) => l.id === prefs.layout) || LAYOUTS[LAYOUTS.length - 1];
  const panelTimeframes = useMemo(
    () => (isMobile ? prefs.mobileTimeframes.slice(0, MOBILE_COUNT) : prefs.timeframes.slice(0, layout.count)),
    [isMobile, prefs.mobileTimeframes, prefs.timeframes, layout.count],
  );
  const syncEnabled = prefs.sync !== false;

  // Puntero: se agrupa por fotograma para no re-renderizar por cada píxel.
  const pendingRef = useRef(null);
  const rafRef = useRef(0);
  const scheduledRef = useRef(false);
  const onPointer = useCallback((index, p) => {
    pendingRef.current = { value: p ? { sourceIndex: index, ...p } : null };
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    rafRef.current = requestAnimationFrame(() => {
      scheduledRef.current = false;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) setSync(pending.value);
    });
  }, []);
  useEffect(() => () => {
    if (scheduledRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  // Un origen que ya no existe (otra distribución) o sync apagado → sin puntero.
  const activeSync = syncEnabled && sync && sync.sourceIndex < panelTimeframes.length ? sync : null;
  useEffect(() => {
    if (sync && !activeSync) setSync(null);
  }, [sync, activeSync]);

  const pointerLabel = activeSync
    ? `Puntero: ${formatSyncTime(activeSync.timeSec)} · ${panelTimeframes[activeSync.sourceIndex]}`
    : 'Puntero: —';

  const setLayout = (id) => updatePrefs({ layout: id });
  const toggleSync = () => {
    setSync(null);
    updatePrefs({ sync: !syncEnabled });
  };
  const changeTimeframe = (i, tf) => {
    const key = isMobile ? 'mobileTimeframes' : 'timeframes';
    const next = [...prefs[key]];
    next[i] = tf;
    updatePrefs({ [key]: next });
  };

  const handleSelectAsset = (next) => {
    setAsset({ symbol: next.symbol, datasource: next.datasource, name: next.name });
    storeAsset(next);
    setPickerOpen(false);
  };

  const panels = panelTimeframes.map((tf, i) => (
    <div key={i} className={styles.panel}>
      <SyncedChart
        asset={asset}
        timeframe={tf}
        onTimeframeChange={(next) => changeTimeframe(i, next)}
        index={i}
        syncEnabled={syncEnabled}
        sync={activeSync}
        onPointer={onPointer}
        compact={isMobile}
      />
    </div>
  ));

  const syncSwitch = (label, className) => (
    <button
      type="button"
      role="switch"
      aria-checked={syncEnabled}
      aria-label="Puntero sincronizado"
      className={`${styles.syncBtn} ${syncEnabled ? styles.syncBtnOn : ''} ${className || ''}`}
      onClick={toggleSync}
    >
      <span className={styles.syncKnob} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );

  const picker = (
    <AssetPickerModal
      open={pickerOpen}
      currentAsset={asset}
      onSelect={handleSelectAsset}
      onCancel={() => setPickerOpen(false)}
    />
  );

  if (isMobile) {
    return (
      <div className={styles.page}>
        <header className={styles.mHeader}>
          <Link to="/trading-view" className={styles.mBack} aria-label="Volver al gráfico único">
            <ChevronLeftIcon />
          </Link>
          <button
            type="button"
            className={styles.mAssetBtn}
            onClick={() => setPickerOpen(true)}
            aria-label={`Cambiar par (actual: ${asset.symbol})`}
          >
            <span className={styles.mAssetText}>
              <span className={styles.mAssetSymbol}>{asset.symbol}</span>
              <span className={styles.mAssetSource}>{asset.datasource}</span>
            </span>
            <ChevronDownIcon size={16} />
          </button>
          {syncSwitch('Sync', styles.mSync)}
        </header>
        <div className={styles.mStack}>{panels}</div>
        <footer className={styles.mBar}>
          <div className={styles.mPointer} aria-live="off">{pointerLabel}</div>
          <Legend className={styles.mLegend} />
          <div className={styles.mHint}>{TOUCH_HINT}</div>
        </footer>
        {picker}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Link to="/trading-view" className={styles.btn}>
          <ChevronLeftIcon size={14} />
          <span>Gráfico único</span>
        </Link>
        <button
          type="button"
          className={styles.assetButton}
          onClick={() => setPickerOpen(true)}
          aria-label={`Cambiar par (actual: ${asset.symbol})`}
          title={asset.name || asset.symbol}
        >
          <span className={styles.assetSymbol}>{asset.symbol}</span>
          <span className={styles.assetSource}>{asset.datasource}</span>
          <ChevronDownIcon size={14} />
        </button>
        <div className={styles.layoutGroup} role="group" aria-label="Distribución">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`${styles.layoutBtn} ${l.id === layout.id ? styles.layoutBtnActive : ''}`}
              aria-pressed={l.id === layout.id}
              onClick={() => setLayout(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        {syncSwitch('Puntero sincronizado')}
        <span className={styles.pointer}>{pointerLabel}</span>
        <Legend />
      </div>
      <div
        className={styles.grid}
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
        }}
      >
        {panels}
      </div>
      {picker}
    </div>
  );
}
