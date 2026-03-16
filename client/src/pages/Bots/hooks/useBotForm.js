import { useCallback, useEffect, useMemo, useState } from 'react';
import { botsApi } from '../../../services/api';
import { safeJsonParse, stringifyJson } from '../../../utils/json';

function blank(asset = 'BTC', accountId = null) {
  return {
    id: null, strategyId: '', accountId, asset, timeframe: '15m',
    size: '100', leverage: '10', marginMode: 'cross',
    stopLossPct: '', takeProfitPct: '', params: stringifyJson({}),
  };
}

function fromApi(bot) {
  return {
    id: bot.id, strategyId: String(bot.strategyId), accountId: bot.accountId,
    asset: bot.asset, timeframe: bot.timeframe || '15m',
    size: String(bot.sizeUsd ?? bot.size), leverage: String(bot.leverage),
    marginMode: bot.marginMode,
    stopLossPct: bot.stopLossPct == null ? '' : String(bot.stopLossPct),
    takeProfitPct: bot.takeProfitPct == null ? '' : String(bot.takeProfitPct),
    params: stringifyJson(bot.params),
  };
}

export function useBotForm({ bots, selectedAsset, defaultAccountId, onReload, addNotification }) {
  const [form, setForm] = useState(blank(selectedAsset, defaultAccountId));
  const [selectedId, setSelectedId] = useState(null);
  const [runs, setRuns] = useState([]);
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [isActing, setIsActing] = useState(false);

  const selected = useMemo(
    () => bots.find((b) => Number(b.id) === Number(selectedId)) || null,
    [bots, selectedId],
  );

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      accountId: prev.accountId || defaultAccountId,
      asset: prev.id ? prev.asset : (prev.asset || selectedAsset || 'BTC'),
    }));
  }, [defaultAccountId, selectedAsset]);

  const validate = useCallback(() => {
    const e = {};
    if (!form.strategyId) e.strategyId = 'Selecciona una estrategia';
    if (!form.accountId) e.accountId = 'Selecciona una cuenta';
    if (!form.size || Number(form.size) <= 0) e.size = 'Monto debe ser mayor a 0';
    if (!form.leverage || Number(form.leverage) < 1) e.leverage = 'Leverage debe ser >= 1';
    if (form.stopLossPct && Number(form.stopLossPct) <= 0) e.stopLossPct = 'Debe ser positivo';
    if (form.takeProfitPct && Number(form.takeProfitPct) <= 0) e.takeProfitPct = 'Debe ser positivo';
    try { JSON.parse(form.params); } catch { e.params = 'JSON invalido'; }
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [form]);

  const select = useCallback(async (bot) => {
    setSelectedId(bot?.id || null);
    setErrors({});
    if (!bot) {
      setForm(blank(selectedAsset, defaultAccountId));
      setRuns([]);
      return;
    }
    setForm(fromApi(bot));
    try {
      const r = await botsApi.getRuns(bot.id);
      setRuns(r);
    } catch { setRuns([]); }
  }, [selectedAsset, defaultAccountId]);

  const update = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => { if (!prev[field]) return prev; const n = { ...prev }; delete n[field]; return n; });
  }, []);

  const save = useCallback(async () => {
    if (!validate()) return;
    setIsSaving(true);
    try {
      const payload = {
        strategyId: Number(form.strategyId), accountId: form.accountId,
        asset: form.asset, timeframe: form.timeframe,
        sizeUsd: Number(form.size), leverage: Number(form.leverage),
        marginMode: form.marginMode,
        stopLossPct: form.stopLossPct === '' ? null : Number(form.stopLossPct),
        takeProfitPct: form.takeProfitPct === '' ? null : Number(form.takeProfitPct),
        params: safeJsonParse(form.params, {}),
      };
      const saved = form.id ? await botsApi.update(form.id, payload) : await botsApi.create(payload);
      await onReload();
      const refreshed = await botsApi.getById(saved.id);
      await select(refreshed);
      addNotification('success', `Bot guardado: #${saved.id}`);
    } catch (err) {
      addNotification('error', `Error al guardar: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  }, [form, validate, onReload, addNotification, select]);

  const action = useCallback(async (act) => {
    if (!selected) return;
    setIsActing(true);
    try {
      if (act === 'activate') await botsApi.activate(selected.id);
      if (act === 'pause') await botsApi.pause(selected.id);
      if (act === 'stop') await botsApi.stop(selected.id);
      if (act === 'duplicate') await botsApi.duplicate(selected.id);
      if (act === 'delete') {
        await botsApi.remove(selected.id);
        select(null);
        await onReload();
        addNotification('success', `Bot #${selected.id} eliminado`);
        return;
      }
      await onReload();
      const refreshed = await botsApi.getById(selected.id);
      await select(refreshed);
      addNotification('success', `${act} completado: bot #${selected.id}`);
    } catch (err) {
      addNotification('error', `Error: ${err.message}`);
    } finally {
      setIsActing(false);
    }
  }, [selected, onReload, addNotification, select]);

  const refreshRuns = useCallback(async () => {
    if (!selectedId) return;
    try { const r = await botsApi.getRuns(selectedId); setRuns(r); } catch {}
  }, [selectedId]);

  return {
    form, errors, selected, selectedId, runs, isSaving, isActing,
    select, update, save, action, refreshRuns, validate,
  };
}
