import {
  PRESETS,
  RANGE_OPTIONS,
  TIMEFRAMES,
} from '../../../components/Backtesting/backtesting-utils';
import ConfigSection from './ConfigSection';
import OverlayManager from './OverlayManager';
import styles from './ConfigDrawer.module.css';

function ConfigDrawer({
  form,
  setForm,
  strategies,
  indicators,
  assetSuggestions,
  selectedStrategy,
  onApplyPreset,
  onResetParams,
  onClose,
}) {
  const set = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));
  const setUpper = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value.toUpperCase() }));

  return (
    <aside className={styles.drawer}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Configuracion</span>
        <button type="button" className={styles.closeBtn} onClick={onClose}>&times;</button>
      </div>

      <div className={styles.presets}>
        <button
          type="button"
          className={styles.presetBtn}
          onClick={() => onApplyPreset(PRESETS.rapido)}
        >
          Rapido
        </button>
        <button
          type="button"
          className={styles.presetBtn}
          onClick={() => onApplyPreset(PRESETS.completo)}
        >
          Completo
        </button>
      </div>

      <div className={styles.sections}>
        <ConfigSection title="Escenario basico" defaultOpen>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Estrategia</span>
              <select value={form.strategyId} onChange={set('strategyId')}>
                <option value="">Selecciona</option>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Asset</span>
              <input
                list="bt-assets"
                value={form.asset}
                onChange={setUpper('asset')}
              />
              <datalist id="bt-assets">
                {assetSuggestions.map((a) => <option key={a} value={a} />)}
              </datalist>
            </label>
            <label className={styles.field}>
              <span>Timeframe</span>
              <select value={form.timeframe} onChange={set('timeframe')}>
                {TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>Sizing</span>
              <select value={form.sizingMode} onChange={set('sizingMode')}>
                <option value="usd">USD fijo</option>
                <option value="pct_equity">% Equity</option>
              </select>
            </label>
            {form.sizingMode === 'pct_equity' ? (
              <label className={styles.field}>
                <span>% Equity</span>
                <input type="number" min="0.1" max="100" step="0.5" value={form.pctEquity} onChange={set('pctEquity')} />
              </label>
            ) : (
              <label className={styles.field}>
                <span>Monto USD</span>
                <input type="number" min="1" step="1" value={form.sizeUsd} onChange={set('sizeUsd')} />
              </label>
            )}
            <label className={styles.field}>
              <span>Leverage</span>
              <input type="number" min="1" step="1" value={form.leverage} onChange={set('leverage')} />
            </label>
          </div>
        </ConfigSection>

        <ConfigSection title="Protecciones y costos">
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Margin</span>
              <select value={form.marginMode} onChange={set('marginMode')}>
                <option value="cross">cross</option>
                <option value="isolated">isolated</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>SL %</span>
              <input type="number" step="0.1" value={form.stopLossPct} onChange={set('stopLossPct')} placeholder="—" />
            </label>
            <label className={styles.field}>
              <span>TP %</span>
              <input type="number" step="0.1" value={form.takeProfitPct} onChange={set('takeProfitPct')} placeholder="—" />
            </label>
            <label className={styles.field}>
              <span>Fee bps</span>
              <input type="number" min="0" step="0.1" value={form.feeBps} onChange={set('feeBps')} />
            </label>
            <label className={styles.field}>
              <span>Slippage bps</span>
              <input type="number" min="0" step="0.1" value={form.slippageBps} onChange={set('slippageBps')} />
            </label>
          </div>
        </ConfigSection>

        <ConfigSection title="Rango temporal">
          <div className={styles.pillGroup}>
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                className={`${styles.pill} ${form.rangeMode === opt ? styles.pillActive : ''}`}
                onClick={() => setForm((p) => ({ ...p, rangeMode: opt }))}
              >
                {opt === 'custom' ? 'Custom' : `${opt} velas`}
              </button>
            ))}
          </div>
          {form.rangeMode === 'custom' && (
            <div className={styles.grid} style={{ marginTop: 10 }}>
              <label className={styles.field}>
                <span>Desde</span>
                <input type="datetime-local" value={form.from} onChange={set('from')} />
              </label>
              <label className={styles.field}>
                <span>Hasta</span>
                <input type="datetime-local" value={form.to} onChange={set('to')} />
              </label>
            </div>
          )}
        </ConfigSection>

        <ConfigSection title="Parametros estrategia">
          <textarea
            className={styles.paramsTextarea}
            rows={5}
            value={form.params}
            onChange={set('params')}
          />
          {selectedStrategy?.defaultParams && (
            <button type="button" className={styles.ghostBtn} onClick={onResetParams}>
              Restaurar defaults
            </button>
          )}
        </ConfigSection>

        <ConfigSection title="Overlays">
          <OverlayManager
            overlays={form.overlays}
            indicators={indicators}
            onChange={(overlays) => setForm((p) => ({ ...p, overlays }))}
          />
        </ConfigSection>
      </div>
    </aside>
  );
}

export default ConfigDrawer;
