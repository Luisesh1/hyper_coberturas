import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { strategiesApi } from '../../../services/api';
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
    scriptSource: s.scriptSource || STRATEGY_TEMPLATE,
    isActiveDraft: s.isActiveDraft ?? true,
  };
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
  const savedSnapshot = useRef(null);

  const selected = useMemo(
    () => strategies.find((s) => Number(s.id) === Number(selectedId)) || null,
    [selectedId, strategies],
  );

  const isDirty = useMemo(() => {
    if (!savedSnapshot.current) return form.name.trim().length > 0;
    return JSON.stringify(form) !== JSON.stringify(savedSnapshot.current);
  }, [form]);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const validate = useCallback(() => {
    const e = {};
    if (!form.name.trim()) e.name = 'Nombre requerido';
    try { JSON.parse(form.defaultParams); } catch { e.defaultParams = 'JSON invalido'; }
    if (!form.scriptSource.includes('module.exports')) e.scriptSource = 'El script debe exportar una funcion';
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [form]);

  const select = useCallback((strategy) => {
    const f = strategy ? fromApi(strategy) : blank();
    setSelectedId(strategy?.id || null);
    setForm(f);
    savedSnapshot.current = strategy ? { ...f } : null;
    setErrors({});
    setValidationResult(null);
    setBacktestResult(null);
  }, []);

  const selectTemplate = useCallback((tpl) => {
    const f = fromTemplate(tpl);
    setSelectedId(null);
    setForm(f);
    savedSnapshot.current = null;
    setErrors({});
    setValidationResult(null);
    setBacktestResult(null);
  }, []);

  const update = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (!validate()) return;
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
  }, [form, validate, onReload, addNotification, select]);

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
    if (!form.id) { addNotification('info', 'Guarda la estrategia antes de validarla'); return; }
    setIsValidating(true);
    try {
      const result = await strategiesApi.validate(form.id, {
        asset: form.assetUniverse.split(',')[0]?.trim() || 'BTC',
        timeframe: form.timeframe,
        params: safeJsonParse(form.defaultParams, {}),
      });
      setValidationResult(result);
      addNotification('success', `Signal: ${result.signal?.type || 'hold'}`);
    } catch (err) {
      addNotification('error', `Error al validar: ${err.message}`);
    } finally {
      setIsValidating(false);
    }
  }, [form, addNotification]);

  const runBacktest = useCallback(async () => {
    if (!form.id) { addNotification('info', 'Guarda la estrategia antes del backtest'); return; }
    setIsBacktesting(true);
    try {
      const params = safeJsonParse(form.defaultParams, {});
      const result = await strategiesApi.backtest(form.id, {
        asset: form.assetUniverse.split(',')[0]?.trim() || 'BTC',
        timeframe: form.timeframe,
        params,
        tradeSize: params.size || 0.01,
        limit: 300,
      });
      setBacktestResult(result);
      await onReload();
      addNotification('success', `Backtest: ${result.metrics?.trades || 0} trades`);
    } catch (err) {
      addNotification('error', `Error en backtest: ${err.message}`);
    } finally {
      setIsBacktesting(false);
    }
  }, [form, addNotification, onReload]);

  return {
    form, errors, isDirty, selected, selectedId,
    isSaving, isValidating, isBacktesting,
    validationResult, backtestResult,
    select, selectTemplate, update, save, remove, runValidation, runBacktest,
  };
}
