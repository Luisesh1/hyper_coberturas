/**
 * TradingPanel.jsx — Operativa Manual
 * Layout 2 columnas: formulario izquierda | posiciones + órdenes derecha
 */

import { useState, useEffect, useCallback } from 'react';
import { useTradingContext } from '../../context/TradingContext';
import { tradingApi } from '../../services/api';
import styles from './TradingPanel.module.css';

export function TradingPanel({ selectedAsset }) {
  const { prices, account, isLoadingAccount, openPosition, closePosition, refreshAccount } = useTradingContext();

  const [side,           setSide]           = useState('long');
  const [size,           setSize]           = useState('');
  const [leverage,       setLeverage]       = useState(10);
  const [marginMode,     setMarginMode]     = useState('cross');
  const [denomination,   setDenomination]   = useState('USDC');
  const [isSubmitting,   setIsSubmitting]   = useState(false);
  const [openOrders,     setOpenOrders]     = useState([]);
  const [cancellingOid,  setCancellingOid]  = useState(null);
  const [sltpPos,        setSltpPos]        = useState(null);   // pos object for SL/TP modal
  const [slPrice,        setSlPrice]        = useState('');
  const [tpPrice,        setTpPrice]        = useState('');
  const [sltpSubmitting, setSltpSubmitting] = useState(false);
  const [sltpError,      setSltpError]      = useState('');

  const asset         = selectedAsset || 'BTC';
  const currentPrice  = prices[asset] ? parseFloat(prices[asset]) : null;
  const positionCount = account?.positions?.length ?? 0;

  const refreshOrders = useCallback(async () => {
    try {
      const orders = await tradingApi.getOpenOrders();
      setOpenOrders(Array.isArray(orders) ? orders : []);
    } catch { setOpenOrders([]); }
  }, []);

  // Initial load + auto-refresh every 30s
  useEffect(() => {
    refreshAccount();
    refreshOrders();
    const interval = setInterval(() => {
      refreshAccount();
      refreshOrders();
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const handleOpen = async (e) => {
    e.preventDefault();
    if (!sizeInAsset || sizeInAsset <= 0) return;
    setIsSubmitting(true);
    try {
      await openPosition({ asset, side, size: sizeInAsset, leverage, marginMode });
      setSize('');
    } catch { } finally { setIsSubmitting(false); }
  };

  const handleClose = async (posAsset) => {
    await closePosition({ asset: posAsset });
    setTimeout(refreshAccount, 800);
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
        asset: sltpPos.asset,
        side:  sltpPos.side,
        size:  posSize,
        slPrice: slPrice ? parseFloat(slPrice) : undefined,
        tpPrice: tpPrice ? parseFloat(tpPrice) : undefined,
      });
      setSltpPos(null);
    } catch (err) {
      setSltpError(err.message);
    } finally {
      setSltpSubmitting(false);
    }
  };

  const handleCancelOrder = async (orderAsset, oid) => {
    setCancellingOid(oid);
    try {
      await tradingApi.cancelOrder(orderAsset, oid);
      await refreshOrders();
    } catch { } finally { setCancellingOid(null); }
  };

  const sizeInAsset = size && currentPrice
    ? denomination === 'USDC' ? parseFloat(size) / currentPrice : parseFloat(size)
    : null;

  const notional            = sizeInAsset && currentPrice ? sizeInAsset * currentPrice : null;
  const requiredMargin      = notional ? notional / leverage : null;
  const availableMargin     = parseFloat(account?.withdrawable || 0);
  const hasInsufficientMargin = requiredMargin !== null && requiredMargin > availableMargin;

  return (
    <div className={styles.container}>

      {/* Barra superior */}
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

      {/* Strip de cuenta */}
      {account && (
        <div className={styles.accountStrip}>
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
          <button className={styles.refreshBtn} onClick={refreshAccount} title="Refrescar">↻</button>
        </div>
      )}

      {/* Cuerpo 2 columnas */}
      <div className={styles.body}>

        {/* Columna izquierda: formulario */}
        <form className={styles.formCol} onSubmit={handleOpen}>
          <div className={styles.colLabel}>Abrir posicion</div>

          <div className={styles.sideRow}>
            <button type="button" className={`${styles.sideBtn} ${side === 'long'  ? styles.longActive  : ''}`} onClick={() => setSide('long')}>▲ Long</button>
            <button type="button" className={`${styles.sideBtn} ${side === 'short' ? styles.shortActive : ''}`} onClick={() => setSide('short')}>▼ Short</button>
          </div>

          <div className={styles.field}>
            <span className={styles.label}>Tipo de margen</span>
            <div className={styles.segmented}>
              {['cross', 'isolated'].map((m) => (
                <button key={m} type="button" className={`${styles.segBtn} ${marginMode === m ? styles.segActive : ''}`} onClick={() => setMarginMode(m)}>
                  {m === 'cross' ? 'Cross' : 'Isolated'}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.field}>
            <div className={styles.labelRow}>
              <span className={styles.label}>Apalancamiento</span>
              <span className={styles.leverageValue}>{leverage}x</span>
            </div>
            <input type="range" min="1" max="50" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className={styles.slider} />
            <div className={styles.leveragePresets}>
              {[1, 2, 5, 10, 20, 50].map((v) => (
                <button key={v} type="button" className={`${styles.preset} ${leverage === v ? styles.presetActive : ''}`} onClick={() => setLeverage(v)}>{v}x</button>
              ))}
            </div>
          </div>

          <div className={styles.field}>
            <div className={styles.labelRow}>
              <span className={styles.label}>Cantidad ({denomination})</span>
              <div className={styles.denomToggle}>
                {['USDC', asset].map((d) => (
                  <button key={d} type="button" className={`${styles.denomBtn} ${denomination === d ? styles.denomActive : ''}`} onClick={() => { setDenomination(d); setSize(''); }}>{d}</button>
                ))}
              </div>
            </div>
            <input
              className={styles.input}
              type="number"
              step={denomination === 'USDC' ? '0.01' : '0.0001'}
              min={denomination === 'USDC' ? '0.01' : '0.0001'}
              placeholder={denomination === 'USDC' ? 'ej: 100' : 'ej: 0.001'}
              value={size}
              onChange={(e) => setSize(e.target.value)}
              required
            />
          </div>

          {notional !== null && (
            <div className={styles.summary}>
              {denomination === 'USDC' && sizeInAsset > 0 && (
                <div className={styles.summaryRow}>
                  <span>En {asset}</span>
                  <span>{sizeInAsset.toFixed(6)}</span>
                </div>
              )}
              <div className={styles.summaryRow}>
                <span>Nocional</span>
                <span>${notional.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              </div>
              <div className={`${styles.summaryRow} ${hasInsufficientMargin ? styles.danger : ''}`}>
                <span>Margen req / disp</span>
                <span>${requiredMargin.toFixed(2)} / ${availableMargin.toFixed(2)}</span>
              </div>
            </div>
          )}

          <button type="submit" className={`${styles.submitBtn} ${side === 'long' ? styles.longBtn : styles.shortBtn}`}
            disabled={isSubmitting || !size || !currentPrice || hasInsufficientMargin}>
            {isSubmitting ? 'Enviando...' : `${side === 'long' ? '▲ Long' : '▼ Short'} ${asset} a mercado`}
          </button>

          {!currentPrice && <p className={styles.warn}>Esperando precio...</p>}
          {hasInsufficientMargin && (
            <p className={styles.warn} style={{ color: '#ef4444' }}>Margen insuficiente: req ${requiredMargin.toFixed(2)}</p>
          )}
        </form>

        {/* Columna derecha: posiciones */}
        <div className={styles.positionsCol}>
          <div className={styles.posColHeader}>
            <span className={styles.colLabel}>
              Posiciones abiertas
              {positionCount > 0 && <span className={styles.badge}>{positionCount}</span>}
            </span>
            <button className={styles.refreshBtn} onClick={refreshAccount} title="Refrescar">↻</button>
          </div>

          {isLoadingAccount && <p className={styles.empty}>Cargando posiciones...</p>}
          {!isLoadingAccount && positionCount === 0 && <p className={styles.empty}>Sin posiciones abiertas</p>}

          {account?.positions?.map((pos) => {
            const entryPx    = parseFloat(pos.entryPrice || 0);
            const posSize    = Math.abs(parseFloat(pos.size));
            const marginUsed = parseFloat(pos.marginUsed || 0);
            const isLong     = pos.side === 'long';
            const markPx     = prices[pos.asset] ? parseFloat(prices[pos.asset]) : null;

            // Live unrealized PnL calculated from WS price
            const livePnl = markPx && entryPx
              ? (isLong ? 1 : -1) * (markPx - entryPx) * posSize
              : parseFloat(pos.unrealizedPnl || 0);
            const liveRoe = marginUsed > 0 ? livePnl / marginUsed : 0;

            return (
              <div key={pos.asset} className={styles.posCard}>
                <div className={styles.posHeader}>
                  <div className={styles.posLeft}>
                    <span className={styles.posAsset}>{pos.asset}</span>
                    <span className={`${styles.posBadge} ${isLong ? styles.longBadge : styles.shortBadge}`}>
                      {isLong ? '▲ L' : '▼ S'} {pos.leverage?.value ?? leverage}x
                    </span>
                    <span className={`${styles.pnlInline} ${livePnl >= 0 ? styles.positive : styles.negative}`}>
                      {livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)}
                    </span>
                  </div>
                  <div className={styles.posBtns}>
                    <button className={styles.sltpBtn} onClick={() => openSltpModal(pos)}>SL/TP</button>
                    <button className={styles.closeBtn} onClick={() => handleClose(pos.asset)}>Cerrar todo</button>
                  </div>
                </div>

                <div className={styles.posGrid}>
                  <div className={styles.posDetail}>
                    <span className={styles.detailLabel}>Tamano</span>
                    <span className={styles.detailVal}>{posSize.toFixed(4)} {pos.asset}</span>
                  </div>
                  <div className={styles.posDetail}>
                    <span className={styles.detailLabel}>Entrada</span>
                    <span className={styles.detailVal}>${entryPx.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className={styles.posDetail}>
                    <span className={styles.detailLabel}>Actual</span>
                    <span className={styles.detailVal}>{markPx ? `$${markPx.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}</span>
                  </div>
                  {pos.liquidationPrice && (
                    <div className={styles.posDetail}>
                      <span className={styles.detailLabel}>Liquidacion</span>
                      <span className={`${styles.detailVal} ${styles.liqPrice}`}>${parseFloat(pos.liquidationPrice).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                    </div>
                  )}
                  <div className={styles.posDetail}>
                    <span className={styles.detailLabel}>Margen</span>
                    <span className={styles.detailVal}>${marginUsed.toFixed(2)}</span>
                  </div>
                  <div className={styles.posDetail}>
                    <span className={styles.detailLabel}>ROE</span>
                    <span className={`${styles.detailVal} ${liveRoe >= 0 ? styles.positive : styles.negative}`}>
                      {(liveRoe * 100).toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Ordenes abiertas */}
          {openOrders.length > 0 && (
            <>
              <div className={styles.ordersHeader}>
                <span className={styles.colLabel}>
                  Ordenes abiertas
                  <span className={styles.badge}>{openOrders.length}</span>
                </span>
              </div>
              {openOrders.map((order) => {
                const isBuy = order.side === 'B';
                return (
                  <div key={order.oid} className={styles.orderRow}>
                    <div className={styles.orderLeft}>
                      <span className={styles.orderAsset}>{order.coin}</span>
                      <span className={`${styles.orderBadge} ${isBuy ? styles.longBadge : styles.shortBadge}`}>
                        {isBuy ? '▲ Buy' : '▼ Sell'}
                      </span>
                      <span className={styles.orderType}>{order.orderType ?? 'Limit'}</span>
                    </div>
                    <div className={styles.orderMid}>
                      <span className={styles.orderDetail}>{parseFloat(order.sz).toFixed(4)} @ ${parseFloat(order.limitPx).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <button
                      className={styles.cancelBtn}
                      onClick={() => handleCancelOrder(order.coin, order.oid)}
                      disabled={cancellingOid === order.oid}
                    >
                      {cancellingOid === order.oid ? '...' : '✕'}
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
      {/* Modal SL/TP */}
      {sltpPos && (
        <div className={styles.modalOverlay} onClick={() => setSltpPos(null)}>
          <form className={styles.modalBox} onClick={(e) => e.stopPropagation()} onSubmit={handleSetSLTP}>
            <div className={styles.modalHeader}>
              <span>SL / TP — {sltpPos.asset} {sltpPos.side === 'long' ? '▲ Long' : '▼ Short'}</span>
              <button type="button" className={styles.modalClose} onClick={() => setSltpPos(null)}>✕</button>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Stop Loss (precio trigger)</span>
              <input
                className={styles.input}
                type="number"
                step="0.01"
                min="0.01"
                placeholder="ej: 90000"
                value={slPrice}
                onChange={(e) => setSlPrice(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Take Profit (precio trigger)</span>
              <input
                className={styles.input}
                type="number"
                step="0.01"
                min="0.01"
                placeholder="ej: 105000"
                value={tpPrice}
                onChange={(e) => setTpPrice(e.target.value)}
              />
            </div>
            {sltpError && <p className={styles.warn} style={{ color: '#ef4444' }}>{sltpError}</p>}
            <button
              type="submit"
              className={styles.submitBtn}
              disabled={sltpSubmitting || (!slPrice && !tpPrice)}
            >
              {sltpSubmitting ? 'Enviando...' : 'Confirmar SL/TP'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
