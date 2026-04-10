import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backtestingApi, strategiesApi } from '../../../services/api';
import { safeJsonParse, stringifyJson } from '../../../utils/json';
import { STRATEGY_TEMPLATES } from '../strategy-templates';

const DEFAULT_TEMPLATE = STRATEGY_TEMPLATES[0];

function blank() {
  return {
    id: null,
    name: '',
    description: '',
    assetUniverse: 'BTC',
    timeframe: DEFAULT_TEMPLATE.timeframe,
    defaultParams: stringifyJson(DEFAULT_TEMPLATE.defaultParams),
    scriptSource: DEFAULT_TEMPLATE.scriptSource,
    isActiveDraft: true,
  };
}

function fromTemplate(tpl) {
  return {
    id: null,
    name: tpl.name,
    description: tpl.description,
    assetUniverse: 'BTC',
    timeframe: tpl.timeframe,
    defaultParams: stringifyJson(tpl.defaultParams),
    scriptSource: tpl.scriptSource,
    isActiveDraft: true,
  };
}

function fromApi(s) {
  return {
    id: s.id,
    name: s.name,
    description: s.description || '',
    assetUniverse: Array.isArray(s.assetUniverse) ? s.assetUniverse.join(', ') : 'BTC',
    timeframe: s.timeframe || '15m',
    defaultParams: stringifyJson(s.defaultParams),
    scriptSource: s.scriptSource || DEFAULT_TEMPLATE.scriptSource,
    isActiveDraft: s.isActiveDraft ?? true,
  };
}

function buildDraftStrategy(form) {
  return {
    id: form.id,
    name: form.name,
    description: form.description,
    assetUniverse: form.assetUniverse.split(',').map((value) => value.trim()).filter(Boolean),
    timeframe: form.timeframe,
    defaultParams: safeJsonParse(form.defaultParams, {}),
    scriptSource: form.scriptSource,
    isActiveDraft: form.isActiveDraft,
  };
}

function validateForm(form, { requireName }) {
  const nextErrors = {};
  if (requireName && !form.name.trim()) nextErrors.name = 'Nombre requerido';
  try {
    JSON.parse(form.defaultParams);
  } catch {
    nextErrors.defaultParams = 'JSON invalido';
  }
  if (!form.scriptSource.includes('module.exports')) {
    nextErrors.scriptSource = 'El script debe exportar una funcion';
  }
  return nextErrors;
}

export function useStrategyForm({ strategies, onReload, addNotification }) {
  const [form, setForm] = useState(blank());
  const [selectedId, setSelectedId] = useState(null);
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [backtestResult, setBacktestResult] = useState(null);
  const [lastValidationAt, setLastValidationAt] = useState(null);
  const [lastBacktestAt, setLastBacktestAt] = useState(null);
  const savedSnapshot = useRef(null);

  const selected = useMemo(
    () => strategies.find((s) => Number(s.id) === Number(selectedId)) || null,
    [selectedId, strategies],
  );

  const isDirty = useMemo(() => {
    if (!savedSnapshot.current) return form.name.trim().length > 0 || form.scriptSource !== DEFAULT_TEMPLATE.scriptSource;
    return JSON.stringify(form) !== JSON.stringify(savedSnapshot.current);
  }, [form]);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const applyErrors = useCallback((nextErrors) => {
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }, []);

  const resetRuntimeResults = useCallback(() => {
    setValidationResult(null);
    setBacktestResult(null);
  }, []);

  const select = useCallback((strategy) => {
    const nextForm = strategy ? fromApi(strategy) : blank();
    setSelectedId(strategy?.id || null);
    setForm(nextForm);
    savedSnapshot.current = strategy ? { ...nextForm } : null;
    setErrors({});
    setLastValidationAt(null);
    setLastBacktestAt(null);
    resetRuntimeResults();
  }, [resetRuntimeResults]);

  const selectTemplate = useCallback((tpl) => {
    const nextForm = fromTemplate(tpl);
    setSelectedId(null);
    setForm(nextForm);
    savedSnapshot.current = null;
    setErrors({});
    setLastValidationAt(null);
    setLastBacktestAt(null);
    resetRuntimeResults();
  }, [resetRuntimeResults]);

  const update = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    resetRuntimeResults();
  }, [resetRuntimeResults]);

  const save = useCallback(async () => {
    const nextErrors = validateForm(form, { requireName: true });
    if (!applyErrors(nextErrors)) return;

    setIsSaving(true);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        assetUniverse: form.assetUniverse.split(',').map((s) => s.trim()).filter(Boolean),
        timeframe: form.timeframe,
        defaultParams: safeJsonParse(form.defaultParams, {}),
        scriptSource: form.scriptSource,
        isActiveDraft: form.isActiveDraft,
      };
      const saved = form.id
        ? await strategiesApi.update(form.id, payload)
        : await strategiesApi.create(payload);
      const refreshed = await strategiesApi.getById(saved.id);
      await onReload();
      select(refreshed);
      addNotification('success', `Estrategia guardada: ${saved.name}`);
    } catch (err) {
      addNotification('error', `Error al guardar: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  }, [form, applyErrors, onReload, addNotification, select]);

  const remove = useCallback(async () => {
    if (!selected) return;
    try {
      await strategiesApi.remove(selected.id);
      addNotification('info', `Estrategia eliminada: ${selected.name}`);
      select(null);
      await onReload();
    } catch (err) {
      addNotification('error', `Error al eliminar: ${err.message}`);
    }
  }, [selected, addNotification, select, onReload]);

  const runValidation = useCallback(async () => {
    const nextErrors = validateForm(form, { requireName: false });
    if (!applyErrors(nextErrors)) return;

    setIsValidating(true);
    try {
      const draftStrategy = buildDraftStrategy(form);
      const result = await strategiesApi.validateDraft({
        strategyId: form.id || undefined,
        draftStrategy,
        asset: draftStrategy.assetUniverse[0] || 'BTC',
        timeframe: draftStrategy.timeframe,
        params: draftStrategy.defaultParams,
        limit: 250,
      });
      setValidationResult(result);
      setLastValidationAt(Date.now());
      addNotification('success', `Signal: ${result.signal?.type || 'hold'}`);
    } catch (err) {
      addNotification('error', `Error al validar: ${err.message}`);
    } finally {
      setIsValidating(false);
    }
  }, [form, applyErrors, addNotification]);

  const runBacktest = useCallback(async () => {
    const nextErrors = validateForm(form, { requireName: false });
    if (!applyErrors(nextErrors)) return;

    setIsBacktesting(true);
    try {
      const draftStrategy = buildDraftStrategy(form);
      const params = draftStrategy.defaultParams;
      const result = await backtestingApi.simulate({
        strategyId: form.id || undefined,
        draftStrategy,
        asset: draftStrategy.assetUniverse[0] || 'BTC',
        timeframe: draftStrategy.timeframe,
        params,
        limit: 300,
      });
      setBacktestResult(result);
      setLastBacktestAt(Date.now());
      if (form.id) await onReload();
      addNotification('success', `Backtest: ${result.metrics?.trades || 0} trades`);
    } catch (err) {
      addNotification('error', `Error en backtest: ${err.message}`);
    } finally {
      setIsBacktesting(false);
    }
  }, [form, applyErrors, addNotification, onReload]);

  return {
    form,
    errors,
    isDirty,
    selected,
    selectedId,
    isSaving,
    isValidating,
    isBacktesting,
    validationResult,
    backtestResult,
    lastValidationAt,
    lastBacktestAt,
    select,
    selectTemplate,
    update,
    save,
    remove,
    runValidation,
    runBacktest,
  };
}
