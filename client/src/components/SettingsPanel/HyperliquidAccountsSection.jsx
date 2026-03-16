import { useState, useEffect } from 'react';
import { useTradingContext } from '../../context/TradingContext';
import { settingsApi } from '../../services/api';
import { formatAccountIdentity, formatUsd } from '../../utils/hyperliquidAccounts';
import { useFeedback } from './useFeedback';
import styles from './SettingsPanel.module.css';

export function HyperliquidAccountsSection() {
  const { accounts, refreshAccounts, isLoadingAccounts } = useTradingContext();
  const [editingId, setEditingId] = useState(null);
  const [alias, setAlias] = useState('');
  const [address, setAddress] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [defaultingId, setDefaultingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [feedback, showFeedback] = useFeedback();

  useEffect(() => {
    if (accounts.length === 0) {
      refreshAccounts().catch(() => {});
    }
  }, [accounts.length, refreshAccounts]);

  function resetForm() {
    setEditingId(null);
    setAlias('');
    setAddress('');
    setPrivateKey('');
    setMakeDefault(false);
  }

  function startEdit(account) {
    setEditingId(account.id);
    setAlias(account.alias || '');
    setAddress(account.address || '');
    setPrivateKey('');
    setMakeDefault(account.isDefault || false);
  }

  async function handleSave(event) {
    event.preventDefault();
    if (!alias.trim() || !address.trim() || (!editingId && !privateKey.trim())) {
      showFeedback('error', 'Alias, address y private key son obligatorios al crear');
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await settingsApi.updateHyperliquidAccount(editingId, {
          alias: alias.trim(),
          address: address.trim(),
          privateKey: privateKey.trim() || undefined,
          isDefault: makeDefault,
        });
        showFeedback('ok', 'Cuenta actualizada correctamente');
      } else {
        await settingsApi.createHyperliquidAccount({
          alias: alias.trim(),
          address: address.trim(),
          privateKey: privateKey.trim(),
          isDefault: makeDefault,
        });
        showFeedback('ok', 'Cuenta creada correctamente');
      }
      await refreshAccounts();
      resetForm();
    } catch (err) {
      showFeedback('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(accountId) {
    setDefaultingId(accountId);
    try {
      await settingsApi.setDefaultHyperliquidAccount(accountId);
      await refreshAccounts({ refreshAccountId: accountId });
      if (!editingId) {
        setMakeDefault(false);
      }
    } catch (err) {
      showFeedback('error', err.message);
    } finally {
      setDefaultingId(null);
    }
  }

  async function handleDelete(accountId) {
    setDeletingId(accountId);
    try {
      await settingsApi.deleteHyperliquidAccount(accountId);
      await refreshAccounts();
      if (editingId === accountId) {
        resetForm();
      }
      showFeedback('ok', 'Cuenta eliminada');
    } catch (err) {
      showFeedback('error', err.message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>◈</span>
        <h3 className={styles.sectionTitle}>Cuentas Hyperliquid</h3>
        <span className={accounts.length > 0 ? styles.badgeOn : styles.badgeOff}>
          {accounts.length > 0 ? `${accounts.length} registradas` : 'Sin configurar'}
        </span>
      </div>

      <p className={styles.description}>
        Registra varias cuentas con alias, wallet y private key. La cuenta predeterminada se guarda en base de datos y sera la seleccion inicial en todos los dispositivos.
      </p>

      <div className={styles.accountsList}>
        {isLoadingAccounts && <div className={styles.emptyAccounts}>Cargando cuentas...</div>}
        {!isLoadingAccounts && accounts.length === 0 && (
          <div className={styles.emptyAccounts}>No hay cuentas registradas todavia.</div>
        )}
        {accounts.map((account) => (
          <div key={account.id} className={styles.accountCard}>
            <div className={styles.accountCardTop}>
              <label className={styles.defaultRadio}>
                <input
                  type="radio"
                  checked={account.isDefault}
                  onChange={() => handleSetDefault(account.id)}
                  disabled={defaultingId === account.id}
                />
                <span>{account.isDefault ? 'Predeterminada' : 'Marcar default'}</span>
              </label>
              <span className={account.isDefault ? styles.badgeOn : styles.badgeOff}>
                {account.isDefault ? 'Default' : 'Activa'}
              </span>
            </div>
            <div className={styles.accountAlias}>{account.alias}</div>
            <div className={styles.accountMeta}>{formatAccountIdentity(account)}</div>
            <div className={styles.accountBalance}>Balance total: {formatUsd(account.balanceUsd)}</div>
            <div className={styles.accountActions}>
              <button type="button" className={styles.testBtn} onClick={() => startEdit(account)}>
                Editar
              </button>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => handleDelete(account.id)}
                disabled={deletingId === account.id}
              >
                {deletingId === account.id ? 'Eliminando…' : 'Eliminar'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <form className={styles.form} onSubmit={handleSave}>
        <div className={styles.formHeaderRow}>
          <h4 className={styles.formTitle}>{editingId ? 'Editar cuenta' : 'Nueva cuenta'}</h4>
          {editingId && (
            <button type="button" className={styles.linkBtn} onClick={resetForm}>
              Cancelar edicion
            </button>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Alias</label>
          <input
            className={styles.input}
            type="text"
            placeholder="Cuenta principal"
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Wallet Address</label>
          <input
            className={styles.input}
            type="text"
            placeholder="0x..."
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>
            Private Key
            {editingId && <span className={styles.hint}> (dejar vacio para mantener la actual)</span>}
          </label>
          <input
            className={styles.input}
            type="password"
            placeholder={editingId ? '••••••• (sin cambios si queda vacio)' : '0x...'}
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
            autoComplete="off"
          />
        </div>

        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={makeDefault}
            onChange={(event) => setMakeDefault(event.target.checked)}
          />
          <span>Guardar como cuenta predeterminada</span>
        </label>

        {feedback && (
          <div className={feedback.type === 'ok' ? styles.feedbackOk : styles.feedbackError}>
            {feedback.type === 'ok' ? '✓' : '✗'} {feedback.text}
          </div>
        )}

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Guardando…' : editingId ? 'Actualizar cuenta' : 'Crear cuenta'}
          </button>
        </div>
      </form>
    </section>
  );
}
