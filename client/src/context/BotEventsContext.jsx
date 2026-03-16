import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useNotifications } from './NotificationsContext';

const BotEventsContext = createContext(null);

export function BotEventsProvider({ children }) {
  const { addNotification } = useNotifications();
  const [botEvents, setBotEvents] = useState([]);
  const [lastBotEvent, setLastBotEvent] = useState(null);

  const handleBotEvent = useCallback((msg) => {
    if (msg.type !== 'bot_event') return;
    setLastBotEvent(msg);
    setBotEvents((prev) => [msg, ...prev].slice(0, 50));

    if (msg.event === 'error') {
      addNotification('error', `Bot error\n#${msg.bot?.id || '?'} · ${msg.message || 'Error desconocido'}`, 8000);
      return;
    }

    if (msg.event === 'runtime_warning') {
      addNotification('error', `Bot en riesgo\n#${msg.bot?.id || '?'} · ${msg.payload?.actionTaken || msg.message || 'Incidente runtime'}`, 8000);
      return;
    }

    if (msg.event === 'runtime_retry_scheduled') {
      addNotification('info', `Reintento programado\n#${msg.bot?.id || '?'} · ${msg.payload?.actionTaken || 'Retry pendiente'}`, 5000);
      return;
    }

    if (msg.event === 'runtime_fallback_applied') {
      addNotification('info', `Fallback aplicado\n#${msg.bot?.id || '?'} · ${msg.payload?.actionTaken || 'Respaldo activado'}`, 6000);
      return;
    }

    if (msg.event === 'runtime_recovered') {
      addNotification('success', `Bot recuperado\n#${msg.bot?.id || '?'} · ${msg.payload?.message || 'Healthy'}`, 4500);
      return;
    }

    if (msg.event === 'runtime_paused') {
      addNotification('error', `Bot pausado\n#${msg.bot?.id || '?'} · ${msg.payload?.message || 'Pausa automática'}`, 9000);
      return;
    }

    if (msg.event === 'run') {
      const action = msg.run?.action || 'evaluacion';
      const signal = msg.run?.signal?.type || 'hold';
      addNotification('info', `Bot ${msg.bot?.asset || ''}\n#${msg.bot?.id || '?'} · ${action} · ${signal}`, 4500);
      return;
    }

    if (msg.event === 'status') {
      addNotification('success', `Bot actualizado\n#${msg.bot?.id || '?'} · ${msg.bot?.status || 'status'}`, 3500);
    }
  }, [addNotification]);

  const value = useMemo(() => ({
    botEvents,
    lastBotEvent,
    handleBotEvent,
  }), [botEvents, lastBotEvent, handleBotEvent]);

  return <BotEventsContext.Provider value={value}>{children}</BotEventsContext.Provider>;
}

export function useBotEvents() {
  const ctx = useContext(BotEventsContext);
  if (!ctx) throw new Error('useBotEvents debe usarse dentro de TradingProvider');
  return ctx;
}
