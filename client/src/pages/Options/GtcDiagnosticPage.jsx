import { useState } from 'react';
import { request } from '../../services/api';
import styles from './GtcDiagnosticPage.module.css';

const DEFAULT_SYMBOL = 'ETH-261023-2500-C';
const CHECKS = [
  ['flagsOff', 'Trading real apagado'],
  ['accountIsolated', 'Cuenta Binance aislada'],
  ['permissionsSafe', 'API restringida y sin retiros'],
  ['filtersChecked', 'Filtros actuales consultados'],
  ['initialOrderValid', '0.01 cumple filtro de entrada'],
];
const SYMBOL_PATTERN = /^ETH-\d{6}-\d+(?:\.\d+)?-C$/;
const SAMPLE_LABELS = {
  out_of_lot_observed: 'Se observaron ejecuciones fuera del lote',
  lot_aligned_observed: 'Todas las observadas respetan el lote (no es garantia)',
  no_trades: 'No hubo trades recientes en la muestra',
  unavailable: 'No se pudo consultar la muestra',
};

function Indicator({ value }) {
  const status = value === null || value === undefined ? 'No verificable' :
    value ? 'Correcto' : 'Bloqueado';
  return <strong className={value ? styles.ok : styles.fail}>{status}</strong>;
}

export default function GtcDiagnosticPage() {
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState('');

  async function runDiagnostic(event) {
    event.preventDefault();
    setError('');
    setReport(null);
    if (!SYMBOL_PATTERN.test(symbol)) {
      setError('Ingresa un contrato ETH CALL con formato ETH-YYMMDD-STRIKE-C.');
      return;
    }
    setLoading(true);
    try {
      const data = await request('GET', '/options/pilot/gtc-diagnostic?symbol=' +
        encodeURIComponent(symbol), undefined, { timeoutMs: 60000 });
      if (data?.readOnly !== true || data?.pilotReady !== false) {
        throw new Error('El diagnóstico devolvió un formato no seguro.');
      }
      setReport(data);
      setCheckedAt(new Date().toLocaleString('es-MX'));
    } catch (err) {
      setError(err?.message || 'No fue posible consultar Binance.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={styles.page}>
      <span className={styles.eyebrow}>RUTA OCULTA · SOLO SUPERUSUARIO · SOLO LECTURA</span>
      <h1>Diagnóstico Binance Options GTC</h1>
      <p className={styles.lead}>
        Comprueba los filtros de Binance y el riesgo de un Take Profit parcialmente ejecutado.
        No abre posiciones, no cancela órdenes, no modifica la configuración y no autoriza el piloto.
      </p>
      <section className={styles.panel}>
        <form onSubmit={runDiagnostic}>
          <label htmlFor="gtc-symbol">Contrato ETH CALL</label>
          <div className={styles.row}>
            <input id="gtc-symbol" value={symbol} onChange={event => setSymbol(event.target.value.trim().toUpperCase())}
              spellCheck={false} autoComplete="off" aria-label="Símbolo ETH CALL" />
            <button type="submit" disabled={loading}>
              {loading ? 'Consultando Binance…' : 'Verificar sin operar'}
            </button>
          </div>
        </form>
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </section>
      {report && (
        <section className={styles.panel} aria-live="polite">
          <div className={styles.heading}>
            <h2>Resultado: {report.status === 'risk_detected' ? 'Ejecuciones fuera del lote detectadas' :
              report.status === 'filter_only' ? 'Filtros comprobados, fills parciales sin demostrar' :
                'Verificación bloqueada'}</h2>
            <span>{checkedAt}</span>
          </div>
          <div className={styles.checks}>
            {CHECKS.map(([key, label]) => (
              <div key={key}><span>{label}</span><Indicator value={report[key]} /></div>
            ))}
            <div>
              <span>Nueva orden SELL de 0.005 (solo filtro de órdenes)</span>
              <strong>{report.residualNewOrderValid === null ? 'No verificable' :
                report.residualNewOrderValid ? 'Permitida' : 'No permitida'}</strong>
            </div>
            <div>
              <span>Muestra de ejecuciones publicas del contrato</span>
              <strong className={report.tradeEvidenceStatus === 'out_of_lot_observed' ?
                styles.fail : styles.pending}>
                {SAMPLE_LABELS[report.tradeEvidenceStatus] || 'Sin verificar'}
              </strong>
            </div>
            <div>
              <span>Ejecuciones examinadas / fuera del lote</span>
              <strong>{report.observedTrades ?? 0} / {report.observedOutOfLotTrades ?? 0}</strong>
            </div>
            <div>
              <span>Cierre parcial REAL con Binance</span>
              <strong className={styles.pending}>Sin verificar</strong>
            </div>
          </div>
          <p className={styles.note}>
            LOT_SIZE regula nuevas ordenes. Un fill hipotetico de 0.005 no demuestra
            que Binance lo permita: consultamos hasta 100 ejecuciones publicas, pero
            incluso una muestra sin fracciones NO garantiza que nunca puedan ocurrir.
            El cierre parcial de nuestro TP GTC y la liquidacion de residuos siguen sin
            verificarse con una operacion real.
          </p>
          <p className={styles.noGo}>NO-GO: el piloto de trading real permanece desactivado.</p>
        </section>
      )}
      {!report && <p className={styles.note}>
        Esta pantalla no está en el menú. Solo hace consultas GET autenticadas a Binance;
        una cuenta expuesta, filtros desconocidos o flags live activos detienen el diagnóstico.
        Una verificación favorable no equivale a una prueba operativa completa.
      </p>}
    </main>
  );
}
