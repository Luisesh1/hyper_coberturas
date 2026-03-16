/**
 * TradingContext.jsx
 *
 * Facade que compone los providers de dominio y expone
 * useTradingContext() como API agregada para la UI.
 */

import { useEffect, useRef } from 'react';
import { NotificationsProvider, useNotifications } from './NotificationsContext';
import { AccountsProvider, useAccounts } from './AccountsContext';
import { MarketProvider, useMarket } from './MarketContext';
import { AccountProvider, useAccount } from './AccountContext';
import { HedgeProvider, useHedges } from './HedgeContext';
import { BotEventsProvider, useBotEvents } from './BotEventsContext';

function HedgeContextBridge({ onReady }) {
  const { handleHedgeEvent } = useHedges();

  useEffect(() => {
    onReady(handleHedgeEvent);
  }, [handleHedgeEvent, onReady]);

  return null;
}

function BotEventsBridge({ onReady }) {
  const { handleBotEvent } = useBotEvents();

  useEffect(() => {
    onReady(handleBotEvent);
  }, [handleBotEvent, onReady]);

  return null;
}

function TradingProviders({ children }) {
  const hedgeMessageRef = useRef(null);
  const botMessageRef = useRef(null);

  return (
    <NotificationsProvider>
      <AccountsProvider>
        <BotEventsProvider>
          <HedgeProvider>
            <HedgeContextBridge onReady={(handler) => { hedgeMessageRef.current = handler; }} />
            <BotEventsBridge onReady={(handler) => { botMessageRef.current = handler; }} />
            <MarketProvider
              onMessage={(msg) => {
                hedgeMessageRef.current?.(msg);
                botMessageRef.current?.(msg);
              }}
            >
              <AccountProvider>{children}</AccountProvider>
            </MarketProvider>
          </HedgeProvider>
        </BotEventsProvider>
      </AccountsProvider>
    </NotificationsProvider>
  );
}

export function TradingProvider({ children }) {
  return <TradingProviders>{children}</TradingProviders>;
}

export function useTradingContext() {
  const notifications = useNotifications();
  const accounts = useAccounts();
  const market = useMarket();
  const account = useAccount();
  const hedges = useHedges();
  const bots = useBotEvents();

  return {
    ...accounts,
    ...market,
    ...account,
    ...hedges,
    ...bots,
    notifications: notifications.notifications,
    addNotification: notifications.addNotification,
    removeNotification: notifications.removeNotification,
  };
}
