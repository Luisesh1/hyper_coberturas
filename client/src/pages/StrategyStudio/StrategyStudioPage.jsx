import { useCallback, useEffect, useState } from 'react';
import { indicatorsApi, strategiesApi } from '../../services/api';
import { useTradingContext } from '../../context/TradingContext';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { useStrategyForm } from './hooks/useStrategyForm';
import { useIndicatorForm } from './hooks/useIndicatorForm';
import { StrategySidebar } from './components/StrategySidebar';
import { StrategyEditor } from './components/StrategyEditor';
import { IndicatorEditor } from './components/IndicatorEditor';
import { ResultsPanel } from './components/ResultsPanel';
import styles from './StrategyStudioPage.module.css';

function StrategyStudioPage() {
  const { addNotification } = useTradingContext();
  const [strategies, setStrategies] = useState([]);
  const [indicators, setIndicators] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('strategy');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const strategyConfirm = useConfirmAction();
  const indicatorConfirm = useConfirmAction();

  const loadData = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([strategiesApi.list(), indicatorsApi.list()]);
      setStrategies(s);
      setIndicators(i);
    } catch (err) {
      addNotification('error', `Error al cargar datos: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [addNotification]);

  useEffect(() => { loadData(); }, [loadData]);

  const strategyForm = useStrategyForm({ strategies, onReload: loadData, addNotification });
  const indicatorForm = useIndicatorForm({ indicators, onReload: loadData, addNotification });

  const handleDeleteStrategy = async () => {
    const ok = await strategyConfirm.confirm({
      title: 'Eliminar estrategia',
      message: `¿Eliminar "${strategyForm.form.name}"? Esta accion no se puede deshacer.`,
      confirmLabel: 'Eliminar',
    });
    if (ok) await strategyForm.remove();
  };

  const handleDeleteIndicator = async () => {
    const ok = await indicatorConfirm.confirm({
      title: 'Eliminar indicador',
      message: `¿Eliminar "@${indicatorForm.form.slug}"? Esta accion no se puede deshacer.`,
      confirmLabel: 'Eliminar',
    });
    if (ok) await indicatorForm.remove();
  };

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.heroLeft}>
          <button className={styles.sidebarToggle} onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? '✕' : '☰'}
          </button>
          <div>
            <span className={styles.eyebrow}>Strategy Studio</span>
            <h1 className={styles.title}>Estrategias y indicadores custom</h1>
          </div>
        </div>
      </div>

      <div className={`${styles.layout} ${sidebarOpen ? styles.sidebarVisible : ''}`}>
        <div className={`${styles.sidebarWrap} ${sidebarOpen ? styles.sidebarWrapOpen : ''}`}>
          <StrategySidebar
            strategies={strategies}
            indicators={indicators}
            selectedStrategyId={strategyForm.selectedId}
            selectedIndicatorId={indicatorForm.selectedId}
            onSelectStrategy={(s) => { strategyForm.select(s); setSidebarOpen(false); }}
            onSelectIndicator={(i) => { indicatorForm.select(i); setSidebarOpen(false); }}
            onNewStrategy={() => { strategyForm.select(null); setActiveTab('strategy'); setSidebarOpen(false); }}
            onNewIndicator={() => { indicatorForm.select(null); setActiveTab('indicator'); setSidebarOpen(false); }}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </div>

        <div className={styles.main}>
          <div className={styles.editorTabs}>
            <button
              className={`${styles.editorTab} ${activeTab === 'strategy' ? styles.editorTabActive : ''}`}
              onClick={() => setActiveTab('strategy')}
            >
              Estrategia
            </button>
            <button
              className={`${styles.editorTab} ${activeTab === 'indicator' ? styles.editorTabActive : ''}`}
              onClick={() => setActiveTab('indicator')}
            >
              Indicador
            </button>
          </div>

          {activeTab === 'strategy' && (
            <>
              <StrategyEditor
                form={strategyForm.form}
                errors={strategyForm.errors}
                isSaving={strategyForm.isSaving}
                isValidating={strategyForm.isValidating}
                isBacktesting={strategyForm.isBacktesting}
                onUpdate={strategyForm.update}
                onSave={strategyForm.save}
                onDelete={handleDeleteStrategy}
                onValidate={strategyForm.runValidation}
                onBacktest={strategyForm.runBacktest}
                confirmDialog={strategyConfirm.dialog}
              />
              <ResultsPanel
                validationResult={strategyForm.validationResult}
                backtestResult={strategyForm.backtestResult}
                selectedStrategy={strategyForm.selected}
              />
            </>
          )}

          {activeTab === 'indicator' && (
            <IndicatorEditor
              form={indicatorForm.form}
              errors={indicatorForm.errors}
              isSaving={indicatorForm.isSaving}
              onUpdate={indicatorForm.update}
              onSave={indicatorForm.save}
              onDelete={handleDeleteIndicator}
              confirmDialog={indicatorConfirm.dialog}
            />
          )}
        </div>
      </div>

      {sidebarOpen && <div className={styles.overlay} onClick={() => setSidebarOpen(false)} />}
    </div>
  );
}

export default StrategyStudioPage;
