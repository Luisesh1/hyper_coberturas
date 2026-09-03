import { useMemo } from 'react';
import Sparkline from './Sparkline';
import { fmtPct, fmtSignedUsd, fmtUsdCompact } from '../lib/format';
import { buildAggregateSeries } from '../lib/portfolio';
import styles from '../MetricasPage.module.css';

// Umbrales de margen. Por debajo de 10% la cobertura esta a un movimiento de
// quedarse sin colateral; entre 10 y 20 conviene mirarla.
const LIQ_DANGER_PCT = 10;
const LIQ_WARN_PCT = 20;

function liqTone(pct) {
  if (pct == null) return '';
  if (pct < LIQ_DANGER_PCT) return styles.toneDanger;
  if (pct < LIQ_WARN_PCT) return styles.toneWarn;
  return '';
}

export default function PortfolioStrip({ rows, portfolio, range, loading }) {
  const curve = useMemo(() => buildAggregateSeries(rows), [rows]);
  const curveValues = useMemo(() => curve.map((p) => p.value), [curve]);

  const pnl = portfolio.lifetimePnlUsd;
  const pnlTone = pnl == null ? '' : (pnl >= 0 ? styles.statDeltaPos : styles.statDeltaNeg);
  const worst = portfolio.worstLiq;
  const partialCapital = portfolio.capitalFrom > 0 && portfolio.capitalFrom < portfolio.orchestrators;

  return (
    <section className={styles.portfolio} aria-label="Resumen del portafolio">
      <div className={styles.portfolioStats}>
        <div className={styles.portfolioHero}>
          <span className={styles.statLabel}>
            P&amp;L neto · {portfolio.orchestrators} orquestador{portfolio.orchestrators === 1 ? '' : 'es'}
          </span>
          <div className={styles.portfolioHeroValue}>
            <span className={`${styles.portfolioAmount} ${pnlTone}`}>
              {pnl == null ? '—' : fmtSignedUsd(pnl)}
            </span>
            {portfolio.lifetimePnlPct != null && (
              <span className={`${styles.portfolioAmountPct} ${pnlTone}`}>
                {fmtPct(portfolio.lifetimePnlPct)}
              </span>
            )}
          </div>
          <span className={styles.portfolioNote}>
            {portfolio.rangePnlUsd != null
              ? `En ${range?.label || 'el rango'}: ${fmtSignedUsd(portfolio.rangePnlUsd)} · acumulado de la contabilidad real, no del valor de mercado`
              : 'Acumulado de la contabilidad real, no del valor de mercado'}
          </span>
        </div>

        <div className={styles.portfolioStat}>
          <span className={styles.statLabel}>Capital</span>
          <span className={styles.statValue}>{fmtUsdCompact(portfolio.capitalUsd)}</span>
          <span className={styles.portfolioNote}>
            {partialCapital
              ? `valor de mercado · ${portfolio.capitalFrom} de ${portfolio.orchestrators}`
              : 'valor de mercado'}
          </span>
        </div>

        <div className={styles.portfolioStat}>
          <span className={styles.statLabel}>Funding / día</span>
          <span
            className={`${styles.statValue} ${portfolio.fundingPerDayUsd == null ? '' : (portfolio.fundingPerDayUsd >= 0 ? styles.statDeltaPos : styles.statDeltaNeg)}`}
          >
            {portfolio.fundingPerDayUsd == null ? '—' : fmtSignedUsd(portfolio.fundingPerDayUsd)}
          </span>
          <span className={styles.portfolioNote}>
            {portfolio.fundingFrom
              ? `${portfolio.fundingEarning} cobran · ${portfolio.fundingPaying} pagan`
              : 'sin coberturas activas'}
          </span>
        </div>

        <div className={`${styles.portfolioStat} ${liqTone(worst?.distanceToLiqPct)}`}>
          <span className={styles.statLabel}>Peor a liquidación</span>
          <span className={styles.statValue}>
            {worst ? `${worst.distanceToLiqPct.toFixed(1)}%` : '—'}
          </span>
          <span className={styles.portfolioNote}>
            {worst
              ? `${worst.orchestrator.name} · ${worst.orchestrator.token0Symbol}/${worst.orchestrator.token1Symbol}`
              : 'sin posiciones apalancadas'}
          </span>
        </div>
      </div>

      {curveValues.length > 1 ? (
        <div className={styles.portfolioCurve}>
          <Sparkline
            values={curveValues}
            width={820}
            height={84}
            stroke="var(--uni-cyan, #66e1db)"
            strokeWidth={2}
            fillId="portfolioCurveFill"
            stretch
            ariaLabel={`Valor agregado del portafolio en ${range?.label || 'el rango'}`}
          />
        </div>
      ) : (
        <div className={styles.portfolioCurveEmpty}>
          {loading ? 'Cargando la serie del portafolio…' : 'Aún no hay serie agregada para este rango.'}
        </div>
      )}
    </section>
  );
}
