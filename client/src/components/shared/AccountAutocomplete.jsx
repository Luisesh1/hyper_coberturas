import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAccountOptionLabel, formatUsd } from '../../utils/hyperliquidAccounts';
import styles from './AccountAutocomplete.module.css';

export function AccountAutocomplete({
  accounts,
  selectedAccountId,
  onSelect,
  label = 'Cuenta',
  disabled = false,
  placeholder = 'Buscar cuenta...',
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);

  const selected = accounts.find((account) => Number(account.id) === Number(selectedAccountId)) || null;

  useEffect(() => {
    if (!isOpen) {
      setQuery(selected ? formatAccountOptionLabel(selected) : '');
    }
  }, [isOpen, selected]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredAccounts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || (!isOpen && selected)) return accounts;
    return accounts.filter((account) =>
      formatAccountOptionLabel(account).toLowerCase().includes(normalized)
    );
  }, [accounts, isOpen, query, selected]);

  return (
    <div className={styles.wrapper} ref={rootRef}>
      <label className={styles.label}>{label}</label>
      <div className={`${styles.control} ${disabled ? styles.disabled : ''}`}>
        <input
          className={styles.input}
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
        />
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setIsOpen((value) => !value)}
          disabled={disabled}
          aria-label="Abrir selector de cuenta"
        >
          ▾
        </button>
      </div>
      {selected?.isDefault && (
        <span className={styles.defaultHint}>Predeterminada</span>
      )}
      {isOpen && filteredAccounts.length > 0 && (
        <div className={styles.menu}>
          {filteredAccounts.map((account) => (
            <button
              key={account.id}
              type="button"
              className={`${styles.option} ${Number(account.id) === Number(selectedAccountId) ? styles.optionActive : ''}`}
              onClick={() => {
                onSelect?.(account);
                setQuery(formatAccountOptionLabel(account));
                setIsOpen(false);
              }}
            >
              <span className={styles.optionTitle}>{account.alias}</span>
              <span className={styles.optionMeta}>
                {account.shortAddress} · {account.balanceUsd == null ? 'Balance sin datos' : formatUsd(account.balanceUsd)}
              </span>
            </button>
          ))}
        </div>
      )}
      {isOpen && filteredAccounts.length === 0 && (
        <div className={styles.empty}>No se encontraron cuentas</div>
      )}
    </div>
  );
}
