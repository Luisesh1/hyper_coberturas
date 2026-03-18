import { useState, useEffect, useCallback } from 'react';
import { settingsApi } from '../../../services/api';
import { useTradingContext } from '../../../context/TradingContext';
import styles from './AccountFormModal.module.css';

export function AccountFormModal({ account, onClose, onSaved }) {
  const { addNotification } = useTradingContext();
  const isEdit = Boolean(account);

  const [alias, setAlias] = useState('');
  const [address, setAddress] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) {
      setAlias(account.alias || '');
      setAddress(account.address || '');
      setMakeDefault(account.isDefault || false);
    }
  }, [account]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!alias.trim() || !address.trim() || (!isEdit && !privateKey.trim())) {
      addNotification('error', 'Alias, address y private key son obligatorios');
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await settingsApi.updateHyperliquidAccount(account.id, {
          alias: alias.trim(),
          address: address.trim(),
          privateKey: privateKey.trim() || undefined,
          isDefault: makeDefault,
        });
        addNotification('success', 'Cuenta actualizada correctamente');
      } else {
        await settingsApi.createHyperliquidAccount({
          alias: alias.trim(),
          address: address.trim(),
          privateKey: privateKey.trim(),
          isDefault: makeDefault,
        });
        addNotification('success', 'Cuenta creada correctamente');
      }
      onSaved();
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label={isEdit ? 'Editar cuenta' : 'Nueva cuenta'}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>{isEdit ? 'Editar cuenta' : 'Nueva cuenta'}</h3>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label}>Alias</label>
            <input
              className={styles.input}
              type="text"
              placeholder="Cuenta principal"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Wallet Address</label>
            <input
              className={styles.input}
              type="text"
              placeholder="0x..."
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>
              Private Key
              {isEdit && <span className={styles.labelHint}> (dejar vacio para mantener la actual)</span>}
            </label>
            <input
              className={styles.input}
              type="password"
              placeholder={isEdit ? '••••••• (sin cambios si queda vacio)' : '0x...'}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              autoComplete="off"
            />
          </div>

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
            <span>Guardar como cuenta predeterminada</span>
          </label>

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>Cancelar</button>
            <button type="submit" className={styles.saveBtn} disabled={saving}>
              {saving ? 'Guardando…' : isEdit ? 'Actualizar' : 'Crear cuenta'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
