import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { optionsApi, settingsApi } from '../../services/api';
import { MOBILE_QUERY, useMediaQuery } from '../TradingView/useMediaQuery';
import BottomSheet from '../TradingView/components/BottomSheet';
import { usePolling } from './manual/hooks/usePolling';
import ManualTradingTab from './manual/ManualTradingTab';
import StrategiesTab from './strategies/StrategiesTab';
import BacktestingTab from './backtesting/BacktestingTab';
import { fmtPct, fmtSpot, toneOf } from './format';
import { BacktestIcon, ChevronDownIcon, ManualIcon, StrategiesIcon } from './icons';
import styles from './OptionsPage.module.css';

export const OPTION_TABS = [
  { key: 'manual', label: 'Trading manual', short: 'Manual', Icon: ManualIcon },
  { key: 'strategies', label: 'Estrategias', short: 'Estrategias', Icon: StrategiesIcon },
  { key: 'backtesting', label: 'Backtesting', short: 'Backtest', Icon: BacktestIcon },
];
const TAB_KEYS = new Set(OPTION_TABS.map((t) => t.key));

// Subyacentes de Binance Opciones: lista de respaldo mientras llega la real.
const FALLBACK_UNDERLYINGS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'].map((u) => ({ underlying: u }));
const UNDERLYINGS_POLL_MS = 10000;
const STORAGE_KEY = 'options.underlying';

function readStoredUnderlying() {
  try { return localStorage.getItem(STORAGE_KEY) || 'BTC'; } catch { return 'BTC'; }
}

function ConnectionChip({ status, compact = false }) {
  if (status.loading) {
    return <span className={`${styles.chip} ${styles.chipIdle}`}>{compact ? 'Binance' : 'Comprobando conexión…'}</span>;
  }
  if (status.configured) {
    return (
      <span className={`${styles.chip} ${styles.chipOk}`} title={status.alias || undefined}>
        <span className={styles.dot} aria-hidden="true" />
        {compact ? 'Binance' : 'Binance Opciones · conectada'}
      </span>
    );
  }
  return (
    <Link to="/config?section=binanceOptions" className={`${styles.chip} ${styles.chipWarn}`}>
      <span className={styles.dot} aria-hidden="true" />
      {compact ? 'Conectar' : 'Conectar Binance Opciones'}
    </Link>
  );
}

