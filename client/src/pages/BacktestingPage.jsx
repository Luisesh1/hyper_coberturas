import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import BacktestChartPanel from '../components/Backtesting/BacktestChartPanel';
import BacktestForm from '../components/Backtesting/BacktestForm';
import BacktestResults from '../components/Backtesting/BacktestResults';
import {
  STORAGE_KEY,
  buildPayload,
  defaultForm,
  loadStoredForm,
  matchTradeFilter,
  stringifyJson,
} from '../components/Backtesting/backtesting-utils';
import { useTradingContext } from '../context/TradingContext';
import { backtestingApi, indicatorsApi, strategiesApi } from '../services/api';
import { formatNumber } from '../utils/formatters';
import styles from './BacktestingPage.module.css';

function BacktestingPage() {
  const location = useLocation();
  const { addNotification } = useTradingContext();
  const locationStrategyId = location.state?.strategyId ? String(location.state.strategyId) : '';
  const [strategies, setStrategies] = useState([]);
  const [indicators, setIndicators] = useState([]);
  const [form, setForm] = useState(() => ({
    ...defaultForm(locationStrategyId),
    ...(loadStoredForm() || {}),
    strategyId: locationStrategyId || loadStoredForm()?.strategyId || '',
  }));
  const [result, setResult] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [tradeFilter, setTradeFilter] = useState('all');
  const [focusedTradeId, setFocusedTradeId] = useState(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  }, [form]);

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

  useEffect(() => {
    if (!locationStrategyId) return;
    setForm((prev) => ({ ...prev, strategyId: locationStrategyId }));
  }, [locationStrategyId]);

  const selectedStrategy = useMemo(
    () => strategies.find((item) => String(item.id) === String(form.strategyId)) || null,
    [form.strategyId, strategies]
  );

  useEffect(() => {
    if (!selectedStrategy) return;
    setForm((prev) => {
      const asset = prev.asset || selectedStrategy.assetUniverse?.[0] || 'BTC';
      const timeframe = prev.timeframe || selectedStrategy.timeframe || '15m';
      const params = prev.params && prev.params !== '{}' ? prev.params : stringifyJson(selectedStrategy.defaultParams || {});
      return { ...prev, asset, timeframe, params };
    });
  }, [selectedStrategy]);

  const assetSuggestions = useMemo(() => {
    const values = new Set(['BTC', 'ETH', 'SOL', 'ARB']);
    strategies.forEach((strategy) => {
      (strategy.assetUniverse || []).forEach((asset) => values.add(asset));
    });
    if (form.asset) values.add(form.asset.toUpperCase());
    return [...values];
  }, [form.asset, strategies]);

  const visibleTrades = useMemo(
    () => (result?.trades || []).filter((trade) => matchTradeFilter(trade, tradeFilter)),
    [result, tradeFilter]
  );

  const focusedTrade = useMemo(
    () => visibleTrades.find((trade, index) => `${trade.entryTime}-${index}` === focusedTradeId) || null,
    [visibleTrades, focusedTradeId]
  );

  const handleRun = async (event) => {
    event.preventDefault();
    if (!form.strategyId) {
      addNotification('info', 'Selecciona una estrategia antes de correr el backtest');
      return;
    }

    setIsRunning(true);
    try {
      const nextResult = await backtestingApi.simulate(buildPayload(form));
      setResult(nextResult);
      setFocusedTradeId(null);
      addNotification('success', `Simulacion completada\n${nextResult.metrics?.trades || 0} trades · ${nextResult.config?.asset}`);
    } catch (err) {
      addNotification('error', `Error al simular: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const metrics = result?.metrics || {};

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>Backtesting Lab</span>
          <h1 className={styles.title}>Simula el comportamiento real del bot sobre un activo y una temporalidad especificos.</h1>
          <p className={styles.subtitle}>Corre escenarios con size en USD, leverage, SL/TP, slippage y overlays para inspeccionar señales y resultados vela por vela.</p>
        </div>
        <div className={styles.heroStats}>
          <div className={styles.heroCard}>
            <strong>{strategies.length}</strong>
            <span>estrategias listas</span>
          </div>
          <div className={styles.heroCard}>
            <strong>{result?.trades?.length || 0}</strong>
            <span>trades en la corrida</span>
          </div>
          <div className={styles.heroCard}>
            <strong>{result ? `${formatNumber(metrics.netPnl || 0, 2)}` : '—'}</strong>
            <span>net pnl</span>
          </div>
        </div>
      </div>

      <BacktestForm
        form={form}
        setForm={setForm}
        strategies={strategies}
        indicators={indicators}
        assetSuggestions={assetSuggestions}
        isRunning={isRunning}
        isLoading={isLoading}
        onSubmit={handleRun}
      />

      <section className={styles.metricsPanel}>
        <div className={styles.metricCard}>
          <span>Trades</span>
          <strong>{metrics.trades ?? '—'}</strong>
        </div>
        <div className={styles.metricCard}>
          <span>Win rate</span>
          <strong>{metrics.winRate != null ? `${formatNumber(metrics.winRate, 2)}%` : '—'}</strong>
        </div>
        <div className={styles.metricCard}>
          <span>Net PnL</span>
          <strong>{metrics.netPnl != null ? formatNumber(metrics.netPnl, 2) : '—'}</strong>
        </div>
        <div className={styles.metricCard}>
          <span>Max drawdown</span>
          <strong>{metrics.maxDrawdown != null ? formatNumber(metrics.maxDrawdown, 2) : '—'}</strong>
        </div>
        <div className={styles.metricCard}>
          <span>Profit factor</span>
          <strong>{metrics.profitFactor != null ? formatNumber(metrics.profitFactor, 2) : '—'}</strong>
        </div>
        <div className={styles.metricCard}>
          <span>Avg trade</span>
          <strong>{metrics.avgTrade != null ? formatNumber(metrics.avgTrade, 2) : '—'}</strong>
        </div>
      </section>

      {result ? (
        <>
          <BacktestChartPanel result={result} focusedTrade={focusedTrade} />

          <BacktestResults
            result={result}
            visibleTrades={visibleTrades}
            tradeFilter={tradeFilter}
            setTradeFilter={setTradeFilter}
            focusedTradeId={focusedTradeId}
            setFocusedTradeId={setFocusedTradeId}
            selectedStrategy={selectedStrategy}
          />
        </>
      ) : (
        <section className={styles.emptyPanel}>
          <h2>Listo para correr una simulacion</h2>
          <p>Selecciona una estrategia, ajusta el escenario y ejecuta el backtest para ver graficas y datos interactivos.</p>
        </section>
      )}
    </div>
  );
}

export default BacktestingPage;
