import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { alertsApi } from '../../services/api';
import { useTradingContext } from '../../context/TradingContext';
import { AlertRuleRow, emptyCondition } from './components/AlertRuleRow';
import AssetPickerModal from './components/AssetPickerModal';
import { COOLDOWN_PRESETS, cooldownLabel } from './lib/labels';
import { PRESETS } from './lib/presets';
import styles from './AlertsPage.module.css';

const DATASOURCES = [
  { value: 'binance',     label: 'Binance (ej. BTCUSDT)' },
  { value: 'hyperliquid', label: 'Hyperliquid (ej. BTC)' },
  { value: 'yahoo',       label: 'Yahoo Finance' },
];

function emptyRule() {
  return {
    id: `r-${Math.random().toString(36).slice(2, 9)}`,
    conditions: [emptyCondition()],
    joiners: [],
    weight: 1,
  };
}

// Normaliza una regla cargada desde el server (que puede ser legacy plana o
// la nueva forma con conditions/joiners) a la forma que espera el editor.
function normalizeLoadedRule(raw) {
  const base = { ...emptyRule() };
  if (raw && Array.isArray(raw.conditions) && raw.conditions.length > 0) {
    return {
      ...base,
      conditions: raw.conditions.map((c) => ({ ...emptyCondition(), ...c })),
      joiners: Array.isArray(raw.joiners) ? raw.joiners.slice() : [],
      weight: Number(raw.weight) || 1,
    };
  }
  if (raw && raw.indicatorType) {
    const cond = {
      indicatorType: raw.indicatorType,
      indicatorParams: { ...(raw.indicatorParams || {}) },
      timeframe: raw.timeframe,
      operandSeries: raw.operandSeries,
      operator: raw.operator,
      operand: raw.operand ? { ...raw.operand } : { kind: 'constant', value: 0 },
    };
    return { ...base, conditions: [cond], joiners: [], weight: Number(raw.weight) || 1 };
  }
  return base;
}

function emptyForm() {
  return {
    name: '',
    isActive: true,
    thresholdPercent: 70,
    cooldownSeconds: 900,
    telegramEnabled: true,
    datasource: 'binance',
    assetList: ['BTCUSDT'],
    rules: [emptyRule()],
  };
}

