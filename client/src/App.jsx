import { useState, useEffect, lazy, Suspense } from 'react';
import { useNavigate, useLocation, Navigate, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TradingProvider } from './context/TradingContext';
import { PricePanel } from './components/PricePanel/PricePanel';
import { TradingPanel } from './components/TradingPanel/TradingPanel';
import { HedgePanel } from './components/HedgePanel/HedgePanel';
import { Notifications } from './components/Layout/Notifications';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { useTradingContext } from './context/TradingContext';
import LoginPage from './pages/LoginPage';
import styles from './App.module.css';

// Code splitting por ruta: cada página pesada se convierte en un chunk
// separado que sólo se descarga cuando el usuario navega a esa vista.
// TradingPanel/HedgePanel se mantienen eager porque son la ruta por
// defecto (/trade) y evitamos un flash de fallback en el login→home.
const SettingsPage         = lazy(() => import('./pages/Settings/SettingsPage'));
const UsersPage            = lazy(() => import('./pages/Users/UsersPage'));
const UniswapPoolsPage     = lazy(() => import('./pages/UniswapPools/UniswapPoolsPage'));
const LpOrchestratorPage   = lazy(() => import('./pages/LpOrchestrator/LpOrchestratorPage'));
const MetricasPage         = lazy(() => import('./pages/Metricas/MetricasPage'));
const StrategyStudioPage   = lazy(() => import('./pages/StrategyStudio/StrategyStudioPage'));
const BotsPage             = lazy(() => import('./pages/Bots/BotsPage'));
const BacktestingPage      = lazy(() => import('./pages/Backtesting/BacktestingPage'));
const HidenActionsPage     = lazy(() => import('./pages/HidenActions/HidenActionsPage'));
const TradingViewPage      = lazy(() => import('./pages/TradingView/TradingViewPage'));

// DevLogPanel: solo se carga (y aparece) en dev. Vite remueve el chunk
// completo en build de producción gracias al guard `import.meta.env.DEV`.
const DevLogPanel = import.meta.env.DEV
  ? lazy(() => import('./dev/DevLogPanel'))
  : null;
const IS_DEV = import.meta.env.DEV;

const BASE_NAV = [
  { id: 'manual',   path: '/trade',      label: 'Trading Manual', activeClass: 'modeBtnActive',  title: 'Trading' },
  { id: 'hedge',    path: '/coberturas', label: 'Coberturas',     activeClass: 'modeHedgeActive', title: 'Coberturas' },
  { id: 'strategies', path: '/estrategias', label: 'Estrategias', activeClass: 'modeBtnActive', title: 'Estrategias' },
  { id: 'backtesting', path: '/backtesting', label: 'Backtesting', activeClass: 'modeBtnActive', title: 'Backtesting' },
  { id: 'bots', path: '/bots', label: 'Bots', activeClass: 'modeBtnActive', title: 'Bots' },
  { id: 'uniswap',  path: '/uniswap-pools', label: '🦄 Uniswap Pools', activeClass: 'modeBtnActive', title: 'Uniswap Pools' },
  { id: 'lp-orchestrator', path: '/lp-orchestrator', label: '🎛 Orquestador LP', activeClass: 'modeBtnActive', title: 'Orquestador LP' },
  { id: 'metricas', path: '/metricas', label: '📊 Metricas', activeClass: 'modeBtnActive', title: 'Metricas' },
  { id: 'trading-view', path: '/trading-view', label: '📈 Trading View', activeClass: 'modeBtnActive', title: 'Trading View' },
  { id: 'settings', path: '/config',     label: '⚙ Config',       activeClass: 'modeBtnActive',  title: 'Configuracion' },
];

const FULLSCREEN_ROUTES = new Set(['/trading-view']);

const SUPER_NAV = [
  { id: 'users', path: '/usuarios', label: '👥 Usuarios', activeClass: 'modeBtnActive', title: 'Usuarios' },
];

function AppContent() {
  const { user, isSuperuser, logout } = useAuth();
  const [selectedAsset, setSelectedAsset] = useState('BTC');
  const [menuOpen, setMenuOpen] = useState(false);
  const { isConnected, isPriceStale } = useTradingContext();
  const navigate = useNavigate();
  const location = useLocation();

  const navItems = isSuperuser ? [...BASE_NAV, ...SUPER_NAV] : BASE_NAV;
  // Rutas que quieren solo el navbar + su contenido edge-to-edge (sin sidebar,
  // sin padding del main). Ej: TradingView a pantalla completa.
  const isFullscreen = FULLSCREEN_ROUTES.has(location.pathname);

  const goTo = (path) => {
    navigate(path);
    setMenuOpen(false);
  };

  const isActive = (path) => location.pathname === path || (path === '/trade' && location.pathname === '/');

  // Dynamic page title
  useEffect(() => {
    const allNav = [...BASE_NAV, ...SUPER_NAV];
    const current = allNav.find(n => isActive(n.path));
    document.title = current ? `${current.title} | HLBot` : 'HLBot';
  }, [location.pathname]);

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
          <div className={styles.logoStack}>
            <span className={styles.logoText}>Hyperliquid Bot</span>
            {IS_DEV && (
              <span className={styles.devWatermark} title="Modo de logs intensivos activo (NODE_ENV=development). Errores y warnings del server + cliente se capturan en tiempo real.">
                ⚙ DEV LOGS ACTIVE
              </span>
            )}
          </div>
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

      <main className={`${styles.main} ${isFullscreen ? styles.mainFullscreen : ''}`}>
        {!isFullscreen && (
          <aside className={styles.sidebar}>
            <PricePanel selectedAsset={selectedAsset} onSelectAsset={setSelectedAsset} />
          </aside>
        )}

        <section className={`${styles.content} ${isFullscreen ? styles.contentFullscreen : ''}`}>
          <ErrorBoundary>
            <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-tertiary)' }}>Cargando…</div>}>
              <Routes>
                <Route path="/"           element={<Navigate to="/trade" replace />} />
                <Route path="/trade"      element={<TradingPanel selectedAsset={selectedAsset} />} />
                <Route path="/coberturas" element={<HedgePanel selectedAsset={selectedAsset} />} />
                <Route path="/estrategias" element={<StrategyStudioPage />} />
                <Route path="/backtesting" element={<BacktestingPage />} />
                <Route path="/bots" element={<BotsPage selectedAsset={selectedAsset} />} />
                <Route path="/uniswap-pools" element={<UniswapPoolsPage />} />
                <Route path="/lp-orchestrator" element={<LpOrchestratorPage />} />
                <Route path="/metricas"   element={<MetricasPage />} />
                <Route path="/trading-view" element={<TradingViewPage />} />
                <Route path="/config"     element={<SettingsPage />} />
                {/* Ruta oculta — no aparece en el navbar. Acciones de
                    recovery / mantenimiento manual. Acceso por URL directo. */}
                <Route path="/hidenActions" element={<HidenActionsPage />} />
                {isSuperuser && <Route path="/usuarios" element={<UsersPage />} />}
                <Route path="*"           element={<Navigate to="/trade" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </section>
      </main>

      <Notifications />

      {IS_DEV && DevLogPanel && (
        <Suspense fallback={null}>
          <DevLogPanel />
        </Suspense>
      )}
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
