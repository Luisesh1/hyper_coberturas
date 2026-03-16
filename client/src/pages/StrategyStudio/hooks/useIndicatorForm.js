import { useCallback, useMemo, useState } from 'react';
import { indicatorsApi } from '../../../services/api';
import { safeJsonParse, stringifyJson } from '../../../utils/json';

const INDICATOR_TEMPLATE = `module.exports.compute = function compute(input, params = {}) {
  const period = Number(params.period || 7);
  if (!Array.isArray(input) || input.length < period) return [];
  const closes = input.map((item) => Number(item.close ?? item));
  return closes.map((value, index) => {
    if (index < period - 1) return null;
    const window = closes.slice(index - period + 1, index + 1);
    const sum = window.reduce((acc, current) => acc + current, 0);
    return Number((sum / period).toFixed(6));
  });
};`;

function blank() {
  return { id: null, name: '', slug: '', parameterSchema: stringifyJson({ defaults: { period: 7 } }), scriptSource: INDICATOR_TEMPLATE };
}

function fromApi(ind) {
  return { id: ind.id, name: ind.name, slug: ind.slug, parameterSchema: stringifyJson(ind.parameterSchema), scriptSource: ind.scriptSource || INDICATOR_TEMPLATE };
}

export function useIndicatorForm({ indicators, onReload, addNotification }) {
  const [form, setForm] = useState(blank());
  const [selectedId, setSelectedId] = useState(null);
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);

  const selected = useMemo(
    () => indicators.find((i) => Number(i.id) === Number(selectedId)) || null,
    [indicators, selectedId],
  );

  const validate = useCallback(() => {
    const e = {};
    if (!form.name.trim()) e.name = 'Nombre requerido';
    if (!form.slug.trim()) e.slug = 'Slug requerido';
    try { JSON.parse(form.parameterSchema); } catch { e.parameterSchema = 'JSON invalido'; }
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [form]);

  const select = useCallback((indicator) => {
    setSelectedId(indicator?.id || null);
    setForm(indicator ? fromApi(indicator) : blank());
    setErrors({});
  }, []);

  const update = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => { if (!prev[field]) return prev; const n = { ...prev }; delete n[field]; return n; });
  }, []);

  const save = useCallback(async () => {
    if (!validate()) return;
    setIsSaving(true);
    try {
      const payload = { name: form.name, slug: form.slug, parameterSchema: safeJsonParse(form.parameterSchema, {}), scriptSource: form.scriptSource };
      const saved = form.id ? await indicatorsApi.update(form.id, payload) : await indicatorsApi.create(payload);
      await onReload();
      select(saved);
      addNotification('success', `Indicador guardado: @${saved.slug}`);
    } catch (err) {
      addNotification('error', `Error al guardar indicador: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  }, [form, validate, onReload, addNotification, select]);

  const remove = useCallback(async () => {
    if (!selected) return;
    try {
      await indicatorsApi.remove(selected.id);
      addNotification('info', `Indicador eliminado: @${selected.slug}`);
      select(null);
      await onReload();
    } catch (err) {
      addNotification('error', `Error al eliminar: ${err.message}`);
    }
  }, [selected, addNotification, select, onReload]);

  return { form, errors, selected, selectedId, isSaving, select, update, save, remove };
}
