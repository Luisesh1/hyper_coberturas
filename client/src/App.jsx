import { useState } from 'react';
import { useNavigate, useLocation, Navigate, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TradingProvider } from './context/TradingContext';
import { PricePanel } from './components/PricePanel/PricePanel';
import { TradingPanel } from './components/TradingPanel/TradingPanel';
import { HedgePanel } from './components/HedgePanel/HedgePanel';
import SettingsPanel from './components/SettingsPanel/SettingsPanel';
import UsersPanel from './components/UsersPanel/UsersPanel';
import { Notifications } from './components/Layout/Notifications';
import { useTradingContext } from './context/TradingContext';
import LoginPage from './pages/LoginPage';
import styles from './App.module.css';

const BASE_NAV = [
  { id: 'manual',   path: '/trade',      label: 'Trading Manual', activeClass: 'modeBtnActive'  },
  { id: 'hedge',    path: '/coberturas', label: 'Coberturas',     activeClass: 'modeHedgeActive' },
  { id: 'settings', path: '/config',     label: '⚙ Config',       activeClass: 'modeBtnActive'  },
];

const SUPER_NAV = [
  { id: 'users', path: '/usuarios', label: '👥 Usuarios', activeClass: 'modeBtnActive' },
];

function AppContent() {
  const { user, isSuperuser, logout } = useAuth();
  const [selectedAsset, setSelectedAsset] = useState('BTC');
  const [menuOpen, setMenuOpen] = useState(false);
  const { isConnected, isPriceStale } = useTradingContext();
  const navigate = useNavigate();
  const location = useLocation();

  const navItems = isSuperuser ? [...BASE_NAV, ...SUPER_NAV] : BASE_NAV;

  const goTo = (path) => {
    navigate(path);
    setMenuOpen(false);
  };

  const isActive = (path) => location.pathname === path || (path === '/trade' && location.pathname === '/');

  return (
    <div className={styles.app}>

      {menuOpen && (
        <div className={styles.offCanvasOverlay} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}

      <nav className={`${styles.offCanvas} ${menuOpen ? styles.offCanvasOpen : ''}`}>
        <div className={styles.offCanvasHeader}>
          <span className={styles.logoIcon}>◈</span>
          <span className={styles.logoText}>Hyperliquid Bot</span>
          <button className={styles.closeBtn} onClick={() => setMenuOpen(false)} aria-label="Cerrar menú">✕</button>
        </div>

        <div className={styles.offCanvasNav}>
          {navItems.map(({ path, label, activeClass }) => (
            <button
              key={path}
              className={`${styles.offCanvasBtn} ${isActive(path) ? styles[activeClass] : ''}`}
              onClick={() => goTo(path)}
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

      <header className={styles.header}>
        <button className={styles.hamburger} onClick={() => setMenuOpen(true)} aria-label="Abrir menú">
          <span /><span /><span />
        </button>

        <div className={styles.logo}>
          <span className={styles.logoIcon}>◈</span>
          <span className={styles.logoText}>Hyperliquid Bot</span>
        </div>

        <nav className={styles.modeNav}>
          {navItems.map(({ path, label, activeClass }) => (
            <button
              key={path}
              className={`${styles.modeBtn} ${isActive(path) ? styles[activeClass] : ''}`}
              onClick={() => goTo(path)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className={styles.headerRight}>
          <StatusBadge isConnected={isConnected} isPriceStale={isPriceStale} />
          <span className={styles.userBadge} title={`Rol: ${user?.role}`}>
            {user?.name || user?.username}
            {isSuperuser && <span className={styles.roleBadge}>SU</span>}
          </span>
          <button className={styles.logoutBtn} onClick={logout} title="Cerrar sesión">↩</button>
          <span className={styles.version}>v1.0</span>
        </div>
      </header>

      <main className={styles.main}>
        <aside className={styles.sidebar}>
          <PricePanel selectedAsset={selectedAsset} onSelectAsset={setSelectedAsset} />
        </aside>

        <section className={styles.content}>
          <Routes>
            <Route path="/"           element={<Navigate to="/trade" replace />} />
            <Route path="/trade"      element={<TradingPanel selectedAsset={selectedAsset} />} />
            <Route path="/coberturas" element={<HedgePanel selectedAsset={selectedAsset} />} />
            <Route path="/config"     element={<SettingsPanel />} />
            {isSuperuser && <Route path="/usuarios" element={<UsersPanel />} />}
            <Route path="*"           element={<Navigate to="/trade" replace />} />
          </Routes>
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

function AuthGate() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <LoginPage />;
  return (
    <TradingProvider>
      <AppContent />
    </TradingProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
