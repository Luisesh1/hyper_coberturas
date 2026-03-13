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
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'No disponible';
  return `${formatNumber(numeric, numeric >= 100 ? 2 : 6)} ${quoteSymbol}/${baseSymbol}`;
}

function getExplorerLink(baseUrl, kind, value) {
  if (!baseUrl || !value) return null;
  if (kind === 'tx') return `${baseUrl}/tx/${value}`;
  if (kind === 'address') return `${baseUrl}/address/${value}`;
  return null;
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
  const normalize = (value) => {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  };

  return {
    openPct: normalize(open),
    currentPct: normalize(current),
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
        <div className={styles.blockBadge}>
          {pool.currentOutOfRangeSide === 'below'
            ? 'Fuera por abajo'
            : pool.currentOutOfRangeSide === 'above'
              ? 'Fuera por arriba'
              : pool.status === 'active'
                ? 'Activa'
                : 'Inactiva'}
        </div>
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
          <span className={styles.infoLabel}>{isLpPosition ? 'Posición' : isV4 ? 'Pool ID' : 'Identificador'}</span>
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
            {pool.tvlApproxUsd != null ? `$${formatNumber(pool.tvlApproxUsd, 2)}` : 'No disponible'}
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
            <span className={styles.infoLabel}>Rango</span>
            <div className={styles.rangeCard}>
              <div className={styles.rangeHeader}>
                <span className={styles.rangeMetric}>
                  Min. {formatPrice(pool.rangeLowerPrice, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
                </span>
                <span className={styles.rangeMetric}>
                  Máx. {formatPrice(pool.rangeUpperPrice, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
                </span>
              </div>

              <div className={styles.rangeTrack}>
                <div className={styles.rangeFill} />
                {rangeBar.openPct != null && (
                  <div
                    className={`${styles.rangeMarker} ${styles.rangeMarkerOpen}`}
                    style={{ left: `${rangeBar.openPct}%` }}
                    title="Precio al abrir"
                  />
                )}
                {rangeBar.currentPct != null && (
                  <div
                    className={`${styles.rangeMarker} ${styles.rangeMarkerCurrent} ${pool.currentOutOfRangeSide ? styles.rangeMarkerCurrentAlert : ''}`}
                    style={{ left: `${rangeBar.currentPct}%` }}
                    title="Precio actual"
                  />
                )}
              </div>

              <div className={styles.rangeLegend}>
                <span className={styles.rangeLegendItem}>
                  <span className={`${styles.rangeLegendDot} ${styles.rangeLegendDotOpen}`} />
                  Apertura
                </span>
                <span className={styles.rangeLegendItem}>
                  <span className={`${styles.rangeLegendDot} ${styles.rangeLegendDotCurrent}`} />
                  Precio actual
                </span>
                {pool.currentOutOfRangeSide && (
                  <span className={styles.rangeAlert}>
                    {pool.currentOutOfRangeSide === 'below' ? 'Fuera por abajo' : 'Fuera por arriba'}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </article>
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
          <h1 className={styles.title}>Pools y posiciones LP en Uniswap</h1>
          <p className={styles.subtitle}>
            Para V3 y V4 leemos las posiciones LP reales de la wallet. Para V1 y V2 mantenemos el escaneo de pools creados.
          </p>
        </div>
        <div className={styles.heroStat}>
          <span className={styles.heroStatLabel}>Cobertura</span>
          <span className={styles.heroStatValue}>ETH, ARB, OP, BASE, POL</span>
        </div>
      </section>

      <section className={styles.panel}>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label}>Wallet creadora</label>
            <input
              className={styles.input}
              type="text"
              placeholder="0x..."
              value={wallet}
              onChange={(event) => setWallet(event.target.value)}
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Red</label>
            <select
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
            <label className={styles.label}>Version</label>
            <select
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
            {isScanning ? 'Escaneando...' : 'Escanear pools'}
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
          <div className={styles.error}>
            Configura tu API key de Etherscan en Config antes de usar el scanner de Uniswap.
          </div>
        )}
      </section>

      {error && <div className={styles.error}>{error}</div>}

      {result?.warnings?.length > 0 && (
        <div className={styles.error}>
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
              <span className={styles.summaryValue}>{result.count}</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryLabel}>
                {result.mode === 'lp_positions' ? 'Posiciones inspeccionadas' : 'Inspeccion'}
              </span>
              <span className={styles.summaryValue}>
                {result.inspectedTxCount}/{result.totalTxCount} {result.mode === 'lp_positions' ? 'posiciones' : 'tx'} · {result.completeness}
              </span>
            </div>
          </section>

          {result.count === 0 ? (
            <div className={styles.empty}>
              {isLpModeSelection
                ? 'No se encontraron posiciones LP activas para esa wallet en la combinacion seleccionada.'
                : 'No se encontraron pools creados con liquidez relevante para esa wallet en la combinacion seleccionada.'}
            </div>
          ) : (
            <section className={styles.results}>
              {result.pools.map((pool) => (
                <PoolCard key={pool.id} pool={pool} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
