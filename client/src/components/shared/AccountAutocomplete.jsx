import { useEffect, useRef, useState } from 'react';
import { formatAccountIdentity, formatUsd } from '../../utils/hyperliquidAccounts';
import styles from './AccountAutocomplete.module.css';

export function AccountAutocomplete({
  accounts,
  selectedAccountId,
  onSelect,
  label = 'Cuenta',
  disabled = false,
  placeholder = 'Selecciona una cuenta',
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef(null);

  const selected = accounts.find((a) => Number(a.id) === Number(selectedAccountId)) || null;

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (!rootRef.current?.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') setIsOpen(false); };
    if (isOpen) {
      document.addEventListener('keydown', handleKey);
      return () => document.removeEventListener('keydown', handleKey);
    }
  }, [isOpen]);

  const handleSelect = (account) => {
    onSelect?.(account);
    setIsOpen(false);
  };

  return (
    <div className={styles.wrapper} ref={rootRef}>
      {label && <span className={styles.label}>{label}</span>}

      <button
        type="button"
        className={`${styles.trigger} ${disabled ? styles.disabled : ''} ${isOpen ? styles.triggerOpen : ''}`}
        onClick={() => !disabled && setIsOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        {selected ? (
          <div className={styles.selectedCard}>
            <div className={styles.selectedTop}>
              <span className={styles.selectedAlias}>{selected.alias || 'Sin alias'}</span>
              {selected.isDefault && <span className={styles.defaultBadge}>Default</span>}
            </div>
            <div className={styles.selectedBottom}>
              <span className={styles.selectedAddress}>{selected.shortAddress}</span>
              <span className={styles.selectedBalance}>{formatUsd(selected.balanceUsd)}</span>
            </div>
          </div>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}>▾</span>
      </button>

      {isOpen && (
        <div className={styles.menu} role="listbox">
          {accounts.length === 0 ? (
            <div className={styles.empty}>No hay cuentas registradas</div>
          ) : (
            accounts.map((account) => {
              const isActive = Number(account.id) === Number(selectedAccountId);
              return (
                <button
                  key={account.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className={`${styles.option} ${isActive ? styles.optionActive : ''}`}
                  onClick={() => handleSelect(account)}
                >
                  <div className={styles.optionLeft}>
                    <span className={styles.optionAlias}>{account.alias || formatAccountIdentity(account)}</span>
                    <span className={styles.optionAddress}>{account.shortAddress}</span>
                  </div>
                  <div className={styles.optionRight}>
                    <span className={styles.optionBalance}>{formatUsd(account.balanceUsd)}</span>
                    {account.isDefault && <span className={styles.defaultBadge}>Default</span>}
                    {isActive && <span className={styles.checkMark}>✓</span>}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
