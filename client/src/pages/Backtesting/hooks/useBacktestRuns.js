import { useCallback, useMemo, useState } from 'react';
import { backtestingApi } from '../../../services/api';

const MAX_RUNS = 10;
const COMPACT_THRESHOLD = 3;

let nextRunId = 1;

function compactRun(run) {
  const { result, ...rest } = run;
  return {
    ...rest,
    result: {
      config: result.config,
      metrics: result.metrics,
      equitySeries: result.equitySeries,
      drawdownSeries: result.drawdownSeries,
      assumptions: result.assumptions,
    },
  };
}

export default function useBacktestRuns(getPayload, addNotification) {
  const [runs, setRuns] = useState([]);
  const [activeRunId, setActiveRunId] = useState(null);
  const [compareRunId, setCompareRunId] = useState(null);
  const [isRunning, setIsRunning] = useState(false);

  const activeResult = useMemo(
    () => runs.find((r) => r.id === activeRunId)?.result || null,
    [runs, activeRunId],
  );

  const compareResult = useMemo(
    () => runs.find((r) => r.id === compareRunId)?.result || null,
    [runs, compareRunId],
  );

  const execute = useCallback(
    async (form) => {
      if (!form.strategyId) {
        addNotification('info', 'Selecciona una estrategia antes de correr el backtest');
        return null;
      }

      setIsRunning(true);
      try {
        const payload = getPayload();
        const result = await backtestingApi.simulate(payload);
        const id = nextRunId++;
        const label = `${payload.asset} ${payload.timeframe} #${id}`;

        setRuns((prev) => {
          const updated = [
            { id, label, config: payload, result, timestamp: Date.now() },
            ...prev.map((r, i) => (i >= COMPACT_THRESHOLD - 1 ? compactRun(r) : r)),
          ];
          return updated.slice(0, MAX_RUNS);
        });

        setActiveRunId(id);
        addNotification(
          'success',
          `Simulacion completada\n${result.metrics?.trades || 0} trades \u00b7 ${payload.asset}`,
        );
        return result;
      } catch (err) {
        addNotification('error', `Error al simular: ${err.message}`);
        return null;
      } finally {
        setIsRunning(false);
      }
    },
    [getPayload, addNotification],
  );

  const toggleCompare = useCallback(
    (runId) => {
      setCompareRunId((prev) => (prev === runId ? null : runId));
    },
    [],
  );

  return {
    runs,
    activeRunId,
    setActiveRunId,
    compareRunId,
    toggleCompare,
    activeResult,
    compareResult,
    isRunning,
    execute,
  };
}
