/**
 * TradingContext.jsx
 *
 * Estado global de la aplicacion:
 *   - Precios en tiempo real (via WS)
 *   - Estado de la cuenta y posiciones
 *   - Coberturas automaticas (hedges)
 *   - Notificaciones toast
 */

import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

const STALE_THRESHOLD_MS = 60_000;
import { useWebSocket } from '../hooks/useWebSocket';
import { tradingApi, hedgeApi } from '../services/api';

const TradingContext = createContext(null);

export function TradingProvider({ children }) {
  const [prices, setPrices]                     = useState({});
  const [account, setAccount]                   = useState(null);
  const [isLoadingAccount, setIsLoadingAccount] = useState(false);
  const [hedges, setHedges]                     = useState([]);
  const [notifications, setNotifications]       = useState([]);
  const [isPriceStale, setIsPriceStale]         = useState(false);
  const notifIdRef = useRef(0);
  const lastPriceAtRef = useRef(null);

  // ------------------------------------------------------------------
  // Notificaciones toast
  // ------------------------------------------------------------------
  const addNotification = useCallback((type, message) => {
    const id = ++notifIdRef.current;
    setNotifications((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setNotifications((prev) => prev.filter((n) => n.id !== id)), 5000);
  }, []);

  // ------------------------------------------------------------------
  // WebSocket: precios + eventos de coberturas en tiempo real
  // ------------------------------------------------------------------
  const handleWsMessage = useCallback((msg) => {
    // Precios en tiempo real
    if (msg.type === 'hl_message' && msg.data?.channel === 'allMids' && msg.data?.data?.mids) {
      lastPriceAtRef.current = Date.now();
      setIsPriceStale(false);
      setPrices(msg.data.data.mids);
    }

    // Eventos de coberturas ejecutadas en el backend
    if (msg.type === 'hedge_event') {
      const { event, hedge } = msg;

      setHedges((prev) => {
        const exists = prev.find((h) => h.id === hedge.id);
        if (exists) return prev.map((h) => (h.id === hedge.id ? hedge : h));
        return [hedge, ...prev];
      });

      const notifMap = {
        created:       ['info',    `Cobertura creada: ${hedge.asset} entrada ≤ $${hedge.entryPrice}`],
        opened:        ['success', `Cobertura activada: SHORT ${hedge.asset} abierto a $${hedge.openPrice}`],
        cycleComplete: ['success', `Ciclo #${msg.cycle?.cycleId} completado: SHORT ${hedge.asset} cerrado a $${msg.cycle?.closePrice}`],
        cancelled:     ['info',    `Cobertura #${hedge.id} cancelada`],
        error:         ['error',   `Error en cobertura #${hedge.id}: ${msg.message}`],
      };

      const [type, message] = notifMap[event] || [];
      if (type) addNotification(type, message);
    }
  }, [addNotification]);

  const { isConnected } = useWebSocket(handleWsMessage);

  // Detectar precios obsoletos: si no llega ningún tick en 60s, marcar como stale
  useEffect(() => {
    const interval = setInterval(() => {
      const last = lastPriceAtRef.current;
      if (last && (Date.now() - last) > STALE_THRESHOLD_MS) {
        setIsPriceStale(true);
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  // ------------------------------------------------------------------
  // Cuenta
  // ------------------------------------------------------------------
  const refreshAccount = useCallback(async () => {
    setIsLoadingAccount(true);
    try {
      const data = await tradingApi.getAccount();
      setAccount(data);
    } catch (err) {
      addNotification('error', `Error al cargar cuenta: ${err.message}`);
    } finally {
      setIsLoadingAccount(false);
    }
  }, [addNotification]);

  // ------------------------------------------------------------------
  // Operaciones manuales
  // ------------------------------------------------------------------
  const openPosition = useCallback(async (params) => {
    try {
      const result = await tradingApi.openPosition(params);
      addNotification('success', `${params.side.toUpperCase()} ${params.asset} abierto a mercado`);
      await refreshAccount();
      return result;
    } catch (err) {
      addNotification('error', `Error al abrir: ${err.message}`);
      throw err;
    }
  }, [addNotification, refreshAccount]);

  const closePosition = useCallback(async (params) => {
    try {
      const result = await tradingApi.closePosition(params);
      addNotification('success', `Posicion ${params.asset} cerrada a mercado`);
      await refreshAccount();
      return result;
    } catch (err) {
      addNotification('error', `Error al cerrar: ${err.message}`);
      throw err;
    }
  }, [addNotification, refreshAccount]);

  // ------------------------------------------------------------------
  // Coberturas automaticas
  // ------------------------------------------------------------------
  const refreshHedges = useCallback(async () => {
    try {
      const data = await hedgeApi.getAll();
      setHedges(data);
    } catch (err) {
      addNotification('error', `Error al cargar coberturas: ${err.message}`);
    }
  }, [addNotification]);

  const createHedge = useCallback(async (params) => {
    try {
      const hedge = await hedgeApi.create(params);
      // No actualizamos hedges aquí: el evento 'created' del WS es la fuente de verdad
      // y evita el duplicado por race condition entre setState y el evento WS
      return hedge;
    } catch (err) {
      addNotification('error', `Error al crear cobertura: ${err.message}`);
      throw err;
    }
  }, [addNotification]);

  const cancelHedge = useCallback(async (id) => {
    try {
      const hedge = await hedgeApi.cancel(id);
      setHedges((prev) => prev.map((h) => (h.id === id ? hedge : h)));
      addNotification('info', `Cobertura #${id} cancelada`);
    } catch (err) {
      addNotification('error', `Error al cancelar: ${err.message}`);
    }
  }, [addNotification]);

  return (
    <TradingContext.Provider
      value={{
        prices,
        account,
        isLoadingAccount,
        hedges,
        notifications,
        isConnected,
        isPriceStale,
        refreshAccount,
        openPosition,
        closePosition,
        refreshHedges,
        createHedge,
        cancelHedge,
      }}
    >
      {children}
    </TradingContext.Provider>
  );
}

export function useTradingContext() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTradingContext debe usarse dentro de TradingProvider');
  return ctx;
}
