import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backtestingApi } from '../../../services/api';

const MAX_RUNS = 10;
const COMPACT_THRESHOLD = 3;
const POLL_INTERVAL_MS = 3_000;
const SYNC_TIMEOUT_MS = 15_000;

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
  const [pendingJob, setPendingJob] = useState(null);
  const pollRef = useRef(null);

  const activeResult = useMemo(
    () => runs.find((r) => r.id === activeRunId)?.result || null,
    [runs, activeRunId],
  );

  const compareResult = useMemo(
    () => runs.find((r) => r.id === compareRunId)?.result || null,
    [runs, compareRunId],
  );

  const addRun = useCallback((payload, result) => {
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
    return id;
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollJob = useCallback(
    (jobId, payload) => {
      setPendingJob({ jobId, asset: payload.asset, timeframe: payload.timeframe });

      pollRef.current = setInterval(async () => {
        try {
          const job = await backtestingApi.getJob(jobId);
          if (job.status === 'completed') {
            stopPolling();
            setPendingJob(null);
            addRun(payload, job.result);
            addNotification(
              'success',
              `Backtest completado (background)\n${job.result.metrics?.trades || 0} trades · ${payload.asset}`,
              8000,
            );
          } else if (job.status === 'failed') {
            stopPolling();
            setPendingJob(null);
            addNotification('error', `Backtest fallido: ${job.error}`, 8000);
          }
        } catch {
          // network hiccup, keep polling
        }
      }, POLL_INTERVAL_MS);
    },
    [addRun, addNotification, stopPolling],
  );

  const execute = useCallback(
    async (form) => {
      if (!form.strategyId) {
        addNotification('info', 'Selecciona una estrategia antes de correr el backtest');
        return null;
      }

      setIsRunning(true);
      const payload = getPayload();

      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('__sync_timeout__')), SYNC_TIMEOUT_MS),
        );
        const result = await Promise.race([
          backtestingApi.simulate(payload),
          timeout,
        ]);

        addRun(payload, result);
        addNotification(
          'success',
          `Simulacion completada\n${result.metrics?.trades || 0} trades · ${payload.asset}`,
        );
        return result;
      } catch (err) {
        if (err.message === '__sync_timeout__' || err.message?.includes('timeout')) {
          try {
            const { jobId } = await backtestingApi.enqueue(payload);
            addNotification(
              'info',
              `Backtest enviado a segundo plano\nTe notificaremos cuando termine · ${payload.asset}`,
              6000,
            );
            pollJob(jobId, payload);
            return null;
          } catch (queueErr) {
            addNotification('error', `Error al encolar backtest: ${queueErr.message}`);
            return null;
          }
        }
        addNotification('error', `Error al simular: ${err.message}`);
        return null;
      } finally {
        setIsRunning(false);
      }
    },
    [getPayload, addNotification, addRun, pollJob],
  );

  const enqueueBackground = useCallback(
    async (form) => {
      if (!form.strategyId) {
        addNotification('info', 'Selecciona una estrategia antes de correr el backtest');
        return;
      }

      const payload = getPayload();
      try {
        const { jobId } = await backtestingApi.enqueue(payload);
        addNotification(
          'info',
          `Backtest enviado a cola\nTe notificaremos cuando termine · ${payload.asset}`,
          6000,
        );
        pollJob(jobId, payload);
      } catch (err) {
        addNotification('error', `Error al encolar: ${err.message}`);
      }
    },
    [getPayload, addNotification, pollJob],
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
    pendingJob,
    execute,
    enqueueBackground,
  };
}
