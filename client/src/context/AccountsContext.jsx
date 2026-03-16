import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { settingsApi } from '../services/api';
import { useNotifications } from './NotificationsContext';

const AccountsContext = createContext(null);

export function AccountsProvider({ children }) {
  const { addNotification } = useNotifications();
  const [accounts, setAccounts] = useState([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);

  const refreshAccounts = useCallback(async ({ refreshAccountId } = {}) => {
    setIsLoadingAccounts(true);
    try {
      const data = await settingsApi.getHyperliquidAccounts(refreshAccountId);
      setAccounts(Array.isArray(data) ? data : []);
      return data;
    } catch (err) {
      addNotification('error', `Error al cargar cuentas: ${err.message}`);
      setAccounts([]);
      throw err;
    } finally {
      setIsLoadingAccounts(false);
    }
  }, [addNotification]);

  const refreshAccountSummary = useCallback(async (accountId, { force = false } = {}) => {
    if (!accountId) return null;
    const data = await settingsApi.getHyperliquidAccountSummary(accountId, { refresh: force });
    setAccounts((prev) => prev.map((account) => (
      Number(account.id) === Number(accountId) ? { ...account, ...data } : account
    )));
    return data;
  }, []);

  useEffect(() => {
    refreshAccounts().catch(() => {});
  }, [refreshAccounts]);

  const defaultAccountId = accounts.find((account) => account.isDefault)?.id ?? null;

  const value = useMemo(() => ({
    accounts,
    defaultAccountId,
    isLoadingAccounts,
    refreshAccounts,
    refreshAccountSummary,
    setAccounts,
  }), [accounts, defaultAccountId, isLoadingAccounts, refreshAccounts, refreshAccountSummary]);

  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}

export function useAccounts() {
  const ctx = useContext(AccountsContext);
  if (!ctx) throw new Error('useAccounts debe usarse dentro de TradingProvider');
  return ctx;
}
