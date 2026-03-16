/**
 * HedgePanel.jsx  --  Coberturas Automaticas (2-column layout)
 * Left: form always visible | Right: hedge list always visible
 * Orchestrator that composes HedgeForm, HedgeCard and CycleRow.
 */

import { useState, useEffect } from 'react';
import { useTradingContext } from '../../context/TradingContext';
import { formatAccountIdentity } from '../../utils/hyperliquidAccounts';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { HedgeForm } from './HedgeForm';
import { HedgeCard } from './HedgeCard';
import { CycleRow } from './CycleRow';
import styles from './HedgePanel.module.css';

export function HedgePanel({ selectedAsset }) {
  const {
    prices,
    hedges,
    accounts,
    defaultAccountId,
    isLoadingAccounts,
    createHedge,
    cancelHedge,
    refreshHedges,
    refreshAccountSummary,
    isPriceStale,
    isConnected,
  } = useTradingContext();

  const [asset, setAsset]           = useState(selectedAsset || 'BTC');
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [filterAccountId, setFilterAccountId] = useState('all');
  const [historyTab, setHistoryTab] = useState(false);
  const [confirm, setConfirm]       = useState(null);

  const priceUnavailable = !isConnected || isPriceStale;

  useEffect(() => {
    if (selectedAsset) setAsset(selectedAsset);
  }, [selectedAsset]);

  useEffect(() => { refreshHedges().catch(() => {}); }, [refreshHedges]);

  useEffect(() => {
    if (!selectedAccountId && defaultAccountId) {
      setSelectedAccountId(defaultAccountId);
    }
  }, [defaultAccountId, selectedAccountId]);

  const handleCancel = async (id, hedgeAsset) => {
    setConfirm({
      title: 'Cancelar cobertura',
      message: `¿Cancelar la cobertura de ${hedgeAsset}? Si tiene una posicion abierta, quedara sin proteccion automatica.`,
      confirmLabel: 'Cancelar cobertura',
      onConfirm: async () => {
        setConfirm(null);
        await cancelHedge(id);
      },
    });
  };

  // -- Derived lists --
  const activeHedges = hedges.filter((h) => ['waiting', 'entry_pending', 'entry_filled_pending_sl', 'open', 'open_protected', 'closing', 'cancel_pending', 'executing_open', 'executing_close'].includes(h.status));
  const cancelledHedges = hedges.filter((h) => ['cancelled', 'error'].includes(h.status));
  const completedCycles = hedges
    .flatMap(h => (h.cycles || []).map(c => ({
      ...c,
      asset: h.asset,
      label: h.label,
      leverage: h.leverage,
      direction: h.direction,
      hedgeId: h.id,
      accountId: h.accountId,
      account: h.account,
    })))
    .sort((a, b) => b.closedAt - a.closedAt);

  const isVisibleForFilter = (accountId) => filterAccountId === 'all' || Number(accountId) === Number(filterAccountId);
  const visibleActiveHedges = activeHedges.filter((hedge) => isVisibleForFilter(hedge.accountId));
  const visibleCancelledHedges = cancelledHedges.filter((hedge) => isVisibleForFilter(hedge.accountId));
  const visibleCompletedCycles = completedCycles.filter((cycle) => isVisibleForFilter(cycle.accountId));

  return (
    <div className={styles.container}>
      {/* -- Header -- */}
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Coberturas Automaticas</h2>
          <p className={styles.subtitle}>
            GTC nativo + SL nativo · Isolated · ciclos automaticos
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={() => refreshHedges()} title="Refrescar" aria-label="Refrescar coberturas">↻</button>
      </div>

      {/* Stale price warning */}
      {priceUnavailable && (
        <div className={styles.staleBanner}>
          ⚠ {!isConnected ? 'Sin conexion al servidor' : 'Precios desactualizados'} — la creacion de coberturas podria usar datos obsoletos
        </div>
      )}

      {/* -- 2-column body -- */}
      <div className={styles.body}>

        {/* -- LEFT: Form -- */}
        <HedgeForm
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          setSelectedAccountId={setSelectedAccountId}
          isLoadingAccounts={isLoadingAccounts}
          refreshAccountSummary={refreshAccountSummary}
          prices={prices}
          asset={asset}
          setAsset={setAsset}
          isConnected={isConnected}
          isPriceStale={isPriceStale}
          createHedge={createHedge}
        />

        {/* -- RIGHT: Hedge list -- */}
        <div className={styles.listCol}>
          <div className={styles.filterRow}>
            <label className={styles.filterLabel} htmlFor="hedge-account-filter">Filtro cuenta</label>
            <select
              id="hedge-account-filter"
              className={styles.filterSelect}
              value={filterAccountId}
              onChange={(event) => setFilterAccountId(event.target.value)}
            >
              <option value="all">Todas las cuentas</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{formatAccountIdentity(account)}</option>
              ))}
            </select>
          </div>

          {/* Tab bar */}
          <div className={styles.tabBar} role="tablist" aria-label="Filtro de coberturas">
            <button
              type="button"
              role="tab"
              aria-selected={!historyTab}
              className={`${styles.tabPill} ${!historyTab ? styles.tabPillActive : ''}`}
              onClick={() => setHistoryTab(false)}>
              <span className={styles.tabLabel}>Activas</span>
              <span className={`${styles.tabBadge} ${!historyTab ? styles.tabBadgeActive : ''}`}>
                {visibleActiveHedges.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={historyTab}
              className={`${styles.tabPill} ${historyTab ? styles.tabPillActive : ''}`}
              onClick={() => setHistoryTab(true)}>
              <span className={styles.tabLabel}>Historial</span>
              <span className={`${styles.tabBadge} ${historyTab ? styles.tabBadgeActive : ''}`}>
                {visibleCompletedCycles.length + visibleCancelledHedges.length}
              </span>
            </button>
          </div>

          <div className={styles.hedgeList}>
            {/* Tab: Activas */}
            {!historyTab && (
              <>
                {visibleActiveHedges.length === 0 && (
                  <div className={styles.empty}>
                    <span>No hay coberturas activas</span>
                    <span className={styles.emptyHint}>Usa el formulario de la izquierda para crear tu primera cobertura</span>
                  </div>
                )}
                {visibleActiveHedges.map((h) => (
                  <HedgeCard
                    key={h.id}
                    hedge={h}
                    currentPrice={prices[h.asset] ? parseFloat(prices[h.asset]) : null}
                    onCancel={handleCancel}
                  />
                ))}
              </>
            )}

            {/* Tab: Historial */}
            {historyTab && (
              <>
                {visibleCompletedCycles.length === 0 && visibleCancelledHedges.length === 0 && (
                  <div className={styles.empty}>
                    <span>No hay historial aun</span>
                    <span className={styles.emptyHint}>Los ciclos completados y coberturas canceladas apareceran aqui</span>
                  </div>
                )}
                {visibleCompletedCycles.map((c, i) => (
                  <CycleRow key={`${c.hedgeId}-${c.cycleId}-${i}`} cycle={c} />
                ))}
                {visibleCancelledHedges.map((h) => (
                  <HedgeCard key={h.id} hedge={h} currentPrice={null} onCancel={null} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Confirm dialog */}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        onConfirm={confirm?.onConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
