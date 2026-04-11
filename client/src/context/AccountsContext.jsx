import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { settingsApi } from '../services/api';
import { useAsyncAction } from '../hooks/useAsyncAction';

const AccountsContext = createContext(null);

export function AccountsProvider({ children }) {
  const { run, loading: isLoadingAccounts } = useAsyncAction();
  const [accounts, setAccounts] = useState([]);

  const refreshAccounts = useCallback(async ({ refreshAccountId } = {}) => {
    return run(async () => {
      const data = await settingsApi.getHyperliquidAccounts(refreshAccountId);
      setAccounts(Array.isArray(data) ? data : []);
      return data;
    }, 'Error al cargar cuentas').catch(() => {
      setAccounts([]);
    });
  }, [run]);

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
