import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { crossChainApi } from '../../services/api';

const DEFAULT_THRESHOLD_PCT = 3;

/**
 * Estado del análisis de fondeo multi-red del paso Fondeo.
 *
 * Cambiar de perfil NO recotiza: el análisis ya trae los costos de los tres
 * perfiles y el servidor vuelve a cotizar al crear el plan. Forzar o
 * desactivar un origen, o cambiar el umbral, sí recalcula el plan.
 */
export default function useCrossChainFunding({ request, enabled = true }) {
  const [mode, setMode] = useState(null);
  const [profile, setProfile] = useState('low');
  const [thresholdPct, setThresholdPct] = useState(DEFAULT_THRESHOLD_PCT);
  const [forcedSources, setForcedSources] = useState([]);
  const [disabledSources, setDisabledSources] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    crossChainApi.getConfig()
      .then((data) => { if (alive) setMode(data?.mode || 'off'); })
      .catch(() => { if (alive) setMode('off'); });
    return () => { alive = false; };
  }, []);

  const requestKey = request ? JSON.stringify(request) : null;
  const input = useMemo(() => (request ? {
    ...request,
    profile,
    thresholdPct,
    forcedSources,
    disabledSources,
  } : null), [request, profile, thresholdPct, forcedSources, disabledSources]);

  const analyze = useCallback(async (payload) => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await crossChainApi.analyze(payload);
      if (id === seq.current) setAnalysis(data);
    } catch (err) {
      if (id === seq.current) setError(err?.message || 'No se pudo analizar el fondeo multi-red.');
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  // El perfil no entra en la clave: no recotiza.
  const analysisKey = requestKey ? `${requestKey}|${thresholdPct}|${forcedSources.join()}|${disabledSources.join()}` : null;
  useEffect(() => {
    if (!enabled || !mode || mode === 'off' || !analysisKey || !input) return;
    analyze({ ...input, profile: 'low' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisKey, enabled, mode]);

  const toggle = (setter) => (id) => setter((current) => (
    current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
  ));

  const resetSelection = useCallback(() => {
    setForcedSources([]);
    setDisabledSources([]);
  }, []);

  return {
    mode,
    available: mode === 'read' || mode === 'execute',
    canExecute: mode === 'execute',
    analysis,
    loading,
    error,
    profile,
    setProfile,
    thresholdPct,
    setThresholdPct,
    forcedSources,
    disabledSources,
    toggleForced: toggle(setForcedSources),
    toggleDisabled: toggle(setDisabledSources),
    resetSelection,
    refresh: () => input && analyze({ ...input, profile: 'low' }),
    planInput: input,
  };
}
