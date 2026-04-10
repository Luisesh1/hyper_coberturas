import { useState, useEffect, useCallback } from 'react';
import { useTradingContext } from '../../context/TradingContext';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { settingsApi } from '../../services/api';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog';
import { SettingsSidebar } from './components/SettingsSidebar';
import { HyperliquidAccountsSection } from './components/HyperliquidAccountsSection';
import { AccountFormModal } from './components/AccountFormModal';
import { TelegramSection } from './components/TelegramSection';
import { EtherscanSection } from './components/EtherscanSection';
import { AlchemySection } from './components/AlchemySection';
import styles from './SettingsPage.module.css';

function SettingsPage() {
  const { accounts, refreshAccounts, addNotification } = useTradingContext();
  const { dialog, confirm } = useConfirmAction();

  const [section, setSection] = useState('accounts');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [formAccount, setFormAccount] = useState(undefined); // undefined=closed, null=create, object=edit
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [hasEtherscan, setHasEtherscan] = useState(false);
  const [hasAlchemy, setHasAlchemy] = useState(false);

  // Fetch status for hero badges
  useEffect(() => {
    settingsApi.get()
      .then((d) => setTelegramEnabled(d?.telegram?.enabled || false))
      .catch(() => {});
    settingsApi.getEtherscan()
      .then((d) => setHasEtherscan(d?.hasApiKey || false))
      .catch(() => {});
    settingsApi.getAlchemy()
      .then((d) => setHasAlchemy(d?.hasApiKey || false))
      .catch(() => {});
  }, []);

  const handleSelectSection = (key) => {
    setSection(key);
    setSidebarOpen(false);
  };

  const handleOpenForm = useCallback((account) => {
    setFormAccount(account); // null=create, object=edit
  }, []);

  const handleFormSaved = useCallback(async () => {
    setFormAccount(undefined);
    await refreshAccounts();
  }, [refreshAccounts]);

  const handleDeleteAccount = useCallback(async (account) => {
    const ok = await confirm({
      title: 'Eliminar cuenta',
      message: `¿Eliminar la cuenta "${account.alias}"? Esta accion no se puede deshacer.`,
      confirmLabel: 'Eliminar',
    });
    if (!ok) return;
    try {
      await settingsApi.deleteHyperliquidAccount(account.id);
      await refreshAccounts();
      addNotification('success', 'Cuenta eliminada');
    } catch (err) {
      addNotification('error', err.message);
    }
  }, [confirm, refreshAccounts, addNotification]);

  const sectionStatus = {
    accounts: { ok: accounts.length > 0, text: accounts.length > 0 ? `${accounts.length} cuentas` : 'Sin configurar' },
    telegram: { ok: telegramEnabled, text: telegramEnabled ? 'Activo' : 'Inactivo' },
    etherscan: { ok: hasEtherscan, text: hasEtherscan ? 'Configurada' : 'Sin configurar' },
    alchemy: { ok: hasAlchemy, text: hasAlchemy ? 'Configurada' : 'Sin configurar' },
  };

  return (
    <div className={styles.page}>
      {/* Hero */}
      <div className={styles.hero}>
        <div className={styles.heroLeft}>
          <button className={styles.sidebarToggle} onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? '✕' : '☰'}
          </button>
          <div>
            <span className={styles.eyebrow}>Ajustes</span>
            <h1 className={styles.title}>Configuracion</h1>
          </div>
        </div>
        <div className={styles.stats}>
          <div className={`${styles.stat} ${accounts.length > 0 ? styles.statGreen : styles.statOff}`}>
            <strong>{accounts.length}</strong><span>cuentas</span>
          </div>
          <div className={`${styles.stat} ${telegramEnabled ? styles.statGreen : styles.statOff}`}>
            <strong>{telegramEnabled ? 'ON' : 'OFF'}</strong><span>telegram</span>
          </div>
          <div className={`${styles.stat} ${hasEtherscan ? styles.statGreen : styles.statOff}`}>
            <strong>{hasEtherscan ? 'OK' : '—'}</strong><span>etherscan</span>
          </div>
          <div className={`${styles.stat} ${hasAlchemy ? styles.statGreen : styles.statOff}`}>
            <strong>{hasAlchemy ? 'OK' : '—'}</strong><span>alchemy</span>
          </div>
        </div>
      </div>

      {/* Layout */}
      <div className={styles.layout}>
        <div className={`${styles.sidebarWrap} ${sidebarOpen ? styles.sidebarWrapOpen : ''}`}>
          <SettingsSidebar active={section} onSelect={handleSelectSection} status={sectionStatus} />
        </div>

        <div className={styles.main}>
          {section === 'accounts' && (
            <HyperliquidAccountsSection
              onOpenForm={handleOpenForm}
              onDeleteAccount={handleDeleteAccount}
            />
          )}
          {section === 'telegram' && <TelegramSection />}
          {section === 'etherscan' && <EtherscanSection />}
          {section === 'alchemy' && <AlchemySection />}
        </div>
      </div>

      {/* Overlays */}
      {sidebarOpen && <div className={styles.overlay} onClick={() => setSidebarOpen(false)} />}

      {formAccount !== undefined && (
        <AccountFormModal
          account={formAccount}
          onClose={() => setFormAccount(undefined)}
          onSaved={handleFormSaved}
        />
      )}

      {dialog.open && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          variant={dialog.variant}
          onConfirm={dialog.onConfirm}
          onCancel={dialog.onCancel}
        />
      )}
    </div>
  );
}

export default SettingsPage;
