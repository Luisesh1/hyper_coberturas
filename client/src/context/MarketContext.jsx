import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

const STALE_THRESHOLD_MS = 60_000;
const MarketContext = createContext(null);

export function MarketProvider({ children, onMessage }) {
  const [prices, setPrices] = useState({});
  const [isPriceStale, setIsPriceStale] = useState(false);
  const lastPriceAtRef = useRef(null);
  // `wsReady`: socket autenticado (el servidor ya respondió `connected`).
  const [wsReady, setWsReady] = useState(false);
  const listenersRef = useRef(new Set());

  const handleWsMessage = useCallback((msg) => {
    if (msg.type === 'hl_message' && msg.data?.channel === 'allMids' && msg.data?.data?.mids) {
      lastPriceAtRef.current = Date.now();
      setIsPriceStale(false);
      setPrices(msg.data.data.mids);
    }
    if (msg.type === 'connected') setWsReady(true);
    for (const fn of listenersRef.current) fn(msg);
    onMessage?.(msg);
  }, [onMessage]);

  const { isConnected, send } = useWebSocket(handleWsMessage);
  if (!isConnected && wsReady) setWsReady(false);

  // Suscribe un oyente a todos los mensajes del socket; devuelve la baja.
  const addWsListener = useCallback((fn) => {
    listenersRef.current.add(fn);
    return () => listenersRef.current.delete(fn);
  }, []);

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
    wsReady,
    wsSend: send,
    addWsListener,
  }), [prices, isConnected, isPriceStale, wsReady, send, addWsListener]);

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

// Variante tolerante: devuelve null fuera del proveedor (tests, páginas sueltas).
export function useOptionalMarket() {
  return useContext(MarketContext);
}

export function useMarket() {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error('useMarket debe usarse dentro de TradingProvider');
  return ctx;
}
