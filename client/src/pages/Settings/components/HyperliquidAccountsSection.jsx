import { useEffect } from 'react';
import { useTradingContext } from '../../../context/TradingContext';
import { settingsApi } from '../../../services/api';
import { formatAccountIdentity, formatUsd } from '../../../utils/hyperliquidAccounts';
import { Spinner } from '../../../components/shared/Spinner';
import styles from './HyperliquidAccountsSection.module.css';

export function HyperliquidAccountsSection({ onOpenForm, onDeleteAccount }) {
  const { accounts, refreshAccounts, isLoadingAccounts, addNotification } = useTradingContext();

  useEffect(() => {
    if (accounts.length === 0) {
      refreshAccounts().catch(() => {});
    }
  }, [accounts.length, refreshAccounts]);

  async function handleSetDefault(accountId) {
    try {
      await settingsApi.setDefaultHyperliquidAccount(accountId);
      await refreshAccounts({ refreshAccountId: accountId });
      addNotification('success', 'Cuenta predeterminada actualizada');
    } catch (err) {
      addNotification('error', err.message);
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>Cuentas Hyperliquid</h2>
          <p className={styles.subtitle}>
            Registra wallets con alias y private key. La cuenta predeterminada se selecciona automaticamente.
          </p>
        </div>
        <button className={styles.addBtn} onClick={() => onOpenForm(null)}>+ Nueva cuenta</button>
      </div>

      {isLoadingAccounts && <Spinner />}

      {!isLoadingAccounts && accounts.length === 0 && (
        <div className={styles.empty}>
          No hay cuentas registradas
          <div className={styles.emptyHint}>Agrega tu primera cuenta Hyperliquid para comenzar</div>
        </div>
      )}

      {accounts.length > 0 && (
        <div className={styles.grid}>
          {accounts.map((account) => (
            <div
              key={account.id}
              className={`${styles.card} ${account.isDefault ? styles.cardDefault : ''}`}
            >
              <div className={styles.cardTop}>
                <span className={styles.cardAlias}>{account.alias}</span>
                <span className={`${styles.badge} ${account.isDefault ? styles.badgeDefault : styles.badgeActive}`}>
                  {account.isDefault ? 'Default' : 'Activa'}
                </span>
              </div>
              <div className={styles.cardMeta}>{formatAccountIdentity(account)}</div>
              <div className={styles.cardBalance}>Balance: {formatUsd(account.balanceUsd)}</div>
              <div className={styles.cardActions}>
                {!account.isDefault && (
                  <label className={styles.defaultRadio} onClick={() => handleSetDefault(account.id)}>
                    <input type="radio" checked={false} readOnly />
                    Marcar default
                  </label>
                )}
                {account.isDefault && <span className={styles.defaultRadio} />}
                <button className={styles.actionBtn} onClick={() => onOpenForm(account)}>Editar</button>
                <button className={styles.deleteBtn} onClick={() => onDeleteAccount(account)}>Eliminar</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
