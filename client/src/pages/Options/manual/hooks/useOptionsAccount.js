import { useCallback, useEffect, useState } from 'react';
import { optionsApi, settingsApi } from '../../../../services/api';
import { useOptionalMarket } from '../../../../context/MarketContext';
import { usePolling } from './usePolling';

export const ACCOUNT_POLL_MS = 10000;
export const TRADES_POLL_MS = 30000;
const noopRefresh = async () => {};

/**
 * Cuenta, posiciones y órdenes abiertas más el historial (solo mientras
 * `withTrades`). Con el WebSocket de la app listo, el servidor empuja la
 * cuenta en tiempo real (un stream de Binance por usuario, compartido por
 * todas las pestañas) y no se sondea por REST; sin socket se vuelve al
 * sondeo cada ~10 s. Todo requiere credenciales: con `enabled: false` no se
 * llama a nada.
 */
export function useOptionsAccount({ enabled, withTrades = false }) {
  const market = useOptionalMarket();
  const wsReady = Boolean(market?.wsReady);
  const wsSend = market?.wsSend;
  const addWsListener = market?.addWsListener;
  const [pushed, setPushed] = useState(null);

  useEffect(() => {
    if (!enabled || !wsReady || !wsSend || !addWsListener) return undefined;
    const off = addWsListener((msg) => {
      if (msg?.type === 'options_account' && msg.data) setPushed(msg.data);
    });
    wsSend({ type: 'options_account_subscribe' });
    return () => {
      off();
      wsSend({ type: 'options_account_unsubscribe' });
    };
  }, [enabled, wsReady, wsSend, addWsListener]);

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

  const live = enabled && wsReady && pushed != null;
  const snapshot = usePolling(fetchSnapshot, { intervalMs: ACCOUNT_POLL_MS, enabled: enabled && !live, key: 'account' });

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

  // Un empuje con error y sin datos previos se muestra como error; con datos
  // previos (p. ej. 429 de Binance) se siguen mostrando marcados `stale`.
  const source = live ? pushed : snapshot.data;
  const pushedError = live && pushed.error && !pushed.updatedAt ? new Error(pushed.error.message) : null;
  return {
    account: source?.account || null,
    positions: source?.positions || [],
    openOrders: source?.openOrders || [],
    stale: live ? Boolean(pushed.stale) : false,
    live,
    trades: Array.isArray(trades.data) ? trades.data : [],
    tradesLoading: trades.loading,
    limits,
    loading: live ? false : snapshot.loading,
    error: live ? pushedError : snapshot.error,
    // En vivo el servidor ya relee y empuja tras cada orden/cancelación.
    refresh: live ? noopRefresh : snapshot.refresh,
  };
}
