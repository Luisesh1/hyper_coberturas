import { useEffect, useMemo, useState } from 'react';
import { settingsApi, uniswapApi } from '../services/api';
import styles from './UniswapPoolsPage.module.css';

function shortAddress(value) {
  if (!value) return '—';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp * 1000).toLocaleString('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatNumber(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(numeric);
}

function formatCompactUsd(value) {
  if (value == null) return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${formatNumber(n, 2)}`;
}

function formatUsd(value) {
  if (value == null) return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  return `$${formatNumber(n, 2)}`;
}

function formatSignedUsd(value) {
  if (value == null) return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${formatNumber(Math.abs(n), 2)}`;
}

function formatPercent(value) {
  if (value == null) return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatNumber(n, Math.abs(n) >= 10 ? 2 : 4)}%`;
}

function formatDuration(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  const minutes = Math.max(1, Math.floor(numeric / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatPrice(value, baseSymbol, quoteSymbol) {
  if (value == null) return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 'N/A';
  return `${formatNumber(numeric, numeric >= 100 ? 2 : 6)} ${quoteSymbol}/${baseSymbol}`;
}

function getExplorerLink(baseUrl, kind, value) {
  if (!baseUrl || !value) return null;
  if (kind === 'tx') return `${baseUrl}/tx/${value}`;
  if (kind === 'address') return `${baseUrl}/address/${value}`;
  return null;
}

function getStatusInfo(pool) {
  if (pool.currentOutOfRangeSide === 'below') {
    return { label: 'Fuera por abajo', cls: styles.badgeOor };
  }
  if (pool.currentOutOfRangeSide === 'above') {
    return { label: 'Fuera por arriba', cls: styles.badgeOor };
  }
  if (pool.status === 'active') {
    return { label: 'Activa', cls: styles.badgeActive };
  }
  return { label: 'Inactiva', cls: styles.badgeInactive };
}

function formatCompactPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 10000) return formatNumber(n, 0);
  if (n >= 100) return formatNumber(n, 2);
  if (n >= 1) return formatNumber(n, 4);
  return formatNumber(n, 6);
}

function getRangeBarData(pool) {
  const lower = Number(pool.rangeLowerPrice);
  const upper = Number(pool.rangeUpperPrice);
  const open = Number(pool.priceAtOpen);
  const current = Number(pool.priceCurrent);

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower === upper) {
    return null;
  }

  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  // Extend the visual range 15% on each side so markers near edges are visible
  const padding = (max - min) * 0.15;
  const visMin = min - padding;
  const visMax = max + padding;
  const normalize = (value) => {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, ((value - visMin) / (visMax - visMin)) * 100));
  };

  return {
    rangeLowPct: normalize(min),
    rangeHighPct: normalize(max),
    openPct: normalize(open),
    currentPct: normalize(current),
    openPrice: open,
    currentPrice: current,
    lowerPrice: min,
    upperPrice: max,
    currentOutOfRangeSide: pool.currentOutOfRangeSide,
  };
}

function PoolCard({ pool }) {
  const isV1 = pool.version === 'v1';
  const isV4 = pool.version === 'v4';
  const isLpPosition = pool.mode === 'lp_position' || pool.mode === 'lp_positions';
  const poolLink = getExplorerLink(pool.explorerUrl, 'address', pool.poolAddress);
  const txLink = getExplorerLink(pool.explorerUrl, 'tx', pool.txHash);
  const ownerValue = pool.owner || pool.creator;
  const creatorLink = getExplorerLink(pool.explorerUrl, 'address', ownerValue);
  const rangeBar = isLpPosition ? getRangeBarData(pool) : null;
  const openedAt = pool.openedAt || pool.createdAt;
  const openPriceLabel = pool.priceAtOpenAccuracy === 'approximate'
    ? 'Aprox.'
    : pool.priceAtOpenAccuracy === 'exact'
      ? 'Exacto'
      : null;
  const status = getStatusInfo(pool);
  const pnlValue = Number(pool.pnlTotalUsd);
  const pnlClass = Number.isFinite(pnlValue)
    ? pnlValue > 0
      ? styles.kpiPositive
      : pnlValue < 0
        ? styles.kpiNegative
        : styles.kpiNeutral
    : styles.kpiNeutral;

  return (
    <article className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.cardPair}>
            {pool.token0.symbol} / {pool.token1.symbol}
          </div>
          <div className={styles.cardMetaLine}>
            <span className={styles.versionBadge}>{pool.version.toUpperCase()}</span>
            <span className={styles.networkBadge}>{pool.networkLabel}</span>
            {pool.poolAddress && (
              <a className={styles.metaLink} href={poolLink} target="_blank" rel="noreferrer">
                {isV1 ? 'Exchange' : 'Pool'}
              </a>
            )}
            {isV4 && <span className={styles.v4Tag}>PoolManager</span>}
          </div>
        </div>
        <span className={`${styles.blockBadge} ${status.cls}`}>{status.label}</span>
      </div>

      <div className={styles.infoGrid}>
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>{isLpPosition ? 'Owner' : 'Creador'}</span>
          <a className={styles.addressLink} href={creatorLink} target="_blank" rel="noreferrer">
            {shortAddress(ownerValue)}
          </a>
        </div>

        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Transaccion</span>
          {txLink ? (
            <a className={styles.addressLink} href={txLink} target="_blank" rel="noreferrer">
              {shortAddress(pool.txHash)}
            </a>
          ) : (
            <span className={styles.infoValue}>No cargado</span>
          )}
        </div>

        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>{isLpPosition ? 'Fecha de apertura' : 'Creado'}</span>
          <span className={styles.infoValue}>{formatTimestamp(openedAt)}</span>
        </div>

        {isLpPosition && (
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Tiempo activo</span>
            <span className={styles.infoValue}>{formatDuration(pool.activeForMs)}</span>
          </div>
        )}

        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>{isLpPosition ? 'Posicion' : isV4 ? 'Pool ID' : 'Identificador'}</span>
          <span className={styles.hashValue}>
            {isV4 ? shortAddress(pool.identifier) : shortAddress(pool.poolAddress || pool.identifier)}
          </span>
        </div>

        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Par</span>
          <span className={styles.infoValue}>
            {pool.token0.symbol} / {pool.token1.symbol}
          </span>
        </div>

        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Fee / detalle</span>
          <span className={styles.infoValue}>
            {pool.fee != null ? `${pool.fee} bps` : '—'}
            {pool.tickSpacing != null ? ` · tick ${pool.tickSpacing}` : ''}
          </span>
        </div>

        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Liquidez actual</span>
          <span className={styles.infoValue}>{pool.liquiditySummary?.text || '—'}</span>
        </div>

        {isLpPosition && (
          <div className={`${styles.infoItem} ${styles.infoItemWide}`}>
            <span className={styles.infoLabel}>Seguimiento de inversion</span>
            <div className={styles.kpiGrid}>
              <div className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Capital inicial</span>
                <span className={styles.kpiValue}>{formatUsd(pool.initialValueUsd)}</span>
              </div>
              <div className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Valor actual</span>
                <span className={styles.kpiValue}>{formatUsd(pool.currentValueUsd)}</span>
              </div>
              <div className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Fees no reclamadas</span>
                <span className={styles.kpiValue}>{formatUsd(pool.unclaimedFeesUsd)}</span>
              </div>
              <div className={styles.kpiCard}>
                <span className={styles.kpiLabel}>P&L total</span>
                <span className={`${styles.kpiValue} ${pnlClass}`}>{formatSignedUsd(pool.pnlTotalUsd)}</span>
              </div>
              <div className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Rendimiento</span>
                <span className={`${styles.kpiValue} ${pnlClass}`}>{formatPercent(pool.yieldPct)}</span>
              </div>
              <div className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Distancia al rango</span>
                <span className={styles.kpiValue}>
                  {pool.distanceToRangePct === 0
                    ? 'Dentro de rango'
                    : pool.distanceToRangePct != null
                      ? `${formatNumber(pool.distanceToRangePrice, 4)} · ${formatPercent(pool.distanceToRangePct)}`
                      : 'No disponible'}
                </span>
              </div>
            </div>

            <div className={styles.positionBreakdown}>
              <span className={styles.positionMetric}>
                Ahora: {formatNumber(pool.positionAmount0, 6)} {pool.token0.symbol} · {formatNumber(pool.positionAmount1, 6)} {pool.token1.symbol}
              </span>
              <span className={styles.positionMetric}>
                Fees: {formatNumber(pool.unclaimedFees0, 6)} {pool.token0.symbol} · {formatNumber(pool.unclaimedFees1, 6)} {pool.token1.symbol}
              </span>
            </div>

            {pool.valuationAccuracy && pool.valuationAccuracy !== 'exact' && (
              <div className={styles.noteRow}>
                <span className={styles.noteBadge}>
                  {pool.valuationAccuracy === 'approximate' ? 'Aprox.' : 'Parcial'}
                </span>
                <span className={styles.noteText}>
                  {pool.valuationAccuracy === 'approximate'
                    ? 'La valuacion usa historial o precios aproximados.'
                    : 'Parte del P&L no pudo valorarse con precision.'}
                </span>
              </div>
            )}

            {pool.valuationWarnings?.length > 0 && (
              <div className={styles.noteList}>
                {pool.valuationWarnings.map((warning) => (
                  <span key={warning} className={styles.noteListItem}>{warning}</span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Reservas</span>
          <span className={styles.infoValue}>
            {pool.reserve0 != null || pool.reserve1 != null
              ? `${formatNumber(pool.reserve0, 4)} ${pool.token0.symbol} · ${formatNumber(pool.reserve1, 4)} ${pool.token1.symbol}`
              : 'No disponible'}
          </span>
        </div>

        {isLpPosition ? (
          <>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>Precio al abrir</span>
              <span className={styles.infoValue}>
                {formatPrice(pool.priceAtOpen, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
                {openPriceLabel ? ` · ${openPriceLabel}` : ''}
              </span>
            </div>

            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>Precio actual</span>
              <span className={styles.infoValue}>
                {formatPrice(pool.priceCurrent ?? pool.priceApprox, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
              </span>
            </div>
          </>
        ) : (
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Precio aprox.</span>
            <span className={styles.infoValue}>
              {formatPrice(pool.priceApprox, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
            </span>
          </div>
        )}

        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>TVL aprox.</span>
          <span className={styles.infoValue}>
            {pool.tvlApproxUsd != null ? formatCompactUsd(pool.tvlApproxUsd) : 'No disponible'}
          </span>
        </div>

        {isV4 && (
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Hooks</span>
            <span className={styles.hashValue}>{shortAddress(pool.hooks)}</span>
          </div>
        )}

        {isLpPosition && rangeBar && (
          <div className={`${styles.infoItem} ${styles.infoItemWide}`}>
            <span className={styles.infoLabel}>
              Rango de precio
              {pool.currentOutOfRangeSide && (
                <span className={styles.rangeAlertInline}>
                  {pool.currentOutOfRangeSide === 'below' ? 'Fuera por abajo' : 'Fuera por arriba'}
                </span>
              )}
            </span>
            <div className={styles.rangeCard}>
              {/* Labels above the track */}
              <div className={styles.rangeLabelsRow}>
                {rangeBar.openPct != null && (
                  <div className={styles.rangeLabelPin} style={{ left: `${rangeBar.openPct}%` }}>
                    <span className={styles.rangeLabelValue}>{formatCompactPrice(rangeBar.openPrice)}</span>
                    <span className={styles.rangeLabelTag}>Entrada</span>
                  </div>
                )}
                {rangeBar.currentPct != null && (
                  <div className={`${styles.rangeLabelPin} ${styles.rangeLabelPinCurrent}`} style={{ left: `${rangeBar.currentPct}%` }}>
                    <span className={styles.rangeLabelValue}>{formatCompactPrice(rangeBar.currentPrice)}</span>
                    <span className={styles.rangeLabelTag}>Actual</span>
                  </div>
                )}
              </div>

              {/* Track with range zone + markers */}
              <div className={styles.rangeTrack}>
                {/* Shaded active range zone */}
                <div
                  className={styles.rangeFill}
                  style={{
                    left: `${rangeBar.rangeLowPct}%`,
                    width: `${rangeBar.rangeHighPct - rangeBar.rangeLowPct}%`,
                  }}
                />
                {/* Min/Max edges */}
                <div className={styles.rangeEdge} style={{ left: `${rangeBar.rangeLowPct}%` }} />
                <div className={styles.rangeEdge} style={{ left: `${rangeBar.rangeHighPct}%` }} />
                {/* Open marker */}
                {rangeBar.openPct != null && (
                  <div
                    className={`${styles.rangeMarker} ${styles.rangeMarkerOpen}`}
                    style={{ left: `${rangeBar.openPct}%` }}
                  />
                )}
                {/* Current price marker */}
                {rangeBar.currentPct != null && (
                  <div
                    className={`${styles.rangeMarker} ${styles.rangeMarkerCurrent} ${pool.currentOutOfRangeSide ? styles.rangeMarkerCurrentAlert : ''}`}
                    style={{ left: `${rangeBar.currentPct}%` }}
                  />
                )}
              </div>

              {/* Min/Max labels below */}
              <div className={styles.rangeEdgeLabels}>
                <span className={styles.rangeEdgeValue}>{formatCompactPrice(rangeBar.lowerPrice)}</span>
                <span className={styles.rangeEdgeCaption}>Rango activo ({pool.priceQuoteSymbol}/{pool.priceBaseSymbol})</span>
                <span className={styles.rangeEdgeValue}>{formatCompactPrice(rangeBar.upperPrice)}</span>
              </div>

              {/* Legend */}
              <div className={styles.rangeLegend}>
                <span className={styles.rangeLegendItem}>
                  <span className={`${styles.rangeLegendDot} ${styles.rangeLegendDotOpen}`} />
                  Entrada
                </span>
                <span className={styles.rangeLegendItem}>
                  <span className={`${styles.rangeLegendDot} ${styles.rangeLegendDotCurrent}`} />
                  Precio actual
                </span>
                <span className={styles.rangeLegendItem}>
                  <span className={styles.rangeLegendDotRange} />
                  Rango activo
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function ScanSpinner() {
  return (
    <div className={styles.spinnerWrap}>
      <div className={styles.spinner} />
      <span className={styles.spinnerText}>Escaneando blockchain...</span>
      <span className={styles.spinnerHint}>Esto puede tomar unos segundos dependiendo de la red</span>
    </div>
  );
}

export default function UniswapPoolsPage() {
  const [meta, setMeta] = useState(null);
  const [wallet, setWallet] = useState('');
  const [network, setNetwork] = useState('ethereum');
  const [version, setVersion] = useState('v3');
  const [result, setResult] = useState(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [error, setError] = useState('');
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    async function loadInitial() {
      try {
        const [metaData, walletData, etherscanData] = await Promise.all([
          uniswapApi.getMeta(),
          settingsApi.getWallet().catch(() => null),
          settingsApi.getEtherscan().catch(() => ({ hasApiKey: false })),
        ]);
        setMeta(metaData);
        setHasApiKey(etherscanData?.hasApiKey || false);
        if (walletData?.address) {
          setWallet(walletData.address);
        }
      } catch (err) {
        setError(err.message);
      }
    }

    loadInitial();
  }, []);

  const selectedNetwork = useMemo(
    () => meta?.networks?.find((item) => item.id === network) || null,
    [meta, network]
  );
  const availableVersions = selectedNetwork?.versions || ['v3'];
  const isLpModeSelection = version === 'v3' || version === 'v4';

  useEffect(() => {
    if (!availableVersions.includes(version)) {
      setVersion(availableVersions[0]);
    }
  }, [availableVersions, version]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsScanning(true);
    setError('');
    try {
      const data = await uniswapApi.scanPools({ wallet, network, version });
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Uniswap Pool Scanner</p>
          <h1 className={styles.title}>Pools y posiciones LP</h1>
          <p className={styles.subtitle}>
            V3/V4 lee posiciones LP reales de la wallet. V1/V2 escanea pools creados.
          </p>
        </div>
        <div className={styles.heroStat}>
          <span className={styles.heroStatLabel}>Redes soportadas</span>
          <span className={styles.heroStatValue}>ETH, ARB, OP, BASE, POL</span>
        </div>
      </section>

      <section className={styles.panel}>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="uni-wallet">Wallet</label>
            <input
              id="uni-wallet"
              className={styles.input}
              type="text"
              placeholder="0x..."
              value={wallet}
              onChange={(event) => setWallet(event.target.value)}
              required
              aria-label="Direccion de wallet"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="uni-network">Red</label>
            <select
              id="uni-network"
              className={styles.select}
              value={network}
              onChange={(event) => setNetwork(event.target.value)}
            >
              {(meta?.networks || []).map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="uni-version">Version</label>
            <select
              id="uni-version"
              className={styles.select}
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            >
              {availableVersions.map((item) => (
                <option key={item} value={item}>{item.toUpperCase()}</option>
              ))}
            </select>
          </div>

          <button className={styles.scanButton} type="submit" disabled={isScanning || !meta || !hasApiKey}>
            {isScanning ? 'Escaneando...' : 'Escanear'}
          </button>
        </form>

        {selectedNetwork && (
          <div className={styles.supportBar}>
            <span className={styles.supportLabel}>Soporta:</span>
            {selectedNetwork.versions.map((item) => (
              <span key={item} className={styles.supportBadge}>{item.toUpperCase()}</span>
            ))}
          </div>
        )}

        {!hasApiKey && (
          <div className={styles.warning}>
            Configura tu API key de Etherscan en Config antes de usar el scanner.
          </div>
        )}
      </section>

      {error && (
        <div className={styles.error}>
          <span>{error}</span>
          <button className={styles.dismissBtn} onClick={() => setError('')} aria-label="Cerrar error">x</button>
        </div>
      )}

      {isScanning && <ScanSpinner />}

      {result?.warnings?.length > 0 && (
        <div className={styles.warning}>
          {result.warnings.join(' · ')}
        </div>
      )}

      {result && (
        <>
          <section className={styles.summary}>
            <div className={styles.summaryCard}>
              <span className={styles.summaryLabel}>Wallet</span>
              <span className={styles.summaryValue}>{shortAddress(result.wallet)}</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryLabel}>Red / version</span>
              <span className={styles.summaryValue}>
                {result.network.label} · {result.version.toUpperCase()}
              </span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryLabel}>
                {result.mode === 'lp_positions' ? 'Posiciones activas' : 'Pools encontrados'}
              </span>
              <span className={`${styles.summaryValue} ${styles.summaryHighlight}`}>{result.count}</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryLabel}>
                {result.mode === 'lp_positions' ? 'Inspeccionadas' : 'Inspeccion'}
              </span>
              <span className={styles.summaryValue}>
                {result.inspectedTxCount}/{result.totalTxCount} {result.mode === 'lp_positions' ? 'pos.' : 'tx'} · {result.completeness}
              </span>
            </div>
          </section>

          {result.count === 0 ? (
            <div className={styles.empty}>
              <span className={styles.emptyIcon}>O</span>
              <span>
                {isLpModeSelection
                  ? 'No se encontraron posiciones LP activas para esa wallet.'
                  : 'No se encontraron pools creados con liquidez relevante.'}
              </span>
              <span className={styles.emptyHint}>Prueba con otra red o version de Uniswap</span>
            </div>
          ) : (
            <>
              <div className={styles.resultsHeader}>
                <span className={styles.resultsCount}>
                  {result.count} {result.mode === 'lp_positions' ? 'posiciones' : 'pools'}
                </span>
              </div>
              <section className={styles.results}>
                {result.pools.map((pool) => (
                  <PoolCard key={pool.id} pool={pool} />
                ))}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
