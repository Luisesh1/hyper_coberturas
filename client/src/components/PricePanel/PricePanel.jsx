/**
 * PricePanel.jsx
 *
 * Muestra precios en tiempo real de pares de futuros de Hyperliquid.
 * Los precios llegan via WebSocket desde el backend.
 */

import { useState, useEffect, useRef } from 'react';
import { useTradingContext } from '../../context/TradingContext';
import { marketApi } from '../../services/api';
import styles from './PricePanel.module.css';

const FEATURED_ASSETS = ['BTC', 'ETH', 'SOL', 'ARB', 'OP', 'AVAX', 'MATIC', 'DOGE'];

export function PricePanel({ onSelectAsset, selectedAsset }) {
  const { prices, isConnected } = useTradingContext();
  const [contexts, setContexts] = useState([]);
  const [search, setSearch] = useState('');
  const [prevPrices, setPrevPrices] = useState({});
  const [flashMap, setFlashMap] = useState({});
  const flashTimers = useRef({});

  useEffect(() => {
    marketApi.getContexts().then(setContexts).catch(console.error);
  }, []);

  // Detect price changes and flash
  useEffect(() => {
    const newFlashes = {};
    Object.keys(prices).forEach((asset) => {
      const prev = prevPrices[asset];
      const curr = prices[asset];
      if (prev && curr && prev !== curr) {
        const direction = parseFloat(curr) > parseFloat(prev) ? 'up' : 'down';
        newFlashes[asset] = direction;
      }
    });

    if (Object.keys(newFlashes).length > 0) {
      setFlashMap((prev) => ({ ...prev, ...newFlashes }));

      // Clear flashes after animation
      Object.keys(newFlashes).forEach((asset) => {
        if (flashTimers.current[asset]) clearTimeout(flashTimers.current[asset]);
        flashTimers.current[asset] = setTimeout(() => {
          setFlashMap((prev) => {
            const next = { ...prev };
            delete next[asset];
            return next;
          });
        }, 600);
      });
    }

    setPrevPrices(prices);
  }, [prices]);

  const contextMap = contexts.reduce((acc, ctx) => {
    acc[ctx.name] = ctx;
    return acc;
  }, {});

  const displayAssets = search
    ? Object.keys(prices).filter((a) => a.toLowerCase().includes(search.toLowerCase()))
    : FEATURED_ASSETS.filter((a) => prices[a]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Precios en Vivo</h2>
        <span className={`${styles.status} ${isConnected ? styles.connected : styles.disconnected}`}>
          {isConnected ? 'En vivo' : 'Desconectado'}
        </span>
      </div>

      <input
        className={styles.search}
        type="text"
        placeholder="Buscar activo (BTC, ETH...)"
        value={search}
        onChange={(e) => setSearch(e.target.value.toUpperCase())}
        aria-label="Buscar activo"
      />

      <div className={styles.list}>
        {displayAssets.length === 0 && (
          <p className={styles.empty}>
            {search ? 'No se encontraron activos' : 'Cargando precios...'}
          </p>
        )}
        {displayAssets.map((asset) => {
          const price = prices[asset];
          const ctx = contextMap[asset];
          const change = ctx?.priceChange24h;
          const isPositive = parseFloat(change) >= 0;
          const isSelected = asset === selectedAsset;
          const flash = flashMap[asset];

          return (
            <button
              key={asset}
              className={`${styles.row} ${isSelected ? styles.selected : ''} ${flash === 'up' ? styles.flashUp : ''} ${flash === 'down' ? styles.flashDown : ''}`}
              onClick={() => onSelectAsset?.(asset)}
            >
              <div className={styles.assetInfo}>
                <span className={styles.assetName}>{asset}</span>
                {ctx?.fundingRate && (
                  <span className={styles.funding}>
                    FR: {(parseFloat(ctx.fundingRate) * 100).toFixed(4)}%
                  </span>
                )}
              </div>

              <div className={styles.priceInfo}>
                <span className={styles.price}>
                  ${price ? parseFloat(price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--'}
                </span>
                {change !== null && change !== undefined && (
                  <span className={`${styles.change} ${isPositive ? styles.positive : styles.negative}`}>
                    {isPositive ? '+' : ''}{change}%
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
