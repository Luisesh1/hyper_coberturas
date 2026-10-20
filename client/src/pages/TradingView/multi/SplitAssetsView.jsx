// Modo Multi‑activo: pantalla dividida con hasta 4 activos independientes
// (cada panel con su activo y su temporalidad) y puntero compartido opcional
// que sincroniza solo el tiempo.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AssetPickerModal from '../components/AssetPickerModal';
import { ChevronLeftIcon } from '../components/icons';
import SyncedChart from './SyncedChart';
import { LAYOUTS, formatSyncTime, loadSplitPrefs, saveSplitPrefs } from './crosshairSync';
import { Legend, SyncSwitch, TOUCH_HINT } from './MultiControls';
import usePointerSync from './usePointerSync';
import styles from './MultiTimeframePage.module.css';

const toAsset = (p) => ({ symbol: p.symbol, datasource: p.datasource, name: p.symbol });

export default function SplitAssetsView({ isMobile, indicators, modeSwitch }) {
  const [prefs, setPrefs] = useState(loadSplitPrefs);
  // Índice del panel cuyo activo se está eligiendo (null = cerrado).
  const [pickerIndex, setPickerIndex] = useState(null);

  const updatePrefs = useCallback((patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch(prev) };
      saveSplitPrefs(next);
      return next;
    });
  }, []);

  const listKey = isMobile ? 'mobilePanels' : 'panels';
  const layout = LAYOUTS.find((l) => l.id === prefs.layout) || LAYOUTS[LAYOUTS.length - 1];
  const visible = isMobile ? prefs.mobilePanels : prefs.panels.slice(0, layout.count);
  const syncEnabled = prefs.sync === true;
  const { sync, setSync, onPointer } = usePointerSync(syncEnabled);

  const activeSync = syncEnabled && sync && sync.sourceIndex < visible.length ? sync : null;
  useEffect(() => {
    if (sync && !activeSync) setSync(null);
  }, [sync, activeSync, setSync]);

  const source = activeSync ? visible[activeSync.sourceIndex] : null;
  const pointerLabel = source
    ? `Puntero: ${formatSyncTime(activeSync.timeSec)} · ${source.symbol} ${source.timeframe}`
    : 'Puntero: —';

  const updatePanel = (i, patch) => {
    updatePrefs((prev) => {
      const list = [...prev[listKey]];
      list[i] = { ...list[i], ...patch };
      return { [listKey]: list };
    });
  };

  const handleSelectAsset = (next) => {
    const i = pickerIndex;
    setPickerIndex(null);
    if (i == null) return;
    updatePanel(i, { symbol: next.symbol, datasource: next.datasource });
    // El origen pasa a otro activo: su instante ya no vale para los demás.
    if (sync?.sourceIndex === i) setSync(null);
  };

  const toggleSync = () => {
    setSync(null);
    updatePrefs((prev) => ({ sync: !prev.sync }));
  };

  const panels = visible.map((p, i) => (
    <div key={i} className={styles.panel}>
      <SyncedChart
        asset={toAsset(p)}
        timeframe={p.timeframe}
        onTimeframeChange={(tf) => updatePanel(i, { timeframe: tf })}
        onAssetClick={setPickerIndex}
        index={i}
        syncEnabled={syncEnabled}
        syncPrice={false}
        sync={activeSync}
        onPointer={onPointer}
        indicators={indicators || undefined}
        compact={isMobile}
      />
    </div>
  ));

  const picker = (
    <AssetPickerModal
      open={pickerIndex != null}
      currentAsset={toAsset(visible[pickerIndex ?? 0] || visible[0])}
      onSelect={handleSelectAsset}
      onCancel={() => setPickerIndex(null)}
    />
  );

  if (isMobile) {
    return (
      <div className={styles.page}>
        <header className={styles.mHeader}>
          <Link to="/trading-view" className={styles.mBack} aria-label="Volver al gráfico único">
            <ChevronLeftIcon />
          </Link>
          <div className={styles.mTitle}>
            <span className={styles.mTitleMain}>Pantalla dividida</span>
            <span className={styles.mTitleSub}>Toca un símbolo para cambiarlo</span>
          </div>
          <SyncSwitch checked={syncEnabled} onToggle={toggleSync} label="Sync" className={styles.mSync} />
        </header>
        <div className={styles.mModeRow}>{modeSwitch(true)}</div>
        <div className={styles.mStack}>{panels}</div>
        <footer className={styles.mBar}>
          <div className={styles.mPointer} aria-live="off">{pointerLabel}</div>
          {syncEnabled && <Legend className={styles.mLegend} />}
          <div className={styles.mHint}>{TOUCH_HINT}</div>
        </footer>
        {picker}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        {modeSwitch(false)}
        <Link to="/trading-view" className={styles.btn}>
          <ChevronLeftIcon size={14} />
          <span>Gráfico único</span>
        </Link>
        <div className={styles.layoutGroup} role="group" aria-label="Distribución">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`${styles.layoutBtn} ${l.id === layout.id ? styles.layoutBtnActive : ''}`}
              aria-pressed={l.id === layout.id}
              onClick={() => updatePrefs(() => ({ layout: l.id }))}
            >
              {l.label}
            </button>
          ))}
        </div>
        <SyncSwitch checked={syncEnabled} onToggle={toggleSync} label="Puntero sincronizado (tiempo)" />
        <span className={styles.pointer}>{pointerLabel}</span>
        {syncEnabled && <Legend />}
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
