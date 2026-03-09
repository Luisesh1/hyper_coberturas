import { useState } from 'react';
import { TradingProvider } from './context/TradingContext';
import { PricePanel } from './components/PricePanel/PricePanel';
import { TradingPanel } from './components/TradingPanel/TradingPanel';
import { HedgePanel } from './components/HedgePanel/HedgePanel';
import SettingsPanel from './components/SettingsPanel/SettingsPanel';
import { Notifications } from './components/Layout/Notifications';
import { useTradingContext } from './context/TradingContext';
import styles from './App.module.css';

const NAV_ITEMS = [
  { id: 'manual',   label: 'Trading Manual', activeClass: 'modeBtnActive'  },
  { id: 'hedge',    label: 'Coberturas',      activeClass: 'modeHedgeActive' },
  { id: 'settings', label: '⚙ Config',        activeClass: 'modeBtnActive'  },
];

function AppContent() {
  const [selectedAsset, setSelectedAsset] = useState('BTC');
  const [activeMode, setActiveMode]   = useState('manual');
  const [menuOpen,   setMenuOpen]     = useState(false);
  const { isConnected, isPriceStale } = useTradingContext();

  const navigate = (id) => {
    setActiveMode(id);
    setMenuOpen(false);
  };

  return (
    <div className={styles.app}>

      {/* ── Off-canvas overlay (solo mobile) ── */}
      {menuOpen && (
        <div
          className={styles.offCanvasOverlay}
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Off-canvas sidebar (solo mobile) ── */}
      <nav className={`${styles.offCanvas} ${menuOpen ? styles.offCanvasOpen : ''}`}>
        <div className={styles.offCanvasHeader}>
          <span className={styles.logoIcon}>◈</span>
          <span className={styles.logoText}>Hyperliquid Bot</span>
          <button
            className={styles.closeBtn}
            onClick={() => setMenuOpen(false)}
            aria-label="Cerrar menú"
          >
            ✕
          </button>
        </div>

        <div className={styles.offCanvasNav}>
          {NAV_ITEMS.map(({ id, label, activeClass }) => (
            <button
              key={id}
              className={`${styles.offCanvasBtn} ${activeMode === id ? styles[activeClass] : ''}`}
              onClick={() => navigate(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={styles.offCanvasFooter}>
          <StatusBadge isConnected={isConnected} isPriceStale={isPriceStale} />
          <span className={styles.version}>MVP v1.0</span>
        </div>
      </nav>

      {/* ── Header principal ── */}
      <header className={styles.header}>
        {/* Hamburger (solo mobile) */}
        <button
          className={styles.hamburger}
          onClick={() => setMenuOpen(true)}
          aria-label="Abrir menú"
        >
          <span /><span /><span />
        </button>

        <div className={styles.logo}>
          <span className={styles.logoIcon}>◈</span>
          <span className={styles.logoText}>Hyperliquid Bot</span>
        </div>

        {/* Nav horizontal (solo desktop) */}
        <nav className={styles.modeNav}>
          {NAV_ITEMS.map(({ id, label, activeClass }) => (
            <button
              key={id}
              className={`${styles.modeBtn} ${activeMode === id ? styles[activeClass] : ''}`}
              onClick={() => navigate(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className={styles.headerRight}>
          <StatusBadge isConnected={isConnected} isPriceStale={isPriceStale} />
          <span className={styles.version}>MVP v1.0</span>
        </div>
      </header>

      {/* ── Contenido principal ── */}
      <main className={styles.main}>
        <aside className={styles.sidebar}>
          <PricePanel selectedAsset={selectedAsset} onSelectAsset={setSelectedAsset} />
        </aside>

        <section className={styles.content}>
          {activeMode === 'manual'   && <TradingPanel selectedAsset={selectedAsset} />}
          {activeMode === 'hedge'    && <HedgePanel   selectedAsset={selectedAsset} />}
          {activeMode === 'settings' && <SettingsPanel />}
        </section>
      </main>

      <Notifications />
    </div>
  );
}

function StatusBadge({ isConnected, isPriceStale }) {
  const cls = !isConnected ? styles.wsOff : isPriceStale ? styles.wsStale : styles.wsOn;
  const txt = !isConnected ? '○ Desconectado' : isPriceStale ? '⚠ Sin datos' : '● En vivo';
  return <span className={`${styles.wsStatus} ${cls}`}>{txt}</span>;
}

export default function App() {
  return (
    <TradingProvider>
      <AppContent />
    </TradingProvider>
  );
}
