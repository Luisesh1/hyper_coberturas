import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backtestingApi } from '../../../services/api';

const MAX_RUNS = 10;
const COMPACT_THRESHOLD = 3;
const POLL_INTERVAL_MS = 3_000;
const HISTORY_PREFIX = 'hl_backtesting_runs_v2';

let nextRunId = 1;

function compactBenchmark(benchmark) {
  if (!benchmark) return benchmark;
  return {
    key: benchmark.key,
    label: benchmark.label,
    config: benchmark.config,
    metrics: benchmark.metrics,
    equitySeries: benchmark.equitySeries,
    drawdownSeries: benchmark.drawdownSeries,
    assumptions: benchmark.assumptions,
  };
}

function compactRun(run) {
  const { result, ...rest } = run;
  return {
    ...rest,
    result: {
      config: result.config,
      metrics: result.metrics,
      trades: result.trades,
      signals: result.signals,
      equitySeries: result.equitySeries,
      drawdownSeries: result.drawdownSeries,
      assumptions: result.assumptions,
      benchmarks: Object.fromEntries(
        Object.entries(result.benchmarks || {}).map(([key, value]) => [key, compactBenchmark(value)]),
      ),
    },
  };
}

function storageKey(strategyId) {
  return `${HISTORY_PREFIX}:${strategyId || 'global'}`;
}

