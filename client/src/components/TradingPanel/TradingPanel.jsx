/**
 * TradingPanel.jsx — Operativa Manual
 * Layout 2 columnas: formulario izquierda | posiciones derecha
 */

import { useState, useEffect } from 'react';
import { useTradingContext } from '../../context/TradingContext';
import styles from './TradingPanel.module.css';

export function TradingPanel({ selectedAsset }) {
  const { prices, account, isLoadingAccount, openPosition, closePosition, refreshAccount } = useTradingContext();

  const [side,         setSide]         = useState('long');
  const [size,         setSize]         = useState('');
  const [leverage,     setLeverage]     = useState(10);
  const [marginMode,   setMarginMode]   = useState('cross');
  const [denomination, setDenomination] = useState('USDC');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const asset         = selectedAsset || 'BTC';
  const currentPrice  = prices[asset] ? parseFloat(prices[asset]) : null;
  const positionCount = account?.positions?.length ?? 0;

  useEffect(() => { refreshAccount(); }, []);

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
            const pnl    = parseFloat(pos.unrealizedPnl || 0);
            const entryPx = parseFloat(pos.entryPrice || 0);
            const markPx  = prices[pos.asset] ? parseFloat(prices[pos.asset]) : null;
            const isLong  = pos.side === 'long';

            return (
              <div key={pos.asset} className={styles.posCard}>
                <div className={styles.posHeader}>
                  <div className={styles.posLeft}>
                    <span className={styles.posAsset}>{pos.asset}</span>
                    <span className={`${styles.posBadge} ${isLong ? styles.longBadge : styles.shortBadge}`}>
                      {isLong ? '▲ L' : '▼ S'} {pos.leverage?.value ?? leverage}x
                    </span>
                    <span className={`${styles.pnlInline} ${pnl >= 0 ? styles.positive : styles.negative}`}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                    </span>
                  </div>
                  <button className={styles.closeBtn} onClick={() => handleClose(pos.asset)}>Cerrar</button>
                </div>

                <div className={styles.posGrid}>
                  <div className={styles.posDetail}>
                    <span className={styles.detailLabel}>Tamano</span>
                    <span className={styles.detailVal}>{Math.abs(parseFloat(pos.size)).toFixed(4)} {pos.asset}</span>
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
                    <span className={styles.detailVal}>${parseFloat(pos.marginUsed || 0).toFixed(2)}</span>
                  </div>
                  <div className={styles.posDetail}>
                    <span className={styles.detailLabel}>ROE</span>
                    <span className={`${styles.detailVal} ${parseFloat(pos.returnOnEquity || 0) >= 0 ? styles.positive : styles.negative}`}>
                      {(parseFloat(pos.returnOnEquity || 0) * 100).toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
