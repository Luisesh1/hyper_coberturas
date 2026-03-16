import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { tradingApi } from '../services/api';
import { formatAccountIdentity } from '../utils/hyperliquidAccounts';
import { useNotifications } from './NotificationsContext';

const AccountContext = createContext(null);

export function AccountProvider({ children }) {
  const { addNotification } = useNotifications();
  const [account, setAccount] = useState(null);
  const [isLoadingAccount, setIsLoadingAccount] = useState(false);

  const refreshAccount = useCallback(async ({ accountId, force = false } = {}) => {
    if (!accountId) {
      setAccount(null);
      return null;
    }

    setIsLoadingAccount(true);
    try {
      const data = await tradingApi.getAccount({ accountId, refresh: force });
      setAccount(data);
      return data;
    } catch (err) {
      addNotification('error', `Error al cargar cuenta: ${err.message}`);
      throw err;
    } finally {
      setIsLoadingAccount(false);
    }
  }, [addNotification]);

  const openPosition = useCallback(async (params) => {
    try {
      const result = await tradingApi.openPosition(params);
      addNotification('success', `${formatAccountIdentity(result.account)}\n${params.side.toUpperCase()} ${params.asset} abierto a mercado`);
      await refreshAccount({ accountId: params.accountId, force: true });
      return result;
    } catch (err) {
      addNotification('error', `Error al abrir: ${err.message}`);
      throw err;
    }
  }, [addNotification, refreshAccount]);

  const closePosition = useCallback(async (params) => {
    try {
      const result = await tradingApi.closePosition(params);
      addNotification('success', `${formatAccountIdentity(result.account)}\nPosicion ${params.asset} cerrada a mercado`);
      await refreshAccount({ accountId: params.accountId, force: true });
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

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error('useAccount debe usarse dentro de TradingProvider');
  return ctx;
}
