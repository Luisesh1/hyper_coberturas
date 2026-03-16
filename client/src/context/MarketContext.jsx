import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

const STALE_THRESHOLD_MS = 60_000;
const MarketContext = createContext(null);

export function MarketProvider({ children, onMessage }) {
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

export function useMarket() {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error('useMarket debe usarse dentro de TradingProvider');
  return ctx;
}
