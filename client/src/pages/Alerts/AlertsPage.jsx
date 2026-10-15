import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { alertsApi } from '../../services/api';
import { useTradingContext } from '../../context/TradingContext';
import { MOBILE_QUERY, useMediaQuery } from '../TradingView/useMediaQuery';
import { AlertRuleRow, emptyCondition } from './components/AlertRuleRow';
import AssetPickerModal from './components/AssetPickerModal';
import { DirectionChip, DirectionIcon, DirectionSelector } from './components/Direction';
import { fetchAlertBotUsage } from './lib/autoBots';
import {
  DEFAULT_DIRECTION,
  DIRECTION_FILTERS,
  DIRECTION_META,
  botModeLabel,
  botOpensLabel,
  matchesDirectionFilter,
  normalizeDirection,
  telegramTitle,
} from './lib/direction';
import { COOLDOWN_PRESETS, cooldownLabel } from './lib/labels';
import { PRESETS } from './lib/presets';
import styles from './AlertsPage.module.css';

const NO_BOTS = [];
const TF_ORDER = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

const DATASOURCES = [
  { value: 'binance',     label: 'Binance (ej. BTCUSDT)' },
  { value: 'hyperliquid', label: 'Hyperliquid (ej. BTC)' },
  { value: 'yahoo',       label: 'Yahoo Finance' },
];

function emptyRule() {
  return {
    id: `r-${Math.random().toString(36).slice(2, 9)}`,
    label: '',
    conditions: [emptyCondition()],
    joiners: [],
    weight: 1,
  };
}

// Normaliza una regla cargada desde el server (que puede ser legacy plana o
// la nueva forma con conditions/joiners) a la forma que espera el editor.
function normalizeRuleWeight(value) {
  if (value == null || value === '') return 1;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 1;
}