export default function AlertsPage() {
  const { addNotification } = useTradingContext();
  const [alerts, setAlerts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTogglingActive, setIsTogglingActive] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [assetInput, setAssetInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Marca-aguada del form al cargarlo, para detectar cambios sin guardar.
  // Comparamos por JSON-stringify: simple y suficiente para forms pequeños.
  const baselineRef = useRef(JSON.stringify(emptyForm()));
  const isDirty = useMemo(() => JSON.stringify(form) !== baselineRef.current, [form]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await alertsApi.list();
      setAlerts(data || []);
    } catch (err) {
      addNotification?.('error', `Error al cargar alertas: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [addNotification]);

  useEffect(() => { loadData(); }, [loadData]);

  const applyForm = useCallback((next) => {
    setForm(next);
    baselineRef.current = JSON.stringify(next);
  }, []);

  const selectAlert = useCallback((alert) => {
    if (!alert) {
      setSelectedId(null);
      applyForm(emptyForm());
      setTestResult(null);
      return;
    }
    setSelectedId(alert.id);
    applyForm({
      name: alert.name,
      isActive: alert.isActive,
      thresholdPercent: Number(alert.thresholdPercent),
      cooldownSeconds: Number(alert.cooldownSeconds),
      telegramEnabled: alert.telegramEnabled,
      datasource: alert.datasource,
      assetList: Array.isArray(alert.assetList) ? alert.assetList.slice() : [],
      rules: Array.isArray(alert.rules) && alert.rules.length > 0
        ? alert.rules.map(normalizeLoadedRule)
        : [emptyRule()],
    });
    setTestResult(null);
  }, [applyForm]);

  const applyPreset = useCallback((preset) => {
    setSelectedId(null);
    const built = preset.build({ asset: 'BTCUSDT', timeframe: '15m' });
    applyForm({
      ...emptyForm(),
      ...built,
      rules: (built.rules || []).map(normalizeLoadedRule),
    });
    setTestResult(null);
  }, [applyForm]);

  const updateField = (key, value) => setForm((p) => ({ ...p, [key]: value }));
  const updateRule = (idx, next) => {
    setForm((p) => {
      const rules = p.rules.slice();
      rules[idx] = next;
      return { ...p, rules };
    });
  };
  const removeRule = (idx) => {
    setForm((p) => ({ ...p, rules: p.rules.filter((_, i) => i !== idx) }));
  };
  const addRule = () => setForm((p) => ({ ...p, rules: [...p.rules, emptyRule()] }));

  const addAsset = () => {
    const value = assetInput.trim().toUpperCase();
    if (!value) return;
    if (form.assetList.includes(value)) return;
    setForm((p) => ({ ...p, assetList: [...p.assetList, value] }));
    setAssetInput('');
  };
  const removeAsset = (asset) => {
    setForm((p) => ({ ...p, assetList: p.assetList.filter((a) => a !== asset) }));
  };
  const addAssetsBulk = (symbols, datasource) => {
    if (!Array.isArray(symbols) || symbols.length === 0) return;
    setForm((p) => {
      const set = new Set(p.assetList);
      let added = 0;
      for (const s of symbols) {
        const norm = String(s || '').trim().toUpperCase();
        if (norm && !set.has(norm)) { set.add(norm); added += 1; }
      }
      // Si todos los nuevos vienen de un mismo proveedor distinto, lo
      // sincronizamos automáticamente (caso típico: usuario eligió Top 20
      // de Hyperliquid pero la alerta estaba en binance).
      const nextDatasource = datasource && datasource !== p.datasource ? datasource : p.datasource;
      addNotification?.('success', `${added} activo${added === 1 ? '' : 's'} agregado${added === 1 ? '' : 's'}`);
      return { ...p, assetList: Array.from(set), datasource: nextDatasource };
    });
  };

  const buildPayload = () => ({
    name: form.name.trim(),
    isActive: form.isActive,
    thresholdPercent: Number(form.thresholdPercent),
    cooldownSeconds: Number(form.cooldownSeconds),
    telegramEnabled: form.telegramEnabled,
    datasource: form.datasource,
    assetList: form.assetList.slice(),
    rules: form.rules.map((r) => ({
      conditions: (r.conditions || []).map((c) => ({
        indicatorType: c.indicatorType,
        indicatorParams: c.indicatorParams || {},
        timeframe: c.timeframe,
        operandSeries: c.operandSeries,
        operator: c.operator,
        operand: c.operand,
      })),
      joiners: r.joiners || [],
      weight: Number(r.weight) || 0,
    })),
  });

  const validationError = useMemo(() => {
    if (!form.name.trim()) return 'Falta el nombre de la alerta';
    if (form.assetList.length === 0) return 'Agrega al menos un activo';
    if (form.rules.length === 0) return 'Agrega al menos una regla';
    for (const [i, r] of form.rules.entries()) {
      const conds = Array.isArray(r.conditions) ? r.conditions : [];
      if (conds.length === 0) return `Regla #${i + 1} no tiene condiciones`;
      if (!conds.every((c) => c.indicatorType && c.timeframe && c.operator)) {
        return `Regla #${i + 1} tiene condiciones incompletas`;
      }
    }
    return null;
  }, [form]);

  const save = async () => {
    if (validationError) {
      addNotification?.('error', validationError);
      return;
    }
    setIsSaving(true);
    try {
      const payload = buildPayload();
      if (selectedId) {
        const updated = await alertsApi.update(selectedId, payload);
        addNotification?.('success', 'Alerta actualizada');
        await loadData();
        selectAlert(updated);
      } else {
        const created = await alertsApi.create(payload);
        addNotification?.('success', 'Alerta creada');
        await loadData();
        selectAlert(created);
      }
    } catch (err) {
      addNotification?.('error', `Error al guardar: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!window.confirm(`¿Eliminar la alerta "${form.name}"?`)) return;
    try {
      await alertsApi.remove(selectedId);
      addNotification?.('success', 'Alerta eliminada');
      await loadData();
      selectAlert(null);
    } catch (err) {
      addNotification?.('error', `Error al eliminar: ${err.message}`);
    }
  };

  const toggleActive = async () => {
    if (!selectedId || isDirty) return;
    const nextIsActive = !form.isActive;
    setIsTogglingActive(true);
    try {
      const payload = { ...buildPayload(), isActive: nextIsActive };
      const updated = await alertsApi.update(selectedId, payload);
      addNotification?.('success', nextIsActive ? 'Alerta activada' : 'Alerta desactivada');
      await loadData();
      selectAlert(updated);
    } catch (err) {
      addNotification?.('error', `Error al ${nextIsActive ? 'activar' : 'desactivar'}: ${err.message}`);
    } finally {
      setIsTogglingActive(false);
    }
  };

  const testNow = async ({ dryRun = true } = {}) => {
    if (!selectedId) {
      addNotification?.('error', 'Guarda la alerta antes de probarla');
      return;
    }
    try {
      const data = await alertsApi.test(selectedId, { dryRun });
      setTestResult(data);
      if (!dryRun) addNotification?.('success', 'Test enviado a Telegram para los activos que cumplen');
    } catch (err) {
      addNotification?.('error', `Error al probar: ${err.message}`);
    }
  };

  const totals = useMemo(() => ({
    count: alerts.length,
    active: alerts.filter((a) => a.isActive).length,
  }), [alerts]);

  const totalWeight = form.rules.reduce((acc, r) => acc + (Number(r.weight) || 0), 0);
  const requiredWeight = (totalWeight * Number(form.thresholdPercent)) / 100;

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.heroLeft}>
          <button
            className={`${styles.newBtn} ${styles.sidebarToggle}`}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Abrir lista de alertas"
          >
            ☰
          </button>
          <div>
            <span className={styles.eyebrow}>🔔 Alertas</span>
            <h1 className={styles.title}>Alertas con reglas y peso</h1>
          </div>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}><strong>{totals.count}</strong><span>total</span></div>
          <div className={styles.stat}><strong>{totals.active}</strong><span>activas</span></div>
        </div>
      </div>

      <div className={styles.layout}>
        <div className={`${styles.sidebarWrap} ${sidebarOpen ? styles.sidebarWrapOpen : ''}`}>
          <div className={styles.sidebar}>
            <button className={styles.newBtn} onClick={() => { selectAlert(null); setSidebarOpen(false); }}>
              + Nueva alerta
            </button>
            {isLoading && <div className={styles.empty}>Cargando…</div>}
            {!isLoading && alerts.length === 0 && (
              <div className={styles.empty}>Aún no tienes alertas. Crea la primera.</div>
            )}
            {alerts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`${styles.alertItem} ${selectedId === a.id ? styles.alertItemActive : ''}`}
                onClick={() => { selectAlert(a); setSidebarOpen(false); }}
              >
                <span className={styles.alertItemName}>{a.name}</span>
                <span className={styles.alertItemMeta}>
                  <span className={`${styles.dot} ${a.isActive ? styles.dotOn : styles.dotOff}`} />
                  {a.assetList?.length || 0} activos · {a.rules?.length || 0} reglas · {a.thresholdPercent}%
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.editor}>
          {/* Banner contextual: presets si es alerta nueva sin tocar, o
              indicador "sin guardar" si el form está dirty. */}
          {!selectedId && !isDirty && (
            <div className={styles.presetsBanner}>
              <div className={styles.presetsHeader}>
                <div>
                  <h3 className={styles.sectionTitle} style={{ marginTop: 0 }}>Comienza con una plantilla</h3>
                  <span className={styles.presetsHint}>Elige un patrón común y ajústalo, o crea uno desde cero.</span>
                </div>
              </div>
              <div className={styles.presetsGrid}>
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={styles.presetCard}
                    onClick={() => applyPreset(p)}
                  >
                    <span className={styles.presetIcon}>{p.icon}</span>
                    <span className={styles.presetTitle}>{p.title}</span>
                    <span className={styles.presetDesc}>{p.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {isDirty && (
            <div className={styles.dirtyBanner}>
              ● Cambios sin guardar
              {selectedId && (
                <button
                  type="button"
                  className={styles.dirtyDiscardBtn}
                  onClick={() => {
                    const original = alerts.find((a) => a.id === selectedId);
                    if (original) selectAlert(original);
                  }}
                >
                  Descartar
                </button>
              )}
            </div>
          )}

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>General</h3>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label>Nombre</label>
                <input
                  className={styles.input}
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="Ej: BTC RSI sobreventa"
                />
              </div>
              <div className={styles.formField}>
                <label>Umbral (%)</label>
                <input
                  className={styles.input}
                  type="number" min="0" max="100" step="1"
                  value={form.thresholdPercent}
                  onChange={(e) => updateField('thresholdPercent', Number(e.target.value))}
                />
              </div>
              <div className={styles.formField}>
                <label>Cooldown ({cooldownLabel(form.cooldownSeconds)})</label>
                <div className={styles.chipRow}>
                  {COOLDOWN_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      className={`${styles.chipBtn} ${Number(form.cooldownSeconds) === p.value ? styles.chipBtnActive : ''}`}
                      onClick={() => updateField('cooldownSeconds', p.value)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.formField}>
                <label>Datasource</label>
                <select
                  className={styles.select}
                  value={form.datasource}
                  onChange={(e) => updateField('datasource', e.target.value)}
                >
                  {DATASOURCES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
              <div className={styles.formField}>
                <label>Estado</label>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => updateField('isActive', e.target.checked)}
                  />
                  Activa (evalúa al cierre de cada vela)
                </label>
              </div>
              <div className={styles.formField}>
                <label>Notificación</label>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={form.telegramEnabled}
                    onChange={(e) => updateField('telegramEnabled', e.target.checked)}
                  />
                  Enviar a Telegram (config en /config)
                </label>
              </div>
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>Activos a vigilar ({form.assetList.length})</h3>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSmall}`}
                onClick={() => setPickerOpen(true)}
              >
                + Agregar varios…
              </button>
            </div>
            <div className={styles.assetChips}>
              {form.assetList.map((a) => (
                <span key={a} className={styles.chip}>
                  {a}
                  <button type="button" className={styles.chipRemove} onClick={() => removeAsset(a)}>×</button>
                </span>
              ))}
              <input
                className={styles.chipInput}
                value={assetInput}
                placeholder={form.datasource === 'hyperliquid' ? 'BTC' : 'BTCUSDT'}
                onChange={(e) => setAssetInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                    e.preventDefault();
                    addAsset();
                  }
                }}
                onBlur={addAsset}
              />
            </div>
            <div className={styles.hint}>
              {form.datasource === 'binance' && 'Binance espera símbolos completos: BTCUSDT, ETHUSDT, SOLUSDT…'}
              {form.datasource === 'hyperliquid' && 'Hyperliquid espera el ticker corto: BTC, ETH, SOL…'}
              {form.datasource === 'yahoo' && 'Yahoo: usa el ticker tal cual (ej. AAPL, BTC-USD).'}
            </div>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Reglas ({form.rules.length}) — peso total {totalWeight} → requiere ≥ {requiredWeight.toFixed(1)}</h3>
            <div className={styles.rulesList}>
              {form.rules.map((rule, i) => (
                <AlertRuleRow
                  key={rule.id || i}
                  index={i}
                  rule={rule}
                  onChange={(next) => updateRule(i, next)}
                  onRemove={() => removeRule(i)}
                />
              ))}
              <button type="button" className={styles.addRuleBtn} onClick={addRule}>
                + Agregar regla
              </button>
            </div>
          </div>

          {testResult && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Resultado del test</h3>
              <div className={styles.testResult}>
                {testResult.results.map((r) => (
                  <div key={r.asset} className={styles.testAsset}>
                    <div className={styles.testAssetHead}>
                      <span className={styles.testAssetName}>{r.asset} · TF {r.lowestTimeframe}</span>
                      <span className={r.wouldTrigger ? styles.scoreOk : styles.scoreNo}>
                        {Number(r.score).toFixed(1)}% / {Number(r.threshold).toFixed(0)}%
                        {r.wouldTrigger ? ' ✓' : ' ✗'}
                      </span>
                    </div>
                    {r.suppressedBy === 'cooldown' && (
                      <span style={{ fontSize: 11, color: '#f59e0b' }}>
                        En cooldown — restan {Math.round(r.cooldownLeftMs / 1000)} s
                      </span>
                    )}
                    {r.triggered && r.telegramSent && (
                      <span style={{ fontSize: 11, color: '#22c55e' }}>📨 Enviado a Telegram</span>
                    )}
                    {r.rules?.map((rr, i) => (
                      <div
                        key={i}
                        className={`${styles.testRule} ${rr.matched ? styles.testRuleMatched : styles.testRuleUnmatched}`}
                      >
                        {rr.matched ? '✓' : '·'} {rr.reason}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={styles.actionBar}>
            {selectedId && (
              <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={remove} disabled={isSaving}>
                Eliminar
              </button>
            )}
            {selectedId && (
              <label
                className={`${styles.activeSwitch} ${form.isActive ? styles.activeSwitchOn : ''} ${(isSaving || isTogglingActive || isDirty) ? styles.activeSwitchDisabled : ''}`}
                title={isDirty ? 'Guarda o descarta los cambios antes de activar/desactivar' : ''}
              >
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={toggleActive}
                  disabled={isSaving || isTogglingActive || isDirty}
                />
                <span className={styles.activeSwitchTrack}>
                  <span className={styles.activeSwitchThumb} />
                  <span className={styles.activeSwitchText}>{form.isActive ? 'ON' : 'OFF'}</span>
                </span>
                <span className={styles.activeSwitchLabel}>
                  {isTogglingActive ? 'Actualizando…' : 'Alerta'}
                </span>
              </label>
            )}
            {selectedId && (
              <>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  onClick={() => testNow({ dryRun: true })}
                  disabled={isDirty}
                  title={isDirty ? 'Guarda primero los cambios para probar' : 'Evalúa la alerta con las últimas velas, sin enviar Telegram'}
                >
                  Probar (sin enviar)
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  onClick={() => testNow({ dryRun: false })}
                  disabled={isDirty}
                  title={isDirty ? 'Guarda primero los cambios para probar' : 'Evalúa y envía Telegram si supera el umbral'}
                >
                  Probar y enviar Telegram
                </button>
              </>
            )}
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={save}
              disabled={isSaving || !!validationError || (!isDirty && !!selectedId)}
              title={validationError || (!isDirty && selectedId ? 'No hay cambios para guardar' : '')}
            >
              {isSaving ? 'Guardando…' : (selectedId ? 'Guardar cambios' : 'Crear alerta')}
            </button>
          </div>
        </div>
      </div>

      <AssetPickerModal
        open={pickerOpen}
        currentAssets={form.assetList}
        currentDatasource={form.datasource}
        onAdd={addAssetsBulk}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
