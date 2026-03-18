import styles from './SettingsSidebar.module.css';

const SECTIONS = [
  { key: 'accounts', icon: '◈', label: 'Cuentas Hyperliquid', hint: 'Wallets y API keys' },
  { key: 'telegram', icon: '✉', label: 'Telegram', hint: 'Notificaciones' },
  { key: 'etherscan', icon: '🧭', label: 'Etherscan', hint: 'Escaneo de pools' },
];

export function SettingsSidebar({ active, onSelect, status }) {
  return (
    <aside className={styles.sidebar}>
      <h3 className={styles.heading}>Secciones</h3>
      {SECTIONS.map((s) => {
        const st = status[s.key];
        const isActive = active === s.key;
        return (
          <button
            key={s.key}
            className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
            onClick={() => onSelect(s.key)}
          >
            <span className={styles.itemIcon}>{s.icon}</span>
            <div className={styles.itemBody}>
              <span className={styles.itemLabel}>{s.label}</span>
              <span className={styles.itemHint}>{s.hint}</span>
            </div>
            {st && (
              <span className={`${styles.badge} ${st.ok ? styles.badgeGreen : styles.badgeOff}`}>
                {st.text}
              </span>
            )}
          </button>
        );
      })}
    </aside>
  );
}
