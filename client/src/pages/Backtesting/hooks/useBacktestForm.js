import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  STORAGE_KEY,
  buildPayload,
  defaultForm,
  loadStoredForm,
  stringifyJson,
} from '../../../components/Backtesting/backtesting-utils';

export default function useBacktestForm(locationStrategyId, strategies) {
  const [form, setForm] = useState(() => ({
    ...defaultForm(locationStrategyId),
    ...(loadStoredForm() || {}),
    strategyId: locationStrategyId || loadStoredForm()?.strategyId || '',
  }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  }, [form]);

  useEffect(() => {
    if (!locationStrategyId) return;
    setForm((prev) => ({ ...prev, strategyId: locationStrategyId }));
  }, [locationStrategyId]);

  const selectedStrategy = useMemo(
    () => strategies.find((s) => String(s.id) === String(form.strategyId)) || null,
    [form.strategyId, strategies],
  );

  useEffect(() => {
    if (!selectedStrategy) return;
    setForm((prev) => {
      const asset = prev.asset || selectedStrategy.assetUniverse?.[0] || 'BTC';
      const timeframe = prev.timeframe || selectedStrategy.timeframe || '15m';
      const params =
        prev.params && prev.params !== '{}'
          ? prev.params
          : stringifyJson(selectedStrategy.defaultParams || {});
      return { ...prev, asset, timeframe, params };
    });
  }, [selectedStrategy]);

  const assetSuggestions = useMemo(() => {
    const values = new Set(['BTC', 'ETH', 'SOL', 'ARB']);
    strategies.forEach((s) => (s.assetUniverse || []).forEach((a) => values.add(a)));
    if (form.asset) values.add(form.asset.toUpperCase());
    return [...values];
  }, [form.asset, strategies]);

  const getPayload = useCallback(() => buildPayload(form), [form]);

  const applyPreset = useCallback((preset) => {
    setForm((prev) => ({ ...prev, ...preset }));
  }, []);

  const resetParams = useCallback(() => {
    if (!selectedStrategy) return;
    setForm((prev) => ({
      ...prev,
      params: stringifyJson(selectedStrategy.defaultParams || {}),
    }));
  }, [selectedStrategy]);

  return {
    form,
    setForm,
    selectedStrategy,
    assetSuggestions,
    getPayload,
    applyPreset,
    resetParams,
  };
}
