/**
 * SettingsPanel.jsx
 *
 * Panel de configuración por usuario:
 *  - Cuentas Hyperliquid
 *  - Notificaciones Telegram
 *  - Etherscan API
 */

import { HyperliquidAccountsSection } from './HyperliquidAccountsSection';
import { TelegramSection } from './TelegramSection';
import { EtherscanSection } from './EtherscanSection';
import styles from './SettingsPanel.module.css';

export default function SettingsPanel() {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Configuración</h2>
          <p className={styles.subtitle}>Cuentas Hyperliquid, alertas y herramientas</p>
        </div>
      </div>
      <HyperliquidAccountsSection />
      <TelegramSection />
      <EtherscanSection />
    </div>
  );
}
