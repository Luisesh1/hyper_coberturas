import { useMemo } from 'react';
import Sparkline from './Sparkline';
import { LAYER_COLORS } from './WalletValueChart';
import { fmtPct, fmtSignedUsd, fmtUsd, fmtUsdCompact } from '../lib/format';
import styles from '../MetricasPage.module.css';

/**
 * Total de las wallets visibles y su cambio en el rango (suma de los cambios
 * de cada wallet). La curva es ese cambio acumulado hora a hora.
 */
export default function PortfolioStrip({ wallets, aggregate, range, loading }) {
  const totals = useMemo(() => wallets.reduce((acc, w) => {
    const t = w.latest?.totals;
    if (!t) return acc;
    acc.total += t.totalUsd;
    acc.tokens += t.tokensUsd;
    acc.lp += t.lpUsd;
    acc.hl += t.hlUsd;
    acc.counted += 1;
    return acc;
  }, { total: 0, tokens: 0, lp: 0, hl: 0, counted: 0 }), [wallets]);

  const change = aggregate.changeUsd;
  const tone = change == null ? '' : (change >= 0 ? styles.statDeltaPos : styles.statDeltaNeg);
  const curve = aggregate.curve.map((p) => p.value);

  return (
    <section className={styles.portfolio} aria-label="Resumen de las wallets">
      <div className={styles.portfolioStats}>
        <div className={styles.portfolioHero}>
          <span className={styles.statLabel}>
            Valor total · {wallets.length} wallet{wallets.length === 1 ? '' : 's'}
          </span>
          <div className={styles.portfolioHeroValue}>
            <span className={styles.portfolioAmount}>
              {totals.counted ? fmtUsd(totals.total) : '—'}
            </span>
          </div>
          <span className={`${styles.portfolioChange} ${tone}`}>
            {change == null
              ? (loading ? 'Cargando serie…' : `Sin puntos en ${range?.label || 'el rango'}`)
              : `${fmtSignedUsd(change)}${aggregate.changePct != null ? ` (${fmtPct(aggregate.changePct)})` : ''} en ${range?.label || 'el rango'}`}
          </span>
        </div>

        <div className={styles.portfolioBreakdown}>
          {[
            { label: 'Tokens', value: totals.tokens, color: LAYER_COLORS.tokens },
            { label: 'LPs', value: totals.lp, color: LAYER_COLORS.lp },
            { label: 'Hyperliquid', value: totals.hl, color: LAYER_COLORS.hl },
          ].map((s) => (
            <div key={s.label} className={styles.portfolioStat}>
              <span className={styles.statLabel}>
                <span className={styles.legendSwatch} style={{ background: s.color }} />
                {s.label}
              </span>
              <span className={styles.statValue}>{totals.counted ? fmtUsdCompact(s.value) : '—'}</span>
            </div>
          ))}
        </div>
      </div>

      {curve.length >= 2 ? (
        <div className={styles.portfolioCurve}>
          <Sparkline
            values={curve}
            width={600}
            height={44}
            stretch
            stroke={change != null && change < 0 ? '#ef4444' : '#22c55e'}
            fillId="portfolio-curve"
            ariaLabel={`Cambio acumulado en ${range?.label || 'el rango'}`}
          />
        </div>
      ) : null}
    </section>
  );
}
