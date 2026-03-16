/**
 * TradingPanel.jsx — Operativa Manual
 * Layout 2 columnas: formulario izquierda | posiciones + ordenes derecha
 */

import { useState, useEffect, useCallback } from 'react';
import { useTradingContext } from '../../context/TradingContext';
import { tradingApi } from '../../services/api';
import { AccountAutocomplete } from '../shared/AccountAutocomplete';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { formatAccountIdentity } from '../../utils/hyperliquidAccounts';
import { TradeForm } from './TradeForm';
import { PositionsList } from './PositionsList';
import { SLTPModal } from './SLTPModal';
import { OrdersSection } from './OrdersSection';
import styles from './TradingPanel.module.css';

export function TradingPanel({ selectedAsset }) {
  const {
    prices,
    account,
    accounts,
    defaultAccountId,
    isLoadingAccount,
    isLoadingAccounts,
    isPriceStale,
    isConnected,
    openPosition,
    closePosition,
    refreshAccount,
    refreshAccountSummary,
    addNotification,
  } = useTradingContext();

  const [side,           setSide]           = useState('long');
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [size,           setSize]           = useState('');
  const [leverage,       setLeverage]       = useState(10);
  const [marginMode,     setMarginMode]     = useState('cross');
  const [denomination,   setDenomination]   = useState('USDC');
  const [isSubmitting,   setIsSubmitting]   = useState(false);
  const [openOrders,     setOpenOrders]     = useState([]);
  const [cancellingOid,  setCancellingOid]  = useState(null);
  const [sltpPos,        setSltpPos]        = useState(null);
  const [slPrice,        setSlPrice]        = useState('');
  const [tpPrice,        setTpPrice]        = useState('');
  const [sltpSubmitting, setSltpSubmitting] = useState(false);
  const [sltpError,      setSltpError]      = useState('');
  const [closingAsset,   setClosingAsset]   = useState(null);
  const [confirm,        setConfirm]        = useState(null);

  const asset         = selectedAsset || 'BTC';
  const currentPrice  = prices[asset] ? parseFloat(prices[asset]) : null;
  const positionCount = account?.positions?.length ?? 0;
  const priceUnavailable = !isConnected || isPriceStale;
  const selectedAccount = accounts.find((item) => Number(item.id) === Number(selectedAccountId)) || null;

  const sizeInAsset = size && currentPrice
    ? denomination === 'USDC' ? parseFloat(size) / currentPrice : parseFloat(size)
    : null;
  const notional            = sizeInAsset && currentPrice ? sizeInAsset * currentPrice : null;
  const requiredMargin      = notional ? notional / leverage : null;
  const availableMargin     = parseFloat(account?.withdrawable || 0);
  const hasInsufficientMargin = requiredMargin !== null && requiredMargin > availableMargin;

  // --- Data fetching ---

  const refreshOrders = useCallback(async ({ force = false } = {}) => {
    if (!selectedAccountId) { setOpenOrders([]); return; }
    try {
      const data = await tradingApi.getOpenOrders({ accountId: selectedAccountId, refresh: force });
      setOpenOrders(Array.isArray(data?.orders) ? data.orders : []);
    } catch (err) {
      addNotification('error', `Error al cargar ordenes: ${err.message}`);
      setOpenOrders([]);
    }
  }, [addNotification, selectedAccountId]);

  useEffect(() => {
    if (!selectedAccountId && defaultAccountId) setSelectedAccountId(defaultAccountId);
  }, [defaultAccountId, selectedAccountId]);

  useEffect(() => {
    if (!selectedAccountId) return undefined;
    refreshAccount({ accountId: selectedAccountId, force: true }).catch(() => {});
    refreshOrders({ force: true });
    refreshAccountSummary(selectedAccountId, { force: true }).catch(() => {});
    const interval = setInterval(() => {
      refreshAccount({ accountId: selectedAccountId }).catch(() => {});
      refreshOrders().catch(() => {});
    }, 30_000);
    return () => clearInterval(interval);
  }, [refreshAccount, refreshAccountSummary, refreshOrders, selectedAccountId]);

  // --- Handlers ---

  const handleOpen = async (e) => {
    e.preventDefault();
    if (!selectedAccountId || !sizeInAsset || sizeInAsset <= 0) return;
    setIsSubmitting(true);
    try {
      await openPosition({ accountId: selectedAccountId, asset, side, size: sizeInAsset, leverage, marginMode });
      await refreshAccountSummary(selectedAccountId, { force: true }).catch(() => {});
      setSize('');
    } catch { /* notified by context */ } finally { setIsSubmitting(false); }
  };

  const handleClose = async (posAsset) => {
    setConfirm({
      title: 'Cerrar posicion',
      message: `¿Cerrar toda la posicion de ${posAsset} a mercado? Esta accion no se puede deshacer.`,
      confirmLabel: 'Cerrar posicion',
      onConfirm: async () => {
        setConfirm(null);
        setClosingAsset(posAsset);
        try {
          await closePosition({ accountId: selectedAccountId, asset: posAsset });
          setTimeout(() => {
            refreshAccount({ accountId: selectedAccountId, force: true }).catch(() => {});
          }, 800);
        } catch { /* notified by context */ } finally { setClosingAsset(null); }
      },
    });
  };

  const openSltpModal = (pos) => {
    setSltpPos(pos);
    setSlPrice('');
    setTpPrice('');
    setSltpError('');
  };

  const handleSetSLTP = async (e) => {
    e.preventDefault();
    if (!slPrice && !tpPrice) return;
    setSltpSubmitting(true);
    setSltpError('');
    try {
      const posSize = Math.abs(parseFloat(sltpPos.size));
      await tradingApi.setSLTP({
        accountId: selectedAccountId,
        asset: sltpPos.asset,
        side:  sltpPos.side,
        size:  posSize,
        slPrice: slPrice ? parseFloat(slPrice) : undefined,
        tpPrice: tpPrice ? parseFloat(tpPrice) : undefined,
      });
      setSltpPos(null);
      addNotification('success', `${formatAccountIdentity(selectedAccount)}\nSL/TP configurado para ${sltpPos.asset}`);
    } catch (err) {
      setSltpError(err.message);
    } finally { setSltpSubmitting(false); }
  };

  const handleCancelOrder = async (orderAsset, oid) => {
    setConfirm({
      title: 'Cancelar orden',
      message: `¿Cancelar la orden de ${orderAsset}?`,
      confirmLabel: 'Cancelar orden',
      onConfirm: async () => {
        setConfirm(null);
        setCancellingOid(oid);
        try {
          await tradingApi.cancelOrder(orderAsset, oid, { accountId: selectedAccountId });
          await refreshOrders();
          addNotification('success', `${formatAccountIdentity(selectedAccount)}\nOrden ${orderAsset} cancelada`);
        } catch (err) {
          addNotification('error', `Error al cancelar orden: ${err.message}`);
        } finally { setCancellingOid(null); }
      },
    });
  };

  const handleRefresh = () => {
    refreshAccount({ accountId: selectedAccountId, force: true }).catch(() => {});
    refreshOrders({ force: true }).catch(() => {});
    refreshAccountSummary(selectedAccountId, { force: true }).catch(() => {});
  };

  // --- Render ---

  return (
    <div className={styles.container}>

      {priceUnavailable && (
        <div className={styles.staleBanner}>
          <span>⚠ {!isConnected ? 'Sin conexion al servidor' : 'Precios desactualizados'} — operaciones deshabilitadas</span>
        </div>
      )}

      <div className={styles.topBar}>
        <span className={styles.title}>Trading Manual</span>
        <div className={styles.assetPrice}>
          <span className={styles.assetTag}>{asset}/USDC</span>
          {currentPrice && (
            <span className={styles.livePrice}>
              ${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          )}
        </div>
      </div>

      <div className={styles.accountSelector}>
        <AccountAutocomplete
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onSelect={(selected) => {
            setSelectedAccountId(selected.id);
            refreshAccountSummary(selected.id, { force: true }).catch(() => {});
          }}
          label="Cuenta de trading"
          disabled={isLoadingAccounts || accounts.length === 0}
          placeholder="Selecciona una cuenta de Hyperliquid"
        />
      </div>

      {account && selectedAccountId && (
        <div className={styles.accountStrip}>
          <div className={styles.accountIdentity}>
            <span className={styles.accountIdentityLabel}>Cuenta activa</span>
            <span className={styles.accountIdentityValue}>{formatAccountIdentity(account.account || selectedAccount)}</span>
          </div>
          <div className={styles.accountDivider} />
          <div className={styles.accountItem}>
            <span className={styles.accountLabel}>Balance</span>
            <span className={styles.accountValue}>${parseFloat(account.accountValue || 0).toFixed(2)}</span>
          </div>
          <div className={styles.accountDivider} />
          <div className={styles.accountItem}>
            <span className={styles.accountLabel}>Margen usado</span>
            <span className={styles.accountValue}>${parseFloat(account.totalMarginUsed || 0).toFixed(2)}</span>
          </div>
          <div className={styles.accountDivider} />
          <div className={styles.accountItem}>
            <span className={styles.accountLabel}>Retirable</span>
            <span className={`${styles.accountValue} ${styles.withdrawable}`}>${parseFloat(account.withdrawable || 0).toFixed(2)}</span>
          </div>
          <button className={styles.refreshBtn} onClick={handleRefresh} title="Refrescar" aria-label="Refrescar cuenta">↻</button>
        </div>
      )}

      <div className={styles.body}>
        <TradeForm
          side={side}
          setSide={setSide}
          marginMode={marginMode}
          setMarginMode={setMarginMode}
          leverage={leverage}
          setLeverage={setLeverage}
          denomination={denomination}
          setDenomination={setDenomination}
          size={size}
          setSize={setSize}
          asset={asset}
          currentPrice={currentPrice}
          sizeInAsset={sizeInAsset}
          notional={notional}
          requiredMargin={requiredMargin}
          availableMargin={availableMargin}
          hasInsufficientMargin={hasInsufficientMargin}
          isSubmitting={isSubmitting}
          selectedAccountId={selectedAccountId}
          priceUnavailable={priceUnavailable}
          onSubmit={handleOpen}
        />

        <div className={styles.positionsCol}>
          <div className={styles.posColHeader}>
            <span className={styles.colLabel}>
              Posiciones abiertas
              {positionCount > 0 && <span className={styles.badge}>{positionCount}</span>}
            </span>
            <button
              className={styles.refreshBtn}
              onClick={() => {
                refreshAccount({ accountId: selectedAccountId, force: true }).catch(() => {});
                refreshOrders({ force: true }).catch(() => {});
              }}
              title="Refrescar"
              aria-label="Refrescar posiciones"
            >↻</button>
          </div>

          <PositionsList
            positions={account?.positions}
            positionCount={positionCount}
            prices={prices}
            leverage={leverage}
            isLoadingAccount={isLoadingAccount}
            selectedAccountId={selectedAccountId}
            closingAsset={closingAsset}
            onClose={handleClose}
            onOpenSltp={openSltpModal}
          />

          <OrdersSection
            openOrders={openOrders}
            cancellingOid={cancellingOid}
            onCancelOrder={handleCancelOrder}
          />
        </div>
      </div>

      <SLTPModal
        sltpPos={sltpPos}
        slPrice={slPrice}
        setSlPrice={setSlPrice}
        tpPrice={tpPrice}
        setTpPrice={setTpPrice}
        sltpSubmitting={sltpSubmitting}
        sltpError={sltpError}
        onSubmit={handleSetSLTP}
        onClose={() => setSltpPos(null)}
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        onConfirm={confirm?.onConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
