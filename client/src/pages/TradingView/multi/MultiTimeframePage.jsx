import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { settingsApi } from '../../../services/api';
import { useTradingContext } from '../../../context/TradingContext';
import { getDefaultChartIndicators } from '../indicators/defaults';
import AssetPickerModal from '../components/AssetPickerModal';
import { ChevronDownIcon, ChevronLeftIcon } from '../components/icons';
import { MOBILE_QUERY, useMediaQuery } from '../useMediaQuery';
import { useFullscreen } from '../useFullscreen';
import SyncedChart from './SyncedChart';
import SplitAssetsView from './SplitAssetsView';
import { FullscreenButton, Legend, ModeSwitch, SyncSwitch, TOUCH_HINT } from './MultiControls';
import usePointerSync from './usePointerSync';
import { formatPrice } from './chartTheme';
import {
  LAYOUTS,
  MULTI_MODES,
  formatSyncTime,
  loadMultiMode,
  loadMultiPrefs,
  saveMultiMode,
  saveMultiPrefs,
} from './crosshairSync';
import styles from './MultiTimeframePage.module.css';

const ASSET_STORAGE_KEY = 'tv_selected_asset_v1';
// En móvil solo cabe la distribución 1×2: dos gráficos apilados.
const MOBILE_COUNT = 2;

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

export default function MultiTimeframePage() {
  const { selectedAsset, addNotification } = useTradingContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSymbol = searchParams.get('symbol');
  const urlDatasource = searchParams.get('datasource');
  const urlMode = MULTI_MODES.includes(searchParams.get('mode')) ? searchParams.get('mode') : null;
  const isMobile = useMediaQuery(MOBILE_QUERY);

  // Modo: ?mode=tf|assets manda; sin parámetro, el guardado (Multi‑TF por defecto).
  const [mode, setMode] = useState(() => urlMode || loadMultiMode());
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
  const shellRef = useRef(null);
  const { fullscreen, toggleFullscreen } = useFullscreen(shellRef);
  // Indicadores guardados en /trading-view (se editan allí). null = cargando.
  const [indicators, setIndicators] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await settingsApi.getChartIndicators();
        if (cancelled) return;
        const list = Array.isArray(res?.indicators) ? res.indicators : [];
        setIndicators(list.length > 0 ? list : getDefaultChartIndicators().indicators);
      } catch (err) {
        if (cancelled) return;
        setIndicators(getDefaultChartIndicators().indicators);
        addNotification?.('alert', `No se pudo cargar tu config de indicadores: ${err?.message || err}`);
      }
    })();
    return () => { cancelled = true; };
    // Solo al montar: la lista se edita en /trading-view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reaccionar a cambios del query (back/forward) sin remount.
  useEffect(() => {
    if (!urlSymbol) return;
    setAsset((prev) => (prev.symbol === urlSymbol && prev.datasource === (urlDatasource || prev.datasource)
      ? prev
      : { symbol: urlSymbol, datasource: urlDatasource || 'binance', name: urlSymbol }));
  }, [urlSymbol, urlDatasource]);

  useEffect(() => {
    if (urlMode) setMode(urlMode);
  }, [urlMode]);
  useEffect(() => {
    saveMultiMode(mode);
  }, [mode]);

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
  const { sync, setSync, onPointer } = usePointerSync(syncEnabled);

  // Precio de la barra superior: último cierre del panel 0. Se guarda con la
  // clave par+temporalidad, así al cambiar cualquiera de las dos deja de
  // mostrarse hasta que llega el precio nuevo.
  const priceKey = `${asset.symbol}|${asset.datasource}|${panelTimeframes[0]}`;
  const priceKeyRef = useRef(priceKey);
  priceKeyRef.current = priceKey;
  const [lastPrice, setLastPrice] = useState(null);
  const onLastPrice = useCallback((index, price) => {
    if (index !== 0) return;
    setLastPrice({ key: priceKeyRef.current, price });
  }, []);
  const shownPrice = lastPrice && lastPrice.key === priceKey ? formatPrice(lastPrice.price) : null;

  // Un origen que ya no existe (otra distribución) o sync apagado → sin puntero.
  const activeSync = syncEnabled && sync && sync.sourceIndex < panelTimeframes.length ? sync : null;
  useEffect(() => {
    if (sync && !activeSync) setSync(null);
  }, [sync, activeSync, setSync]);

  const changeMode = (next) => {
    if (next === mode) return;
    setSync(null);
    setMode(next);
    // Sin esto el ?mode= de la URL volvería a imponerse en back/forward.
    if (searchParams.has('mode')) {
      const params = new URLSearchParams(searchParams);
      params.delete('mode');
      setSearchParams(params, { replace: true });
    }
  };
  const modeSwitch = (mobile) => <ModeSwitch mode={mode} onChange={changeMode} mobile={mobile} />;
  const fullscreenButton = (mobile) => (
    <FullscreenButton active={fullscreen} onToggle={toggleFullscreen} mobile={mobile} />
  );
  // Contenedor común a los dos modos: cambiar de modo no saca de pantalla completa.
  const shell = (content) => (
    <div ref={shellRef} className={`${styles.shell} ${fullscreen ? styles.shellFullscreen : ''}`}>
      {content}
    </div>
  );

  if (mode === 'assets') {
    return shell(
      <SplitAssetsView
        isMobile={isMobile}
        indicators={indicators}
        modeSwitch={modeSwitch}
        fullscreenButton={fullscreenButton}
      />,
    );
  }

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
        onLastPrice={onLastPrice}
        indicators={indicators || undefined}
        compact={isMobile}
      />
    </div>
  ));

  const picker = (
    <AssetPickerModal
      open={pickerOpen}
      currentAsset={asset}
      onSelect={handleSelectAsset}
      onCancel={() => setPickerOpen(false)}
    />
  );

  if (isMobile) {
    return shell(
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
          {shownPrice && (
            <span className={styles.mPrice} data-testid="multi-price" title="Último precio (primer gráfico)">
              {shownPrice}
            </span>
          )}
          <SyncSwitch checked={syncEnabled} onToggle={toggleSync} label="Sync" className={styles.mSync} />
        </header>
        <div className={styles.mModeRow}>
          {modeSwitch(true)}
          {fullscreenButton(true)}
        </div>
        <div className={styles.mStack}>{panels}</div>
        <footer className={styles.mBar}>
          <div className={styles.mPointer} aria-live="off">{pointerLabel}</div>
          <Legend className={styles.mLegend} />
          <div className={styles.mHint}>{TOUCH_HINT}</div>
        </footer>
        {picker}
      </div>,
    );
  }

  return shell(
    <div className={styles.page}>
      <div className={styles.toolbar}>
        {modeSwitch(false)}
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
        {shownPrice && (
          <span className={styles.price} data-testid="multi-price" title="Último precio (primer gráfico)">
            {shownPrice}
          </span>
        )}
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
        <SyncSwitch checked={syncEnabled} onToggle={toggleSync} label="Puntero sincronizado" />
        <span className={styles.pointer}>{pointerLabel}</span>
        <Legend />
        {fullscreenButton(false)}
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
    </div>,
  );
}
