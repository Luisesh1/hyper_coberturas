import { useCallback, useEffect, useState } from 'react';
import { botsApi, strategiesApi } from '../../services/api';
import { useTradingContext } from '../../context/TradingContext';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog';
import { AccountAutocomplete } from '../../components/shared/AccountAutocomplete';
import { Spinner } from '../../components/shared/Spinner';
import { useBotForm } from './hooks/useBotForm';
import { BotSidebar } from './components/BotSidebar';
import { BotActionBar } from './components/BotActionBar';
import { BotLiveStatus } from './components/BotLiveStatus';
import { BotRunLogs } from './components/BotRunLogs';
import styles from './BotsPage.module.css';

const TIMEFRAMES = ['1m', '5m', '15m', '1h'];

function BotsPage({ selectedAsset }) {
  const { accounts, defaultAccountId, isLoadingAccounts, lastBotEvent, addNotification } = useTradingContext();
  const [bots, setBots] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { dialog, confirm } = useConfirmAction();

  const loadData = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([botsApi.list(), strategiesApi.list()]);
      setBots(b);
      setStrategies(s);
    } catch (err) {
      addNotification('error', `Error al cargar: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [addNotification]);

  useEffect(() => { loadData(); }, [loadData]);

  const botForm = useBotForm({ bots, selectedAsset, defaultAccountId, onReload: loadData, addNotification });

  useEffect(() => {
    if (!lastBotEvent) return;
    loadData();
    botForm.refreshRuns();
  }, [lastBotEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = async (act) => {
    if (act === 'delete' || act === 'stop') {
      const ok = await confirm({
        title: act === 'delete' ? 'Eliminar bot' : 'Detener bot',
        message: act === 'delete'
          ? `¿Eliminar bot #${botForm.selected?.id}? Esta accion no se puede deshacer.`
          : `¿Detener bot #${botForm.selected?.id}? Se cancelaran las ordenes pendientes.`,
        confirmLabel: act === 'delete' ? 'Eliminar' : 'Detener',
      });
      if (!ok) return;
    }
    await botForm.action(act);
  };

  const handleSave = (e) => { e?.preventDefault(); botForm.save(); };

  const selectedStrategy = strategies.find((s) => Number(s.id) === Number(botForm.form.strategyId)) || null;
  const activeBots = bots.filter((b) => b.status === 'active').length;
  const recoveringBots = bots.filter((b) => b.runtime?.state && b.runtime.state !== 'healthy').length;

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.heroLeft}>
          <button className={styles.sidebarToggle} onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? '✕' : '☰'}
          </button>
          <div>
            <span className={styles.eyebrow}>Bot Control Room</span>
            <h1 className={styles.title}>Bots automatizados</h1>
          </div>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}><strong>{bots.length}</strong><span>total</span></div>
          <div className={`${styles.stat} ${styles.statGreen}`}><strong>{activeBots}</strong><span>activos</span></div>
          {recoveringBots > 0 && <div className={`${styles.stat} ${styles.statRed}`}><strong>{recoveringBots}</strong><span>en recovery</span></div>}
        </div>
      </div>

      <div className={styles.layout}>
        <div className={`${styles.sidebarWrap} ${sidebarOpen ? styles.sidebarWrapOpen : ''}`}>
          <BotSidebar
            bots={bots}
            selectedBotId={botForm.selectedId}
            onSelectBot={(b) => { botForm.select(b); setSidebarOpen(false); }}
            onNewBot={() => { botForm.select(null); setSidebarOpen(false); }}
          />
        </div>

        <div className={styles.main}>
          {selectedStrategy && (
            <div className={styles.strategySummary}>
              <div><span className={styles.summaryLabel}>Estrategia</span><strong>{selectedStrategy.name}</strong></div>
              <div><span className={styles.summaryLabel}>Backtest</span><strong>{selectedStrategy.latestBacktest?.summary?.trades ?? 0} trades</strong></div>
              <div><span className={styles.summaryLabel}>Win rate</span><strong>{selectedStrategy.latestBacktest?.summary?.winRate ?? '—'}%</strong></div>
              <div><span className={styles.summaryLabel}>Monto</span><strong>${Number(botForm.form.size || 0).toFixed(2)}</strong></div>
            </div>
          )}

          <form className={styles.editor} onSubmit={handleSave}>
            <div className={styles.editorHeader}>
              <h2 className={styles.editorTitle}>{botForm.form.id ? `Bot #${botForm.form.id}` : 'Nuevo bot'}</h2>
              {botForm.selected && (
                <span className={`${styles.statusBadge} ${styles[`status_${botForm.selected.status}`]}`}>
                  {botForm.selected.status}
                </span>
              )}
            </div>

            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>Estrategia *</span>
                <select value={botForm.form.strategyId} onChange={(e) => botForm.update('strategyId', e.target.value)}>
                  <option value="">Selecciona...</option>
                  {strategies.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.timeframe}</option>)}
                </select>
                {botForm.errors.strategyId && <span className={styles.fieldError}>{botForm.errors.strategyId}</span>}
              </label>
              <label className={styles.field}>
                <span>Asset</span>
                <input value={botForm.form.asset} onChange={(e) => botForm.update('asset', e.target.value.toUpperCase())} placeholder="BTC" />
              </label>
              <label className={styles.field}>
                <span>Timeframe</span>
                <select value={botForm.form.timeframe} onChange={(e) => botForm.update('timeframe', e.target.value)}>
                  {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
                </select>
              </label>
              <label className={styles.field}>
                <span>Monto USD *</span>
                <input value={botForm.form.size} onChange={(e) => botForm.update('size', e.target.value)} placeholder="100" />
                {botForm.errors.size && <span className={styles.fieldError}>{botForm.errors.size}</span>}
              </label>
              <label className={styles.field}>
                <span>Leverage</span>
                <input value={botForm.form.leverage} onChange={(e) => botForm.update('leverage', e.target.value)} placeholder="10" />
                {botForm.errors.leverage && <span className={styles.fieldError}>{botForm.errors.leverage}</span>}
              </label>
              <label className={styles.field}>
                <span>Margin mode</span>
                <select value={botForm.form.marginMode} onChange={(e) => botForm.update('marginMode', e.target.value)}>
                  <option value="cross">Cross</option>
                  <option value="isolated">Isolated</option>
                </select>
              </label>
              <label className={styles.field}>
                <span>Stop loss %</span>
                <input value={botForm.form.stopLossPct} onChange={(e) => botForm.update('stopLossPct', e.target.value)} placeholder="1.5" />
                {botForm.errors.stopLossPct && <span className={styles.fieldError}>{botForm.errors.stopLossPct}</span>}
              </label>
              <label className={styles.field}>
                <span>Take profit %</span>
                <input value={botForm.form.takeProfitPct} onChange={(e) => botForm.update('takeProfitPct', e.target.value)} placeholder="3" />
                {botForm.errors.takeProfitPct && <span className={styles.fieldError}>{botForm.errors.takeProfitPct}</span>}
              </label>
            </div>

            <AccountAutocomplete
              accounts={accounts}
              selectedAccountId={botForm.form.accountId}
              onSelect={(a) => botForm.update('accountId', a.id)}
              label="Cuenta Hyperliquid *"
              disabled={isLoadingAccounts || accounts.length === 0}
              placeholder="Selecciona una cuenta"
            />
            {botForm.errors.accountId && <span className={styles.fieldError}>{botForm.errors.accountId}</span>}

            <label className={styles.codeField}>
              <span>Params runtime (JSON)</span>
              <textarea value={botForm.form.params} onChange={(e) => botForm.update('params', e.target.value)} rows={6} />
              {botForm.errors.params && <span className={styles.fieldError}>{botForm.errors.params}</span>}
            </label>

            <BotActionBar
              bot={botForm.selected}
              isSaving={botForm.isSaving}
              isActing={botForm.isActing}
              onSave={handleSave}
              onAction={handleAction}
            />
          </form>

          <div className={styles.bottomGrid}>
            <BotLiveStatus bot={botForm.selected} />
            <BotRunLogs runs={botForm.runs} />
          </div>
        </div>
      </div>

      {sidebarOpen && <div className={styles.overlay} onClick={() => setSidebarOpen(false)} />}

      {dialog.open && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          variant={dialog.variant}
          onConfirm={dialog.onConfirm}
          onCancel={dialog.onCancel}
        />
      )}
    </div>
  );
}

export default BotsPage;
