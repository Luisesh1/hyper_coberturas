import {
  BUILTIN_OVERLAYS,
  RANGE_OPTIONS,
  TIMEFRAMES,
  blankOverlay,
} from './backtesting-utils';
import styles from '../../pages/BacktestingPage.module.css';

function BacktestForm({
  form,
  setForm,
  strategies,
  indicators,
  assetSuggestions,
  isRunning,
  isLoading,
  onSubmit,
}) {
  const handleOverlayChange = (overlayId, patch) => {
    setForm((prev) => ({
      ...prev,
      overlays: prev.overlays.map((overlay) =>
        overlay.id === overlayId ? { ...overlay, ...patch } : overlay
      ),
    }));
  };

  const handleAddOverlay = (kind) => {
    setForm((prev) => ({
      ...prev,
      overlays: [...prev.overlays, blankOverlay(kind)],
    }));
  };

  const handleRemoveOverlay = (overlayId) => {
    setForm((prev) => ({
      ...prev,
      overlays: prev.overlays.filter((overlay) => overlay.id !== overlayId),
    }));
  };

  return (
    <form className={styles.configPanel} onSubmit={onSubmit}>
      <div className={styles.panelHeader}>
        <div>
          <h2>Configuracion de simulacion</h2>
          <p>Replica el flujo del bot con sizing USD, cierre por vela y protecciones intrabar.</p>
        </div>
        <button className={styles.primaryBtn} type="submit" disabled={isRunning || isLoading}>
          {isRunning ? 'Simulando...' : 'Simular backtest'}
        </button>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Estrategia</span>
          <select
            aria-label="Estrategia"
            value={form.strategyId}
            onChange={(event) => setForm((prev) => ({ ...prev, strategyId: event.target.value }))}
          >
            <option value="">Selecciona</option>
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>{strategy.name}</option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span>Asset</span>
          <input
            aria-label="Asset"
            list="backtesting-assets"
            value={form.asset}
            onChange={(event) => setForm((prev) => ({ ...prev, asset: event.target.value.toUpperCase() }))}
          />
          <datalist id="backtesting-assets">
            {assetSuggestions.map((asset) => <option key={asset} value={asset} />)}
          </datalist>
        </label>

        <label className={styles.field}>
          <span>Timeframe</span>
          <select
            aria-label="Timeframe"
            value={form.timeframe}
            onChange={(event) => setForm((prev) => ({ ...prev, timeframe: event.target.value }))}
          >
            {TIMEFRAMES.map((tf) => <option key={tf.value} value={tf.value}>{tf.label}</option>)}
          </select>
        </label>

        <label className={styles.field}>
          <span>Sizing mode</span>
          <select
            aria-label="Sizing mode"
            value={form.sizingMode}
            onChange={(event) => setForm((prev) => ({ ...prev, sizingMode: event.target.value }))}
          >
            <option value="usd">USD fijo</option>
            <option value="pct_equity">% Equity</option>
          </select>
        </label>

        {form.sizingMode === 'pct_equity' ? (
          <label className={styles.field}>
            <span>% Equity</span>
            <input
              aria-label="% Equity"
              type="number"
              min="0.1"
              max="100"
              step="0.5"
              value={form.pctEquity}
              onChange={(event) => setForm((prev) => ({ ...prev, pctEquity: event.target.value }))}
            />
          </label>
        ) : (
          <label className={styles.field}>
            <span>Monto USD</span>
            <input
              aria-label="Monto USD"
              type="number"
              min="1"
              step="1"
              value={form.sizeUsd}
              onChange={(event) => setForm((prev) => ({ ...prev, sizeUsd: event.target.value }))}
            />
          </label>
        )}

        <label className={styles.field}>
          <span>Leverage</span>
          <input
            aria-label="Leverage"
            type="number"
            min="1"
            step="1"
            value={form.leverage}
            onChange={(event) => setForm((prev) => ({ ...prev, leverage: event.target.value }))}
          />
        </label>

        <label className={styles.field}>
          <span>Margin mode</span>
          <select
            aria-label="Margin mode"
            value={form.marginMode}
            onChange={(event) => setForm((prev) => ({ ...prev, marginMode: event.target.value }))}
          >
            <option value="cross">cross</option>
            <option value="isolated">isolated</option>
          </select>
        </label>

        <label className={styles.field}>
          <span>Stop loss %</span>
          <input
            aria-label="Stop loss %"
            type="number"
            step="0.1"
            value={form.stopLossPct}
            onChange={(event) => setForm((prev) => ({ ...prev, stopLossPct: event.target.value }))}
          />
        </label>

        <label className={styles.field}>
          <span>Take profit %</span>
          <input
            aria-label="Take profit %"
            type="number"
            step="0.1"
            value={form.takeProfitPct}
            onChange={(event) => setForm((prev) => ({ ...prev, takeProfitPct: event.target.value }))}
          />
        </label>

        <label className={styles.field}>
          <span>Fee bps</span>
          <input
            aria-label="Fee bps"
            type="number"
            min="0"
            step="0.1"
            value={form.feeBps}
            onChange={(event) => setForm((prev) => ({ ...prev, feeBps: event.target.value }))}
          />
        </label>

        <label className={styles.field}>
          <span>Slippage bps</span>
          <input
            aria-label="Slippage bps"
            type="number"
            min="0"
            step="0.1"
            value={form.slippageBps}
            onChange={(event) => setForm((prev) => ({ ...prev, slippageBps: event.target.value }))}
          />
        </label>

        <label className={styles.field}>
          <span>Quick range</span>
          <select
            aria-label="Quick range"
            value={form.rangeMode}
            onChange={(event) => setForm((prev) => ({ ...prev, rangeMode: event.target.value }))}
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option === 'custom' ? 'custom' : `${option} velas`}</option>
            ))}
          </select>
        </label>

        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span>Parametros estrategia (JSON)</span>
          <textarea
            aria-label="Parametros estrategia (JSON)"
            rows={6}
            value={form.params}
            onChange={(event) => setForm((prev) => ({ ...prev, params: event.target.value }))}
          />
        </label>

        {form.rangeMode === 'custom' && (
          <>
            <label className={styles.field}>
              <span>Desde</span>
              <input
                aria-label="Desde"
                type="datetime-local"
                value={form.from}
                onChange={(event) => setForm((prev) => ({ ...prev, from: event.target.value }))}
              />
            </label>
            <label className={styles.field}>
              <span>Hasta</span>
              <input
                aria-label="Hasta"
                type="datetime-local"
                value={form.to}
                onChange={(event) => setForm((prev) => ({ ...prev, to: event.target.value }))}
              />
            </label>
          </>
        )}
      </div>

      <div className={styles.overlaySection}>
        <div className={styles.panelHeader}>
          <div>
            <h3>Overlays</h3>
            <p>Activa indicadores built-in o custom y decide si van sobre precio o en un panel separado.</p>
          </div>
          <div className={styles.inlineActions}>
            <button className={styles.secondaryBtn} type="button" onClick={() => handleAddOverlay('builtin')}>Agregar built-in</button>
            <button className={styles.secondaryBtn} type="button" onClick={() => handleAddOverlay('custom')}>Agregar custom</button>
          </div>
        </div>

        <div className={styles.overlayList}>
          {form.overlays.map((overlay) => (
            <div key={overlay.id} className={styles.overlayRow}>
              <label className={styles.field}>
                <span>Tipo</span>
                <select value={overlay.kind} onChange={(event) => handleOverlayChange(overlay.id, { kind: event.target.value, slug: event.target.value === 'builtin' ? 'ema' : '' })}>
                  <option value="builtin">builtin</option>
                  <option value="custom">custom</option>
                </select>
              </label>
              <label className={styles.field}>
                <span>Indicador</span>
                <select value={overlay.slug} onChange={(event) => handleOverlayChange(overlay.id, { slug: event.target.value })}>
                  <option value="">Selecciona</option>
                  {(overlay.kind === 'builtin' ? BUILTIN_OVERLAYS : indicators.map((item) => item.slug)).map((slug) => (
                    <option key={slug} value={slug}>{slug}</option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>Pane</span>
                <select value={overlay.pane} onChange={(event) => handleOverlayChange(overlay.id, { pane: event.target.value })}>
                  <option value="price">price</option>
                  <option value="separate">separate</option>
                </select>
              </label>
              <label className={`${styles.field} ${styles.fieldWide}`}>
                <span>Params JSON</span>
                <textarea rows={4} value={overlay.params} onChange={(event) => handleOverlayChange(overlay.id, { params: event.target.value })} />
              </label>
              <button className={styles.ghostBtn} type="button" onClick={() => handleRemoveOverlay(overlay.id)}>Quitar</button>
            </div>
          ))}
        </div>
      </div>
    </form>
  );
}

export default BacktestForm;