function loadStoredRuns(strategyId) {
  try {
    const raw = localStorage.getItem(storageKey(strategyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildRangeLabel(config = {}) {
  if (config.from && config.to) return 'custom';
  return `${config.limit || '--'} velas`;
}

function buildRunLabel(payload, result) {
  const strategyName = result?.config?.strategyName || `#${payload.strategyId || 'draft'}`;
  const mode = result?.config?.strategyMode === 'draft' ? 'draft' : 'saved';
  return `${strategyName} | ${payload.asset} ${payload.timeframe} | ${buildRangeLabel(result?.config || payload)} | ${mode}`;
}

export default function useBacktestRuns({ getPayload, selectedStrategy, addNotification }) {
  const strategyId = selectedStrategy?.id || null;
  const [runs, setRuns] = useState([]);
  const [activeRunId, setActiveRunId] = useState(null);
  const [compareTarget, setCompareTarget] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [pendingJob, setPendingJob] = useState(null);
  const pollRef = useRef(null);

  const activeResult = useMemo(
    () => runs.find((r) => r.id === activeRunId)?.result || null,
    [runs, activeRunId],
  );

  const compareResult = useMemo(() => {
    if (!compareTarget) return null;
    if (compareTarget.type === 'run') {
      return runs.find((r) => r.id === compareTarget.id)?.result || null;
    }
    return activeResult?.benchmarks?.[compareTarget.key] || null;
  }, [runs, compareTarget, activeResult]);

  useEffect(() => {
    const storedRuns = loadStoredRuns(strategyId);
    const maxStoredId = storedRuns.reduce((acc, run) => Math.max(acc, Number(run.id) || 0), 0);
    nextRunId = Math.max(nextRunId, maxStoredId + 1);
    setRuns(storedRuns);
    setActiveRunId(storedRuns[0]?.id || null);
    setCompareTarget(null);
  }, [strategyId]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(strategyId), JSON.stringify(runs));
    } catch {
      // ignore storage quota issues in lab mode
    }
  }, [runs, strategyId]);

  useEffect(() => {
    if (compareTarget?.type === 'run' && compareTarget.id === activeRunId) {
      setCompareTarget(null);
    }
  }, [compareTarget, activeRunId]);

  const addRun = useCallback((payload, result) => {
    const id = nextRunId++;
    const label = buildRunLabel(payload, result);
    const strategyName = result?.config?.strategyName || selectedStrategy?.name || '';
    const sourceMode = result?.config?.strategyMode || 'saved';
    const range = buildRangeLabel(result?.config || payload);

    setRuns((prev) => {
      const updated = [
        {
          id,
          label,
          strategyName,
          asset: payload.asset,
          timeframe: payload.timeframe,
          range,
          sourceMode,
          config: result?.config || payload,
          result,
          timestamp: Date.now(),
        },
        ...prev.map((run, index) => (index >= COMPACT_THRESHOLD - 1 ? compactRun(run) : run)),
      ];
      return updated.slice(0, MAX_RUNS);
    });
    setActiveRunId(id);
    setCompareTarget(null);
    return id;
  }, [selectedStrategy]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollJob = useCallback((jobId, payload) => {
    // Solo puede existir un trabajo en background por instancia del hook. Si
    // este helper vuelve a invocarse por una integración futura, el polling
    // anterior se cancela antes de registrar el nuevo.
    stopPolling();
    setPendingJob({ jobId, asset: payload.asset, timeframe: payload.timeframe });

    const intervalId = setInterval(async () => {
      try {
        const job = await backtestingApi.getJob(jobId);
        if (job.status === 'completed') {
          clearInterval(intervalId);
          if (pollRef.current === intervalId) pollRef.current = null;
          setPendingJob(null);
          addRun(payload, job.result);
          addNotification(
            'success',
            `Backtest completado (background)\n${job.result.metrics?.trades || 0} trades | ${payload.asset}`,
            8000,
          );
        } else if (job.status === 'failed') {
          clearInterval(intervalId);
          if (pollRef.current === intervalId) pollRef.current = null;
          setPendingJob(null);
          addNotification('error', `Backtest fallido: ${job.error}`, 8000);
        }
      } catch (err) {
        if (Number(err?.status) === 404) {
          clearInterval(intervalId);
          if (pollRef.current === intervalId) pollRef.current = null;
          setPendingJob(null);
          addNotification(
            'error',
            'El backtest ya no existe en el servidor (posible reinicio). Vuelve a ejecutarlo.',
            8000,
          );
        }
        // Los errores transitorios de red conservan el polling del mismo job.
      }
    }, POLL_INTERVAL_MS);
    pollRef.current = intervalId;
  }, [addRun, addNotification, stopPolling]);

  const execute = useCallback(async (form) => {
    if (!form.strategyId) {
      addNotification('info', 'Selecciona una estrategia antes de correr el backtest');
      return null;
    }
    if (isRunning || pendingJob) {
      addNotification('info', 'Ya hay un backtest en ejecución o en cola');
      return null;
    }

    setIsRunning(true);
    const payload = getPayload();

    try {
      const job = await backtestingApi.run(payload);
      if (job.status === 'completed') {
        addRun(payload, job.result);
        addNotification(
          'success',
          `Simulacion completada\n${job.result.metrics?.trades || 0} trades | ${payload.asset}`,
        );
        return job.result;
      }
      if (job.status === 'failed') {
        addNotification('error', `Backtest fallido: ${job.error}`, 8000);
        return null;
      }

      addNotification(
        'info',
        `Backtest enviado a segundo plano\nTe notificaremos cuando termine | ${payload.asset}`,
        6000,
      );
      pollJob(job.id, payload);
      return null;
    } catch (err) {
      addNotification('error', `Error al simular: ${err.message}`);
      return null;
    } finally {
      setIsRunning(false);
    }
  }, [getPayload, addNotification, addRun, pollJob, isRunning, pendingJob]);

  const toggleCompare = useCallback((runId) => {
    setCompareTarget((prev) => (
      prev?.type === 'run' && prev.id === runId
        ? null
        : { type: 'run', id: runId }
    ));
  }, []);

  const selectBenchmark = useCallback((key) => {
    setCompareTarget((prev) => (
      prev?.type === 'benchmark' && prev.key === key
        ? null
        : { type: 'benchmark', key }
    ));
  }, []);

  return {
    runs,
    activeRunId,
    setActiveRunId,
    compareTarget,
    compareResult,
    toggleCompare,
    selectBenchmark,
    activeResult,
    isRunning,
    pendingJob,
    execute,
  };
}