export function normalizeLoadedRule(raw) {
  const base = { ...emptyRule() };
  if (raw && Array.isArray(raw.conditions) && raw.conditions.length > 0) {
    return {
      ...base,
      label: String(raw.label || ''),
      conditions: raw.conditions.map((c) => ({ ...emptyCondition(), ...c })),
      joiners: Array.isArray(raw.joiners) ? raw.joiners.slice() : [],
      weight: normalizeRuleWeight(raw.weight),
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
    return { ...base, label: String(raw.label || ''), conditions: [cond], joiners: [], weight: normalizeRuleWeight(raw.weight) };
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
    direction: DEFAULT_DIRECTION,
    optionExpiryMinDays: null,
    optionExpiryMaxDays: null,
    assetList: ['BTCUSDT'],
    rules: [emptyRule()],
  };
}

function getFormValidationError(value) {
  if (!value.name.trim()) return 'Falta el nombre de la alerta';
  if (value.assetList.length === 0) return 'Agrega al menos un activo';
  if (value.rules.length === 0) return 'Agrega al menos una regla';
  const minExpiry = value.optionExpiryMinDays;
  const maxExpiry = value.optionExpiryMaxDays;
  if ((minExpiry == null) !== (maxExpiry == null)) return 'Indica ambos límites del vencimiento o deja ambos vacíos';
  if (minExpiry != null && (!Number.isFinite(minExpiry) || !Number.isFinite(maxExpiry) || minExpiry <= 0 || maxExpiry > 180 || minExpiry > maxExpiry)) {
    return 'Vencimiento: mínimo mayor que cero, máximo hasta 180 días y mínimo no mayor al máximo';
  }
  for (const [i, r] of value.rules.entries()) {
    const conds = Array.isArray(r.conditions) ? r.conditions : [];
    if (conds.length === 0) return `Regla #${i + 1} no tiene condiciones`;
    if (!conds.every((c) => c.indicatorType && c.timeframe && c.operator)) {
      return `Regla #${i + 1} tiene condiciones incompletas`;
    }
  }
  return null;
}

function formToPayload(value) {
  return {
    name: value.name.trim(),
    isActive: value.isActive,
    thresholdPercent: Number(value.thresholdPercent),
    cooldownSeconds: Number(value.cooldownSeconds),
    telegramEnabled: value.telegramEnabled,
    datasource: value.datasource,
    direction: normalizeDirection(value.direction),
    optionExpiryMinDays: value.optionExpiryMinDays == null ? null : Number(value.optionExpiryMinDays),
    optionExpiryMaxDays: value.optionExpiryMaxDays == null ? null : Number(value.optionExpiryMaxDays),
    assetList: value.assetList.slice(),
    rules: value.rules.map((r) => ({
      label: String(r.label || '').trim(),
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
  };
}

export default function AlertsPage() {
  const { addNotification } = useTradingContext();
  const [alerts, setAlerts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTogglingActive, setIsTogglingActive] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [assetInput, setAssetInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  // En móvil se ve la lista o el editor a pantalla completa, no ambos.
  const [mobileView, setMobileView] = useState('list');
  const [directionFilter, setDirectionFilter] = useState('all');
  // Map alertId → bots que la usan. null = no disponible (se oculta sin error).
  const [botUsage, setBotUsage] = useState(null);
  const [editorMode, setEditorMode] = useState('visual');
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState('');
  const [rawTextDirty, setRawTextDirty] = useState(false);
  // Marca-aguada del form al cargarlo, para detectar cambios sin guardar.
  // Comparamos por JSON-stringify: simple y suficiente para forms pequeños.
  // Se inicializa con el mismo form del estado: `emptyRule()` genera ids
  // aleatorios y dos `emptyForm()` distintos parecían "sin guardar" (y
  // ocultaban las plantillas) al abrir la página.
  const baselineRef = useRef(null);
  if (baselineRef.current === null) baselineRef.current = JSON.stringify(form);
  const isDirty = useMemo(() => JSON.stringify(form) !== baselineRef.current, [form]);
  const effectiveDirty = isDirty || (editorMode === 'raw' && rawTextDirty);

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

  const loadBotUsage = useCallback(async () => {
    try {
      setBotUsage(await fetchAlertBotUsage());
    } catch {
      // Sin módulo de bots o error de red: «Usada por» simplemente no se muestra.
      setBotUsage(null);
    }
  }, []);

  useEffect(() => { loadBotUsage(); }, [loadBotUsage]);

  // El botón «Logs» de dev sube para no tapar el CTA fijo del editor móvil.
  const mobileEditor = isMobile && mobileView === 'editor';
  useEffect(() => {
    if (!mobileEditor) return undefined;
    document.body.classList.add('tv-mobile-chrome');
    return () => document.body.classList.remove('tv-mobile-chrome');
  }, [mobileEditor]);

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
      direction: normalizeDirection(alert.direction),
      optionExpiryMinDays: alert.optionExpiryMinDays ?? null,
      optionExpiryMaxDays: alert.optionExpiryMaxDays ?? null,
      assetList: Array.isArray(alert.assetList) ? alert.assetList.slice() : [],
      rules: Array.isArray(alert.rules) && alert.rules.length > 0
        ? alert.rules.map(normalizeLoadedRule)
        : [emptyRule()],
    });
    setTestResult(null);
    setEditorMode('visual');
    setRawText('');
    setRawError('');
    setRawTextDirty(false);
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
    setEditorMode('visual');
    setRawText('');
    setRawError('');
    setRawTextDirty(false);
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

  const buildPayload = () => formToPayload(form);

  const payloadToForm = (payload) => {
    const source = payload?.alert && typeof payload.alert === 'object' ? payload.alert : payload;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('El raw text debe ser un objeto JSON de alerta');
    }
    return {
      ...emptyForm(),
      name: String(source.name ?? '').trim(),
      isActive: source.isActive !== false,
      thresholdPercent: Number(source.thresholdPercent ?? 70),
      cooldownSeconds: Number(source.cooldownSeconds ?? 900),
      telegramEnabled: source.telegramEnabled !== false,
      datasource: source.datasource || 'binance',
      direction: normalizeDirection(source.direction),
      optionExpiryMinDays: source.optionExpiryMinDays ?? null,
      optionExpiryMaxDays: source.optionExpiryMaxDays ?? null,
      assetList: Array.isArray(source.assetList)
        ? source.assetList.map((asset) => String(asset || '').trim().toUpperCase()).filter(Boolean)
        : [],
      rules: Array.isArray(source.rules) && source.rules.length > 0
        ? source.rules.map(normalizeLoadedRule)
        : [emptyRule()],
    };
  };

  const formatRaw = (payload = buildPayload()) => JSON.stringify(payload, null, 2);

  const openRawMode = () => {
    setRawText(formatRaw());
    setRawError('');
    setRawTextDirty(false);
    setEditorMode('raw');
  };

  const refreshRawFromVisual = () => {
    setRawText(formatRaw());
    setRawError('');
    setRawTextDirty(false);
  };

  const openVisualMode = () => {
    setEditorMode('visual');
    setRawError('');
  };

  const applyRawText = ({ quiet = false } = {}) => {
    try {
      const parsed = JSON.parse(rawText);
      const next = payloadToForm(parsed);
      setForm(next);
      setRawText(formatRaw(formToPayload(next)));
      setRawError('');
      setRawTextDirty(false);
      setTestResult(null);
      if (!quiet) addNotification?.('success', 'Raw text aplicado al editor');
      return next;
    } catch (err) {
      setRawError(err.message || 'Raw text inválido');
      if (!quiet) addNotification?.('error', `Raw text inválido: ${err.message}`);
      return null;
    }
  };

  const copyRawText = async () => {
    const text = editorMode === 'raw' ? rawText : formatRaw();
    try {
      await navigator.clipboard.writeText(text);
      addNotification?.('success', 'Configuración copiada');
    } catch {
      setRawText(text);
      setEditorMode('raw');
      addNotification?.('error', 'No se pudo copiar automáticamente; el texto quedó abierto para copiarlo');
    }
  };

  const validationError = useMemo(() => getFormValidationError(form), [form]);
  const saveValidationError = editorMode === 'raw' && rawTextDirty ? null : validationError;

  const savedAlert = useMemo(() => alerts.find((a) => a.id === selectedId) || null, [alerts, selectedId]);
  const usedByBots = (selectedId != null && botUsage?.get(Number(selectedId))) || NO_BOTS;
  // Solo avisa al pasar a Neutral una alerta guardada con dirección y con bots.
  const willStopBots = (nextDirection) => (
    nextDirection === 'neutral'
    && usedByBots.length > 0
    && normalizeDirection(savedAlert?.direction) !== 'neutral'
  );
  const showNeutralWarning = willStopBots(normalizeDirection(form.direction));

  const save = async () => {
    const rawForm = editorMode === 'raw' && rawTextDirty ? applyRawText({ quiet: true }) : null;
    if (editorMode === 'raw' && rawTextDirty && !rawForm) return;
    const nextValidationError = getFormValidationError(rawForm || form);
    if (nextValidationError) {
      addNotification?.('error', nextValidationError);
      return;
    }
    const nextDirection = normalizeDirection((rawForm || form).direction);
    if (willStopBots(nextDirection)) {
      const names = usedByBots.map((b) => `«${b.name}»`).join(', ');
      if (!window.confirm(`Esta alerta la usa ${names}. Si la pasas a Neutral, ${usedByBots.length === 1 ? 'el bot dejará' : 'los bots dejarán'} de operarla. ¿Guardar?`)) return;
    }
    setIsSaving(true);
    try {
      const payload = rawForm ? formToPayload(rawForm) : buildPayload();
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
      setMobileView('list');
    } catch (err) {
      addNotification?.('error', `Error al eliminar: ${err.message}`);
    }
  };

  const toggleActive = async () => {
    if (!selectedId || effectiveDirty) return;
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
    usedByBots: botUsage ? alerts.filter((a) => (botUsage.get(Number(a.id)) || []).length > 0).length : null,
  }), [alerts, botUsage]);

  const visibleAlerts = useMemo(
    () => alerts.filter((a) => matchesDirectionFilter(a, directionFilter)),
    [alerts, directionFilter],
  );

  const openAlert = (alert) => {
    selectAlert(alert);
    setMobileView('editor');
  };

  const direction = normalizeDirection(form.direction);
  const directionNote = (() => {
    if (showNeutralWarning) {
      const names = usedByBots.map((b) => `«${b.name}»`).join(', ');
      return `Esta alerta la usa ${names}. Si la pasas a Neutral, ${usedByBots.length === 1 ? 'el bot dejará' : 'los bots dejarán'} de operarla.`;
    }
    if (direction === 'neutral') {
      return 'Neutral: la alerta solo avisa. Los bots de Trading automatizado no pueden vincularla.';
    }
    return `Los bots de Opciones › Trading automatizado operan esta alerta en dirección ${DIRECTION_META[direction].label.toLowerCase()}. Cambiarla afecta a los bots vinculados desde el próximo disparo.`;
  })();

  const previewAsset = form.assetList[0] || '—';
  // Mismo criterio que el servidor: la temporalidad más baja de las reglas.
  const previewTf = form.rules
    .flatMap((r) => r.conditions || [])
    .flatMap((c) => [c.timeframe, c.operand?.kind === 'series' ? c.operand.timeframe : null])
    .filter((tf) => TF_ORDER.includes(tf))
    .sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b))[0] || '?';
  const telegramPreview = [
    telegramTitle(direction, form.name.trim()),
    `Activo: ${previewAsset} · TF: ${previewTf}`,
    `Puntaje: …% (umbral ${Number(form.thresholdPercent) || 0}%)`,
  ].join('\n');

  const totalWeight = form.rules.reduce((acc, r) => acc + (Number(r.weight) || 0), 0);
  const requiredWeight = (totalWeight * Number(form.thresholdPercent)) / 100;

  return (
    <div className={`${styles.page} ${mobileEditor ? styles.pageMobileEditor : ''}`}>
      {mobileEditor ? (
        <div className={styles.mobileHeader}>
          <button
            type="button"
            className={styles.backBtn}
            onClick={() => setMobileView('list')}
            aria-label="Volver a alertas"
          >
            <BackIcon />
          </button>
          <h1 className={styles.mobileTitle}>{selectedId ? 'Editar alerta' : 'Nueva alerta'}</h1>
        </div>
      ) : (
        <div className={styles.hero}>
          <div className={styles.heroLeft}>
            <div>
              <span className={styles.eyebrow}>🔔 Alertas</span>
              <h1 className={styles.title}>Alertas con reglas y peso</h1>
            </div>
          </div>
          <div className={styles.stats}>
            <div className={styles.stat}><strong>{totals.count}</strong><span>total</span></div>
            <div className={styles.stat}><strong>{totals.active}</strong><span>activas</span></div>
            {totals.usedByBots != null && (
              <div className={styles.stat}><strong>{totals.usedByBots}</strong><span>usadas por bots</span></div>
            )}
          </div>
        </div>
      )}

      <div className={styles.layout}>
        {(!isMobile || mobileView === 'list') && (
        <div className={styles.sidebarWrap}>
          <div className={styles.sidebar}>
            <button className={styles.newBtn} onClick={() => openAlert(null)}>
              + Nueva alerta
            </button>
            <div role="group" aria-label="Filtrar por dirección" className={styles.dirFilters}>
              {DIRECTION_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={directionFilter === f.key}
                  className={`${styles.dirFilter} ${directionFilter === f.key ? styles.dirFilterActive : ''}`}
                  onClick={() => setDirectionFilter(f.key)}
                >
                  {f.key !== 'all' && <DirectionIcon direction={f.key} size={10} />}
                  {f.label}
                </button>
              ))}
            </div>
            {isLoading && <div className={styles.empty}>Cargando…</div>}
            {!isLoading && alerts.length === 0 && (
              <div className={styles.empty}>Aún no tienes alertas. Crea la primera.</div>
            )}
            {!isLoading && alerts.length > 0 && visibleAlerts.length === 0 && (
              <div className={styles.empty}>No hay alertas con esta dirección.</div>
            )}
            {visibleAlerts.map((a) => {
              const bots = botUsage?.get(Number(a.id)) || NO_BOTS;
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`${styles.alertItem} ${selectedId === a.id ? styles.alertItemActive : ''}`}
                  onClick={() => openAlert(a)}
                >
                  <span className={styles.alertItemHead}>
                    <span className={styles.alertItemName}>{a.name}</span>
                    <DirectionChip direction={a.direction} />
                  </span>
                  <span className={styles.alertItemMeta}>
                    <span className={`${styles.dot} ${a.isActive ? styles.dotOn : styles.dotOff}`} />
                    {a.assetList?.length || 0} activos · {a.rules?.length || 0} reglas · {a.thresholdPercent}%
                    {botUsage && (
                      <span className={styles.alertItemBots}>
                        {bots.length > 0 ? `Usada por ${bots.length} bot${bots.length === 1 ? '' : 's'}` : 'Sin bots'}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        )}

        {(!isMobile || mobileView === 'editor') && (
        <div className={styles.editor}>
          {/* Banner contextual: presets si es alerta nueva sin tocar, o
              indicador "sin guardar" si el form está dirty. */}
          {editorMode === 'visual' && !selectedId && !isDirty && (
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
                    <DirectionChip direction={p.direction} />
                    <span className={styles.presetDesc}>{p.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className={styles.editorModeBar}>
            <div className={styles.editorModeTabs}>
              <button
                type="button"
                className={`${styles.editorModeTab} ${editorMode === 'visual' ? styles.editorModeTabActive : ''}`}
                onClick={openVisualMode}
              >
                Visual
              </button>
              <button
                type="button"
                className={`${styles.editorModeTab} ${editorMode === 'raw' ? styles.editorModeTabActive : ''}`}
                onClick={openRawMode}
              >
                Raw text
              </button>
            </div>
            <button type="button" className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSmall}`} onClick={copyRawText}>
              Copiar config
            </button>
          </div>

          {effectiveDirty && (
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

          {editorMode === 'raw' ? (
            <div className={styles.rawEditor}>
              <div className={styles.rawToolbar}>
                <span className={styles.rawHint}>Edita o pega una configuración JSON de alerta.</span>
                <button type="button" className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSmall}`} onClick={refreshRawFromVisual}>
                  Regenerar desde visual
                </button>
                <button type="button" className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSmall}`} onClick={() => applyRawText()}>
                  Aplicar al formulario
                </button>
              </div>
              <textarea
                className={styles.rawTextarea}
                value={rawText}
                spellCheck={false}
                onChange={(e) => {
                  setRawText(e.target.value);
                  setRawTextDirty(true);
                  setRawError('');
                }}
              />
              {rawError && <div className={styles.rawError}>{rawError}</div>}
            </div>
          ) : (
            <>
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

            <div className={styles.formField}>
              <label>Vencimiento de opciones (opcional, en días)</label>
              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label htmlFor="alert-expiry-min">Mínimo</label>
                  <input
                    id="alert-expiry-min"
                    className={styles.input}
                    type="number" min="0.001" max="180" step="0.25"
                    placeholder="Sin límite"
                    value={form.optionExpiryMinDays ?? ''}
                    onChange={(e) => updateField('optionExpiryMinDays', e.target.value === '' ? null : Number(e.target.value))}
                  />
                </div>
                <div className={styles.formField}>
                  <label htmlFor="alert-expiry-max">Máximo</label>
                  <input
                    id="alert-expiry-max"
                    className={styles.input}
                    type="number" min="0.001" max="180" step="0.25"
                    placeholder="Sin límite"
                    value={form.optionExpiryMaxDays ?? ''}
                    onChange={(e) => updateField('optionExpiryMaxDays', e.target.value === '' ? null : Number(e.target.value))}
                  />
                </div>
              </div>
              <p className={styles.dirNote}>Si defines el rango, los bots de opciones solo elegirán vencimientos dentro de él. No modifica las alertas de Telegram.</p>
            </div>

            <fieldset className={`${styles.dirFieldset} ${isMobile ? styles.dirFieldsetMobile : ''}`}>
              <legend className={styles.dirLegend}>Dirección de la señal</legend>
              <DirectionSelector
                value={direction}
                onChange={(next) => updateField('direction', next)}
                mobile={isMobile}
              />
              <p
                className={`${styles.dirNote} ${showNeutralWarning ? styles.dirNoteWarning : ''}`}
                role={showNeutralWarning ? 'alert' : undefined}
                data-testid="direction-note"
              >
                {directionNote}
              </p>
            </fieldset>
          </div>

          <div className={styles.signalCards}>
            <div className={styles.signalCard}>
              <h3 className={styles.sectionTitle}>Vista previa en Telegram</h3>
              <div className={styles.telegramPreview} data-testid="telegram-preview">{telegramPreview}</div>
            </div>
            {botUsage && selectedId != null && (
              <div className={styles.signalCard} data-testid="used-by">
                <h3 className={styles.sectionTitle}>
                  Usada por {usedByBots.length} bot{usedByBots.length === 1 ? '' : 's'}
                </h3>
                {usedByBots.map((b) => (
                  <Link key={b.id} to="/opciones?tab=auto" className={styles.botLink}>
                    <span className={styles.botLinkName}>{b.name}</span>
                    <span className={styles.botLinkMeta}>
                      {botModeLabel(b.mode)} · {botOpensLabel(b.structure, direction)}
                    </span>
                  </Link>
                ))}
                <p className={styles.dirNote}>
                  {usedByBots.length > 0
                    ? 'Si la pasas a Neutral, los bots dejan de operarla; te avisamos antes de guardar.'
                    : 'Ningún bot la usa todavía. Vincúlala desde Opciones › Trading automatizado.'}
                </p>
              </div>
            )}
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
                        {rr.matched ? '✓' : '·'} {rr.matched && rr.rule?.label ? `${rr.rule.label}: ` : ''}{rr.reason}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
            </>
          )}

          <div className={styles.actionBar}>
            {selectedId && (
              <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={remove} disabled={isSaving}>
                Eliminar
              </button>
            )}
            {selectedId && (
              <label
                className={`${styles.activeSwitch} ${form.isActive ? styles.activeSwitchOn : ''} ${(isSaving || isTogglingActive || effectiveDirty) ? styles.activeSwitchDisabled : ''}`}
                title={effectiveDirty ? 'Guarda o descarta los cambios antes de activar/desactivar' : ''}
              >
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={toggleActive}
                  disabled={isSaving || isTogglingActive || effectiveDirty}
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
                  disabled={effectiveDirty}
                  title={effectiveDirty ? 'Guarda primero los cambios para probar' : 'Evalúa la alerta con las últimas velas, sin enviar Telegram'}
                >
                  Probar (sin enviar)
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  onClick={() => testNow({ dryRun: false })}
                  disabled={effectiveDirty}
                  title={effectiveDirty ? 'Guarda primero los cambios para probar' : 'Evalúa y envía Telegram si supera el umbral'}
                >
                  Probar y enviar Telegram
                </button>
              </>
            )}
            {/* En móvil el guardado es un CTA fijo abajo, siempre a mano. */}
            <div className={mobileEditor ? styles.mobileCtaBar : styles.saveWrap}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary} ${mobileEditor ? styles.mobileCta : ''}`}
                onClick={save}
                disabled={isSaving || !!saveValidationError || (!effectiveDirty && !!selectedId)}
                title={saveValidationError || (!effectiveDirty && selectedId ? 'No hay cambios para guardar' : '')}
              >
                {isSaving ? 'Guardando…' : (selectedId ? 'Guardar cambios' : 'Crear alerta')}
              </button>
            </div>
          </div>
        </div>
        )}
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
