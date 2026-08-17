import { formatSignedUsd, formatRelativeTimestamp } from '../utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
import styles from './ShadowPolicyCard.module.css';

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Suma de la pata de cobertura, con la convención del motor legacy:
 * realizado + latente + funding (con signo) − comisiones − slippage.
 */
function hedgeNet({ realized, unrealized, funding, fees, slippage }) {
  return num(realized) + num(unrealized) + num(funding) - num(fees) - num(slippage);
}

/**
 * Comparativa entre la cobertura que se está ejecutando de verdad y la que
 * habría hecho `net_profit_v1` corriendo en sombra.
 *
 * Solo compara la **pata de cobertura**: el P&L del LP es idéntico bajo
 * cualquiera de las dos políticas (es la misma posición de liquidez), así que
 * incluirlo sumaría el mismo número a los dos lados y solo serviría para
 * diluir la diferencia, que es justo lo que hay que leer aquí.
 */
export default function ShadowPolicyCard({ strategyState, onPromote }) {
  const shadow = strategyState?.shadowSnapshot;
  if (!shadow) return null;

  const real = {
    realized: strategyState?.hedgeRealizedPnlUsd,
    unrealized: strategyState?.hedgeUnrealizedPnlUsd,
    funding: strategyState?.fundingAccumUsd,
    fees: strategyState?.executionFeesUsd,
    slippage: strategyState?.slippageUsd,
  };
  const counterfactual = {
    realized: shadow.realizedPnlUsd,
    unrealized: shadow.unrealizedPnlUsd,
    funding: shadow.fundingUsd,
    fees: shadow.executionFeesUsd,
    slippage: shadow.slippageUsd,
  };

  const realNet = hedgeNet(real);
  const shadowNet = hedgeNet(counterfactual);
  const edge = shadowNet - realNet;
  const edgeTone = edge > 0 ? styles.pos : (edge < 0 ? styles.neg : '');

  const rows = [
    { label: 'P&L realizado', real: real.realized, shadow: counterfactual.realized },
    { label: 'Latente (mark-to-market)', real: real.unrealized, shadow: counterfactual.unrealized },
    { label: 'Funding', real: real.funding, shadow: counterfactual.funding },
    { label: 'Comisiones de ejecución', real: -num(real.fees), shadow: -num(counterfactual.fees) },
    { label: 'Slippage', real: -num(real.slippage), shadow: -num(counterfactual.slippage) },
  ];

  const snapshotAt = strategyState?.lastShadowSnapshotAt || shadow.lastSnapshotAt;

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <div>
          <p className={styles.title}>Net profit en sombra</p>
          <p className={styles.subtitle}>
            Comparativa de la pata de cobertura. El P&amp;L del LP queda fuera: es el mismo
            bajo las dos políticas.
          </p>
        </div>
        {snapshotAt && (
          <span className={styles.stamp}>
            snapshot {formatRelativeTimestamp(Number(snapshotAt))}
          </span>
        )}
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.rowLabel}> </th>
            <th scope="col">Real (zonas legacy)</th>
            <th scope="col">Sombra (net profit)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" className={styles.rowLabel}>{row.label}</th>
              <td>{formatSignedUsd(row.real)}</td>
              <td>{formatSignedUsd(row.shadow)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className={styles.rowLabel}>Neto de cobertura</th>
            <td><strong>{formatSignedUsd(realNet)}</strong></td>
            <td><strong>{formatSignedUsd(shadowNet)}</strong></td>
          </tr>
        </tfoot>
      </table>

      <div className={styles.edgeRow}>
        <span>Ventaja del contrafactual</span>
        <strong className={edgeTone}>{formatSignedUsd(edge)}</strong>
      </div>

      <div className={styles.footNotes}>
        <span>
          Short simulado: {formatNumber(num(shadow.actualQty), 6)}
          {shadow.averageEntryPrice ? ` @ ${formatNumber(shadow.averageEntryPrice, 2)}` : ''}
        </span>
        <span>Slippage EWMA {formatNumber(num(shadow.slippageEwmaBps), 1)} bps</span>
      </div>

      <p className={styles.caveat}>
        La sombra no manda órdenes: rellena contra el BBO del momento con una tarifa
        conservadora, así que es un límite optimista de lo que habría conseguido.
      </p>

      {onPromote && (
        <button type="button" className={styles.promoteBtn} onClick={onPromote}>
          Promover a operación real
        </button>
      )}
    </section>
  );
}
