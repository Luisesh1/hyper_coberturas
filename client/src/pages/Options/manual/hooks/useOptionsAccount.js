import { useCallback, useEffect, useState } from 'react';
import { optionsApi, settingsApi } from '../../../../services/api';
import { usePolling } from './usePolling';

export const ACCOUNT_POLL_MS = 10000;
export const TRADES_POLL_MS = 30000;

/**
 * Cuenta, posiciones y órdenes abiertas (cada ~10 s) más el historial
 * (solo mientras `withTrades`). Todo requiere credenciales: con
 * `enabled: false` no se llama a nada.
 */
export function useOptionsAccount({ enabled, withTrades = false }) {
  const fetchSnapshot = useCallback(async () => {
    const [account, positions, openOrders] = await Promise.all([
      optionsApi.getAccount(),
      optionsApi.getPositions(),
      optionsApi.getOpenOrders(),
    ]);
    return {
      account: account || null,
      positions: Array.isArray(positions) ? positions : [],
      openOrders: Array.isArray(openOrders) ? openOrders : [],
    };
  }, []);

  const snapshot = usePolling(fetchSnapshot, { intervalMs: ACCOUNT_POLL_MS, enabled, key: 'account' });

  const fetchTrades = useCallback(() => optionsApi.getTrades({ days: 30 }), []);
  const trades = usePolling(fetchTrades, {
    intervalMs: TRADES_POLL_MS,
    enabled: enabled && withTrades,
    key: 'trades',
  });

  // Margen máximo de los límites globales, para «usado / máximo».
  const [limits, setLimits] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    settingsApi.getOptionsLimits()
      .then((d) => { if (alive) setLimits(d || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [enabled]);

  return {
    account: snapshot.data?.account || null,
    positions: snapshot.data?.positions || [],
    openOrders: snapshot.data?.openOrders || [],
    trades: Array.isArray(trades.data) ? trades.data : [],
    tradesLoading: trades.loading,
    limits,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh: snapshot.refresh,
  };
}