export default function OptionsPage() {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [params] = useSearchParams();
  const rawTab = params.get('tab');
  const tab = TAB_KEYS.has(rawTab) ? rawTab : 'manual';

  const [underlying, setUnderlyingState] = useState(readStoredUnderlying);
  const setUnderlying = (u) => {
    setUnderlyingState(u);
    try { localStorage.setItem(STORAGE_KEY, u); } catch { /* almacenamiento no disponible */ }
  };
  const [pickerOpen, setPickerOpen] = useState(false);

  const fetchUnderlyings = useCallback(() => optionsApi.getUnderlyings(), []);
  const { data: underlyingsData } = usePolling(fetchUnderlyings, { intervalMs: UNDERLYINGS_POLL_MS, key: 'underlyings' });
  const underlyings = Array.isArray(underlyingsData) && underlyingsData.length ? underlyingsData : FALLBACK_UNDERLYINGS;
  const current = underlyings.find((u) => u.underlying === underlying) || { underlying };

  const [connection, setConnection] = useState({ loading: true, configured: false, alias: null });
  useEffect(() => {
    let alive = true;
    settingsApi.getBinanceOptions()
      .then((d) => { if (alive) setConnection({ loading: false, configured: !!d?.configured, alias: d?.alias || null }); })
      .catch(() => { if (alive) setConnection({ loading: false, configured: false, alias: null }); });
    return () => { alive = false; };
  }, []);

  const tabHref = (key) => ({ search: key === 'manual' ? '' : `?tab=${key}` });
  const changeTone = toneOf(current.change24hPct);
  const shared = { underlying, underlyings, configured: connection.configured, isMobile };

  return (
    <div className={`${styles.page} ${isMobile ? styles.pageMobile : ''}`}>
      {isMobile ? (
        <header className={styles.mHeader}>
          <button
            type="button"
            className={styles.underlyingChip}
            onClick={() => setPickerOpen(true)}
            aria-label={`Subyacente: ${underlying}. Cambiar`}
            aria-haspopup="dialog"
          >
            {underlying}
            <ChevronDownIcon size={14} strokeWidth={2.5} />
          </button>
          <div className={styles.mHeaderRight}>
            <div className={styles.mSpot}>
              <span className={`${styles.mono} ${styles.mSpotValue}`}>{fmtSpot(current.spot)}</span>
              <span className={`${styles.mono} ${styles.change} ${styles[changeTone]}`}>{fmtPct(current.change24hPct)} 24h</span>
            </div>
            <ConnectionChip status={connection} compact />
          </div>
        </header>
      ) : (
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.title}>Opciones</h1>
            <div role="group" aria-label="Subyacente" className={styles.pills}>
              {underlyings.map((u) => (
                <button
                  key={u.underlying}
                  type="button"
                  className={`${styles.pill} ${u.underlying === underlying ? styles.pillOn : ''}`}
                  aria-pressed={u.underlying === underlying}
                  onClick={() => setUnderlying(u.underlying)}
                >
                  {u.underlying}
                </button>
              ))}
            </div>
            <div className={styles.spot}>
              <span className={`${styles.mono} ${styles.spotValue}`}>{fmtSpot(current.spot)} USDT</span>
              <span className={`${styles.mono} ${styles.change} ${styles[changeTone]}`}>{fmtPct(current.change24hPct)} 24h</span>
            </div>
          </div>
          <ConnectionChip status={connection} />
        </header>
      )}

      {isMobile ? (
        <nav aria-label="Secciones de opciones" className={styles.segmented}>
          {OPTION_TABS.map((t) => (
            <Link
              key={t.key}
              to={tabHref(t.key)}
              replace
              aria-current={tab === t.key ? 'page' : undefined}
              className={`${styles.segLink} ${tab === t.key ? styles.segLinkOn : ''}`}
            >
              {t.short}
            </Link>
          ))}
        </nav>
      ) : (
        <nav aria-label="Secciones de opciones" className={styles.tabs}>
          {OPTION_TABS.map((t) => (
            <Link
              key={t.key}
              to={tabHref(t.key)}
              replace
              aria-current={tab === t.key ? 'page' : undefined}
              className={`${styles.tabLink} ${tab === t.key ? styles.tabLinkOn : ''}`}
            >
              <t.Icon size={16} />
              {t.label}
            </Link>
          ))}
        </nav>
      )}

      <div className={styles.content}>
        {tab === 'manual' && (
          <ManualTradingTab underlying={underlying} configured={connection.configured} isMobile={isMobile} />
        )}
        {tab === 'strategies' && <StrategiesTab {...shared} />}
        {tab === 'backtesting' && <BacktestingTab {...shared} />}
      </div>

      {isMobile && (
        <BottomSheet open={pickerOpen} title="Subyacente" onClose={() => setPickerOpen(false)}>
          <div role="listbox" aria-label="Subyacente" className={styles.pickerList}>
            {underlyings.map((u) => {
              const on = u.underlying === underlying;
              return (
                <button
                  key={u.underlying}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`${styles.pickerRow} ${on ? styles.pickerRowOn : ''}`}
                  onClick={() => { setUnderlying(u.underlying); setPickerOpen(false); }}
                >
                  <span className={styles.pickerName}>{u.underlying}</span>
                  <span className={`${styles.mono} ${styles.pickerSpot}`}>{fmtSpot(u.spot)}</span>
                  <span className={`${styles.mono} ${styles.change} ${styles[toneOf(u.change24hPct)]}`}>{fmtPct(u.change24hPct)}</span>
                </button>
              );
            })}
          </div>
        </BottomSheet>
      )}
    </div>
  );
}
