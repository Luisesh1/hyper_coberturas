/**
 * useDevLogStream.js
 *
 * Hook que mantiene un buffer local de los últimos N logs de desarrollo
 * recibidos vía WS (mensajes con `type: 'dev_log_event'`) más los obtenidos
 * en el snapshot inicial vía REST. Solo se usa dentro de `<DevLogPanel />`,
 * que a su vez sólo se monta en `import.meta.env.DEV`.
 *
 * Para evitar acoplar al hook genérico `useWebSocket` (que ya es usado por
 * otros componentes con su propia política de mensajes), abrimos una
 * conexión WS dedicada al canal `/ws`. El costo extra en dev es 1 socket
 * adicional, lo cual es aceptable.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { devApi } from '../services/api';
import { getToken } from '../services/sessionStore';

const MAX_BUFFER = 500;

function getWsUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

export function useDevLogStream({ enabled = true } = {}) {
  const [entries, setEntries] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const pausedRef = useRef(false);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const unmountedRef = useRef(false);

  const appendEntry = useCallback((entry) => {
    if (!entry || pausedRef.current) return;
    setEntries((prev) => {
      const next = prev.concat(entry);
      return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    devApi.clearLogs().catch(() => { /* noop: el panel local quedó limpio */ });
  }, []);

  const setPaused = useCallback((paused) => {
    pausedRef.current = paused;
  }, []);

  // Snapshot inicial via REST: pre-puebla el buffer con los logs ya
  // capturados antes de que se abriera el WS (típicamente errores que
  // ocurrieron durante el arranque).
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    devApi.getLogsSnapshot()
      .then((data) => {
        if (cancelled) return;
        const initial = Array.isArray(data?.entries) ? data.entries : [];
        setEntries(initial.slice(-MAX_BUFFER));
      })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); });
    return () => { cancelled = true; };
  }, [enabled]);

  // WebSocket dedicado para recibir dev_log_event en tiempo real.
  useEffect(() => {
    if (!enabled) return undefined;
    unmountedRef.current = false;

    function connect() {
      if (unmountedRef.current) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current) { ws.close(); return; }
        setIsConnected(true);
        const token = getToken();
        if (token) ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === 'dev_log_event' && msg.entry) {
            appendEntry(msg.entry);
          }
        } catch { /* ignorar JSON inválido */ }
      };

      ws.onclose = () => {
        setIsConnected(false);
        if (!unmountedRef.current) {
          reconnectTimerRef.current = setTimeout(connect, 3_000);
        }
      };

      ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      try { wsRef.current?.close(); } catch { /* noop */ }
    };
  }, [enabled, appendEntry]);

  return {
    entries,
    isConnected,
    error,
    clear,
    setPaused,
  };
}
