import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { tradingApi } from '../services/api';
import { formatAccountIdentity } from '../utils/hyperliquidAccounts';
import { useNotifications } from './NotificationsContext';
import { useAsyncAction } from '../hooks/useAsyncAction';

const AccountContext = createContext(null);

export function AccountProvider({ children }) {
  const { addNotification } = useNotifications();
  const { run, loading: isLoadingAccount } = useAsyncAction();
  const [account, setAccount] = useState(null);

  const refreshAccount = useCallback(async ({ accountId, force = false } = {}) => {
    if (!accountId) {
      setAccount(null);
      return null;
    }
    return run(async () => {
      const data = await tradingApi.getAccount({ accountId, refresh: force });
      setAccount(data);
      return data;
    }, 'Error al cargar cuenta');
  }, [run]);

  const openPosition = useCallback(async (params) => {
    return run(async () => {
      const result = await tradingApi.openPosition(params);
      addNotification('success', `${formatAccountIdentity(result.account)}\n${params.side.toUpperCase()} ${params.asset} abierto a mercado`);
      await refreshAccount({ accountId: params.accountId, force: true });
      return result;
    }, 'Error al abrir');
  }, [addNotification, refreshAccount, run]);

  const closePosition = useCallback(async (params) => {
    return run(async () => {
      const result = await tradingApi.closePosition(params);
      addNotification('success', `${formatAccountIdentity(result.account)}\nPosicion ${params.asset} cerrada a mercado`);
      await refreshAccount({ accountId: params.accountId, force: true });
      return result;
    }, 'Error al cerrar');
  }, [addNotification, refreshAccount, run]);

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
