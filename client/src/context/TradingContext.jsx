/**
 * TradingContext.jsx
 *
 * Mantiene providers separados por dominio:
 *   - NotificationsContext
 *   - MarketContext
 *   - AccountContext
 *   - HedgeContext
 *
 * useTradingContext() se conserva como fachada agregada para no romper la UI.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { hedgeApi, tradingApi } from '../services/api';

const STALE_THRESHOLD_MS = 60_000;

const NotificationsContext = createContext(null);
const MarketContext = createContext(null);
const AccountContext = createContext(null);
const HedgeContext = createContext(null);

function NotificationsProvider({ children }) {
  const [notifications, setNotifications] = useState([]);
  const notifIdRef = useRef(0);

  const addNotification = useCallback((type, message, duration = 5000) => {
    const id = ++notifIdRef.current;
    setNotifications((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setNotifications((prev) => prev.filter((item) => item.id !== id));
    }, duration);
  }, []);

  const value = useMemo(() => ({
    notifications,
    addNotification,
  }), [notifications, addNotification]);

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications debe usarse dentro de TradingProvider');
  return ctx;
}

function MarketProvider({ children, onMessage }) {
  const [prices, setPrices] = useState({});
  const [isPriceStale, setIsPriceStale] = useState(false);
  const lastPriceAtRef = useRef(null);

  const handleWsMessage = useCallback((msg) => {
    if (msg.type === 'hl_message' && msg.data?.channel === 'allMids' && msg.data?.data?.mids) {
      lastPriceAtRef.current = Date.now();
      setIsPriceStale(false);
      setPrices(msg.data.data.mids);
    }
    onMessage?.(msg);
  }, [onMessage]);

  const { isConnected } = useWebSocket(handleWsMessage);

  useEffect(() => {
    const interval = setInterval(() => {
      const last = lastPriceAtRef.current;
      if (last && (Date.now() - last) > STALE_THRESHOLD_MS) {
        setIsPriceStale(true);
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  const value = useMemo(() => ({
    prices,
    isConnected,
    isPriceStale,
  }), [prices, isConnected, isPriceStale]);

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

function useMarket() {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error('useMarket debe usarse dentro de TradingProvider');
  return ctx;
}

function AccountProvider({ children }) {
  const { addNotification } = useNotifications();
  const [account, setAccount] = useState(null);
  const [isLoadingAccount, setIsLoadingAccount] = useState(false);

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

  const value = useMemo(() => ({
    account,
    isLoadingAccount,
    refreshAccount,
    openPosition,
    closePosition,
  }), [account, isLoadingAccount, refreshAccount, openPosition, closePosition]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error('useAccount debe usarse dentro de TradingProvider');
  return ctx;
}

function HedgeProvider({ children }) {
  const { addNotification } = useNotifications();
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
    const notifMap = {
      created: ['info', 5000, `Cobertura creada: ${hedge.asset} entrada ≤ $${hedge.entryPrice}`],
      opened: ['alert', 12000, `POSICION ${dir} ABIERTA\n${hedge.asset} · $${Number(hedge.openPrice).toLocaleString()} · ${hedge.leverage}x Isolated`],
      reconciled: ['info', 4000, `Cobertura #${hedge.id} reconciliada con el exchange`],
      protection_missing: ['error', 8000, `Cobertura #${hedge.id} sin proteccion confirmada. Reintentando SL...`],
      cycleComplete: ['success', 6000, `Ciclo #${msg.cycle?.cycleId} completado: ${dir} ${hedge.asset} cerrado a $${msg.cycle?.closePrice}`],
      cancelled: ['info', 5000, `Cobertura #${hedge.id} cancelada`],
      error: ['error', 8000, `Error en cobertura #${hedge.id}: ${msg.message}`],
    };
    const [type, duration, message] = notifMap[event] || [];
    if (type) addNotification(type, message, duration);
  }, [addNotification]);

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
      return await hedgeApi.create(params);
    } catch (err) {
      addNotification('error', `Error al crear cobertura: ${err.message}`);
      throw err;
    }
  }, [addNotification]);

  const cancelHedge = useCallback(async (id) => {
    try {
      const hedge = await hedgeApi.cancel(id);
      setHedges((prev) => prev.map((item) => (item.id === id ? hedge : item)));
      addNotification('info', `Cobertura #${id} cancelada`);
    } catch (err) {
      addNotification('error', `Error al cancelar: ${err.message}`);
    }
  }, [addNotification]);

  const value = useMemo(() => ({
    hedges,
    refreshHedges,
    createHedge,
    cancelHedge,
    handleHedgeEvent,
  }), [hedges, refreshHedges, createHedge, cancelHedge, handleHedgeEvent]);

  return <HedgeContext.Provider value={value}>{children}</HedgeContext.Provider>;
}

function useHedges() {
  const ctx = useContext(HedgeContext);
  if (!ctx) throw new Error('useHedges debe usarse dentro de TradingProvider');
  return ctx;
}

function TradingProviders({ children }) {
  const hedgeMessageRef = useRef(null);

  return (
    <NotificationsProvider>
      <HedgeProvider>
        <HedgeContextBridge onReady={(handler) => { hedgeMessageRef.current = handler; }} />
        <MarketProvider onMessage={(msg) => hedgeMessageRef.current?.(msg)}>
          <AccountProvider>{children}</AccountProvider>
        </MarketProvider>
      </HedgeProvider>
    </NotificationsProvider>
  );
}

function HedgeContextBridge({ onReady }) {
  const { handleHedgeEvent } = useHedges();

  useEffect(() => {
    onReady(handleHedgeEvent);
  }, [handleHedgeEvent, onReady]);

  return null;
}

export function TradingProvider({ children }) {
  return <TradingProviders>{children}</TradingProviders>;
}

export function useTradingContext() {
  const notifications = useNotifications();
  const market = useMarket();
  const account = useAccount();
  const hedges = useHedges();

  return {
    ...market,
    ...account,
    ...hedges,
    notifications: notifications.notifications,
    addNotification: notifications.addNotification,
  };
}
