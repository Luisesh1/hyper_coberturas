/**
 * useWebSocket.js
 *
 * Hook para conectarse al servidor WebSocket del backend.
 * Mecanismos de recuperación:
 *   - Reconexión automática con backoff exponencial (2s → 4s → … → 30s)
 *   - Ping propio cada 25s para mantener viva la conexión
 *   - Watchdog: si no llega ningún mensaje en 60s → forzar reconexión
 *   - URL relativa → pasa por el proxy de Vite (evita problemas CORS/host)
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { getToken } from '../services/sessionStore';

// Construir URL WS relativa al host actual, incluyendo el token JWT
function getWsUrl() {
  const base  = import.meta.env.VITE_WS_URL || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

const PING_INTERVAL_MS      = 25_000;  // enviar ping cada 25s
const STALE_THRESHOLD_MS    = 60_000;  // reconectar si no llegan datos en 60s
const RECONNECT_BASE_MS     =  2_000;  // delay inicial de reconexión
const RECONNECT_MAX_MS      = 30_000;  // delay máximo de reconexión

export function useWebSocket(onMessage) {
  const wsRef          = useRef(null);
  const onMessageRef   = useRef(onMessage);
  const reconnectRef   = useRef(null);
  const pingRef        = useRef(null);
  const watchdogRef    = useRef(null);
  const lastMsgAtRef   = useRef(null);
  const retryCountRef  = useRef(0);
  const unmountedRef   = useRef(false);

  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);

  // ── Limpia todos los timers ──────────────────────────────────────────
  function clearTimers() {
    clearTimeout(reconnectRef.current);
    clearInterval(pingRef.current);
    clearInterval(watchdogRef.current);
  }

  // ── Programa próximo intento con backoff exponencial ─────────────────
  function scheduleReconnect(connectFn) {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** retryCountRef.current,
      RECONNECT_MAX_MS
    );
    retryCountRef.current += 1;
    console.warn(`[WS] Reconectando en ${delay}ms (intento #${retryCountRef.current})…`);
    reconnectRef.current = setTimeout(connectFn, delay);
  }

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) return;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    // ── onopen ─────────────────────────────────────────────────────────
    ws.onopen = () => {
      if (unmountedRef.current) { ws.close(); return; }
      setIsConnected(true);
      retryCountRef.current = 0;
      lastMsgAtRef.current  = Date.now();
      console.log('[WS] Conectado');

      // Ping periódico para mantener viva la conexión
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL_MS);

      // Watchdog: cierra si no llegan datos
      watchdogRef.current = setInterval(() => {
        const silence = Date.now() - (lastMsgAtRef.current || Date.now());
        if (silence > STALE_THRESHOLD_MS) {
          console.warn(`[WS] Watchdog: sin datos ${silence}ms → forzando reconexión`);
          ws.close();
        }
      }, PING_INTERVAL_MS);
    };

    // ── onmessage ──────────────────────────────────────────────────────
    ws.onmessage = (event) => {
      lastMsgAtRef.current = Date.now();
      try {
        const msg = JSON.parse(event.data);
        onMessageRef.current?.(msg);
      } catch {
        // ignorar JSON inválido
      }
    };

    // ── onclose ────────────────────────────────────────────────────────
    ws.onclose = () => {
      clearInterval(pingRef.current);
      clearInterval(watchdogRef.current);
      setIsConnected(false);
      if (!unmountedRef.current) scheduleReconnect(connect);
    };

    // ── onerror ────────────────────────────────────────────────────────
    ws.onerror = () => {
      // onerror siempre va seguido de onclose → la reconexión la maneja onclose
      ws.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      clearTimers();
      wsRef.current?.close();
    };
  }, [connect]);

  // ── API pública ────────────────────────────────────────────────────
  const subscribe = useCallback((feed, coin) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', feed, coin }));
    }
  }, []);

  const unsubscribe = useCallback((feed, coin) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'unsubscribe', feed, coin }));
    }
  }, []);

  return { isConnected, subscribe, unsubscribe };
}
