import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import BacktestChartPanel from '../../components/Backtesting/BacktestChartPanel';
import { matchTradeFilter } from '../../components/Backtesting/backtesting-utils';
import { useTradingContext } from '../../context/TradingContext';
import { EmptyState } from '../../components/shared/EmptyState';
import { indicatorsApi, strategiesApi } from '../../services/api';
import BacktestTopBar from './components/BacktestTopBar';
import BottomPanel from './components/BottomPanel';
import ConfigDrawer from './components/ConfigDrawer';
import useBacktestForm from './hooks/useBacktestForm';
import useBacktestRuns from './hooks/useBacktestRuns';
import styles from './BacktestingPage.module.css';

function BacktestingPage() {
  const location = useLocation();
  const { addNotification } = useTradingContext();
  const locationStrategyId = location.state?.strategyId ? String(location.state.strategyId) : '';

  const [strategies, setStrategies] = useState([]);
  const [indicators, setIndicators] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [configOpen, setConfigOpen] = useState(true);
  const [tradeFilter, setTradeFilter] = useState('all');
  const [focusedTradeId, setFocusedTradeId] = useState(null);

  const {
    form, setForm, selectedStrategy, assetSuggestions, getPayload, applyPreset, resetParams,
  } = useBacktestForm(locationStrategyId, strategies);

  const {
    runs, activeRunId, setActiveRunId, compareTarget, compareResult, toggleCompare,
    selectBenchmark, activeResult, isRunning, pendingJob, execute,
  } = useBacktestRuns({ getPayload, selectedStrategy, addNotification });

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const [strategyData, indicatorData] = await Promise.all([
          strategiesApi.list(),
          indicatorsApi.list(),
        ]);
        setStrategies(strategyData);
        setIndicators(indicatorData);
      } catch (err) {
        addNotification('error', `Error al cargar Backtesting: ${err.message}`);
      } finally {
        setIsLoading(false);
      }
    };
    load().catch(() => {});
  }, [addNotification]);

  const handleRun = useCallback(async () => {
    const res = await execute(form);
    if (res) {
      setFocusedTradeId(null);
      setConfigOpen(false);
    }
  }, [execute, form]);

  const metrics = activeResult?.metrics || null;

  const visibleTrades = useMemo(
    () => (activeResult?.trades || []).filter((t) => matchTradeFilter(t, tradeFilter)),
    [activeResult, tradeFilter],
  );

  const focusedTrade = useMemo(
    () => visibleTrades.find((t, i) => `${t.entryTime}-${i}` === focusedTradeId) || null,
    [visibleTrades, focusedTradeId],
  );

  const toggleConfig = useCallback(() => setConfigOpen((p) => !p), []);

  return (
    <div className={styles.page}>
      <BacktestTopBar
        form={form}
        setForm={setForm}
        strategies={strategies}
        metrics={metrics}
        isRunning={isRunning}
        isLoading={isLoading}
        pendingJob={pendingJob}
        onRun={handleRun}
        configOpen={configOpen}
        onToggleConfig={toggleConfig}
        runs={runs}
        activeRunId={activeRunId}
        onSelectRun={setActiveRunId}
        onToggleCompare={toggleCompare}
      />

      <div className={styles.workspace}>
        <div className={styles.chartArea}>
          {activeResult ? (
            <>
              <div className={styles.chartContainer}>
                <BacktestChartPanel
                  result={activeResult}
                  focusedTrade={focusedTrade}
                  compareEquity={compareResult?.equitySeries}
                />
              </div>
              <BottomPanel
                result={activeResult}
                visibleTrades={visibleTrades}
                tradeFilter={tradeFilter}
                setTradeFilter={setTradeFilter}
                focusedTradeId={focusedTradeId}
                setFocusedTradeId={setFocusedTradeId}
                selectedStrategy={selectedStrategy}
                runs={runs}
                activeRunId={activeRunId}
                compareTarget={compareTarget}
                onToggleCompare={toggleCompare}
                onSelectBenchmark={selectBenchmark}
              />
            </>
          ) : (
            <EmptyState
              icon={form.strategyId ? '▶' : '⚙'}
              title={form.strategyId
                ? `Listo para simular ${selectedStrategy?.name || ''} en ${form.asset} ${form.timeframe}`
                : 'Configura tu primera simulacion'}
              description={form.strategyId
                ? 'Presiona Simular o Ctrl+Enter para comenzar.'
                : 'Selecciona una estrategia en el panel de configuracion para comenzar.'}
              action={form.strategyId ? 'Simular' : 'Abrir configuracion'}
              onAction={form.strategyId ? handleRun : toggleConfig}
            />
          )}
        </div>

        {configOpen && (
          <>
            <div
              className={styles.drawerBackdrop}
              onClick={toggleConfig}
              role="presentation"
            />
            <ConfigDrawer
              form={form}
              setForm={setForm}
              strategies={strategies}
              indicators={indicators}
              assetSuggestions={assetSuggestions}
              selectedStrategy={selectedStrategy}
              onApplyPreset={applyPreset}
              onResetParams={resetParams}
              onClose={toggleConfig}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default BacktestingPage;
