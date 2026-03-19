import { useEffect } from 'react';
import { Spinner } from '../../../components/shared/Spinner';
import MetricsStrip from './MetricsStrip';
import RunHistoryDropdown from './RunHistoryDropdown';
import styles from './BacktestTopBar.module.css';

function BacktestTopBar({
  form,
  setForm,
  strategies,
  metrics,
  isRunning,
  isLoading,
  pendingJob,
  onRun,
  configOpen,
  onToggleConfig,
  runs,
  activeRunId,
  onSelectRun,
  onToggleCompare,
}) {
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        onRun();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onRun]);

  return (
    <div className={styles.topbar}>
      <div className={styles.left}>
        <span className={styles.eyebrow}>Backtesting Lab</span>
        <select
          className={styles.strategyPill}
          value={form.strategyId}
          onChange={(e) => setForm((p) => ({ ...p, strategyId: e.target.value }))}
          disabled={isLoading}
        >
          <option value="">Estrategia...</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {form.asset && (
          <button
            type="button"
            className={styles.infoPill}
            onClick={onToggleConfig}
            title="Editar configuracion"
          >
            {form.asset} &middot; {form.timeframe}
          </button>
        )}
      </div>

      <div className={styles.center}>
        <button
          type="button"
          className={styles.runBtn}
          onClick={onRun}
          disabled={isRunning || isLoading || !form.strategyId}
          title="Ctrl+Enter"
        >
          {isRunning ? <><Spinner size={14} color="#92400e" /> Simulando...</> : 'Simular'}
        </button>
        {pendingJob && (
          <span className={styles.pendingBadge}>
            <Spinner size={12} color="#6366f1" />
            <span>En cola: {pendingJob.asset} {pendingJob.timeframe}</span>
          </span>
        )}
      </div>

      <div className={styles.right}>
        <MetricsStrip metrics={metrics} />
        {runs.length > 0 && (
          <RunHistoryDropdown
            runs={runs}
            activeRunId={activeRunId}
            onSelectRun={onSelectRun}
            onToggleCompare={onToggleCompare}
          />
        )}
        <button
          type="button"
          className={`${styles.iconBtn} ${configOpen ? styles.iconBtnActive : ''}`}
          onClick={onToggleConfig}
          title="Configuracion"
          aria-label="Toggle configuracion"
        >
          &#9881;
        </button>
      </div>
    </div>
  );
}

export default BacktestTopBar;
