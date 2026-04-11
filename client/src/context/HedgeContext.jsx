import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { hedgeApi } from '../services/api';
import { formatAccountIdentity } from '../utils/hyperliquidAccounts';
import { useNotifications } from './NotificationsContext';
import { useAsyncAction } from '../hooks/useAsyncAction';

const HedgeContext = createContext(null);

export function HedgeProvider({ children }) {
  const { addNotification } = useNotifications();
  const { run } = useAsyncAction();
  const [hedges, setHedges] = useState([]);

  const handleHedgeEvent = useCallback((msg) => {
    if (msg.type !== 'hedge_event') return;
    const { event, hedge } = msg;

    setHedges((prev) => {
      const exists = prev.find((item) => item.id === hedge.id);
      if (exists) return prev.map((item) => (item.id === hedge.id ? hedge : item));
      return [hedge, ...prev];
    });

    const dir = (hedge.direction || 'short').toUpperCase();
    const accountLabel = formatAccountIdentity(hedge.account);
    const notifMap = {
      created: ['info', 5000, `Cobertura creada\n${accountLabel} · ${hedge.asset} · entrada $${hedge.entryPrice}`],
      opened: ['alert', 12000, `POSICION ${dir} ABIERTA\n${accountLabel}\n${hedge.asset} · $${Number(hedge.openPrice).toLocaleString()} · ${hedge.leverage}x Isolated`],
      reconciled: ['info', 4000, `Cobertura reconciliada\n${accountLabel} · #${hedge.id}`],
      protection_missing: ['error', 8000, `Cobertura sin proteccion confirmada\n${accountLabel} · #${hedge.id}`],
      cycleComplete: ['success', 6000, `Ciclo completado\n${accountLabel}\n${dir} ${hedge.asset} cerrado a $${msg.cycle?.closePrice}`],
      cancelled: ['info', 5000, `Cobertura cancelada\n${accountLabel} · #${hedge.id}`],
      error: ['error', 8000, `Error en cobertura\n${accountLabel} · #${hedge.id}: ${msg.message}`],
    };
    const [type, duration, message] = notifMap[event] || [];
    if (type) addNotification(type, message, duration);
  }, [addNotification]);

  const refreshHedges = useCallback(async ({ accountId } = {}) => {
    return run(async () => {
      const data = await hedgeApi.getAll({ accountId });
      setHedges(data);
      return data;
    }, 'Error al cargar coberturas');
  }, [run]);

  const createHedge = useCallback(async (params) => {
    return run(() => hedgeApi.create(params), 'Error al crear cobertura');
  }, [run]);

  const cancelHedge = useCallback(async (id) => {
    return run(async () => {
      const hedge = await hedgeApi.cancel(id);
      setHedges((prev) => prev.map((item) => (item.id === id ? hedge : item)));
      addNotification('info', `Cobertura cancelada\n${formatAccountIdentity(hedge.account)} · #${id}`);
    }, 'Error al cancelar').catch(() => {});
  }, [addNotification, run]);

  const value = useMemo(() => ({
    hedges,
    refreshHedges,
    createHedge,
    cancelHedge,
    handleHedgeEvent,
  }), [hedges, refreshHedges, createHedge, cancelHedge, handleHedgeEvent]);

  return <HedgeContext.Provider value={value}>{children}</HedgeContext.Provider>;
}

export function useHedges() {
  const ctx = useContext(HedgeContext);
  if (!ctx) throw new Error('useHedges debe usarse dentro de TradingProvider');
  return ctx;
}
