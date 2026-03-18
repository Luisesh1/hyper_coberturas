import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const NotificationsContext = createContext(null);

export function NotificationsProvider({ children }) {
  const [notifications, setNotifications] = useState([]);
  const notifIdRef = useRef(0);
  const timersRef = useRef(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timerId) => clearTimeout(timerId));
      timers.clear();
    };
  }, []);

  const addNotification = useCallback((type, message, duration = 5000) => {
    const id = ++notifIdRef.current;
    setNotifications((prev) => [...prev, { id, type, message }]);
    const timerId = setTimeout(() => {
      timersRef.current.delete(id);
      setNotifications((prev) => prev.filter((item) => item.id !== id));
    }, duration);
    timersRef.current.set(id, timerId);
  }, []);

  const removeNotification = useCallback((id) => {
    const timerId = timersRef.current.get(id);
    if (timerId != null) {
      clearTimeout(timerId);
      timersRef.current.delete(id);
    }
    setNotifications((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const value = useMemo(() => ({
    notifications,
    addNotification,
    removeNotification,
  }), [notifications, addNotification, removeNotification]);

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications debe usarse dentro de TradingProvider');
  return ctx;
}
