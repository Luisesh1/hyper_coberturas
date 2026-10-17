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
            <h2>Resultado: {report.status === 'risk_detected' ? 'Riesgo de residuo' :
              report.status === 'filter_only' ? 'Filtro compatible, ejecución no comprobada' :
                'Verificación bloqueada'}</h2>
            <span>{checkedAt}</span>
          </div>
          <div className={styles.checks}>
            {CHECKS.map(([key, label]) => (
              <div key={key}><span>{label}</span><Indicator value={report[key]} /></div>
            ))}
            <div>
              <span>Nueva orden SELL de 0.005 contratos válida</span>
              <Indicator value={report.residualNewOrderValid} />
            </div>
            <div>
              <span>Cierre parcial REAL con Binance</span>
              <strong className={styles.pending}>Sin verificar</strong>
            </div>
          </div>
          <p className={styles.note}>
            Un TP GTC de 0.01 con fill de 0.005 deja 0.005 pendientes. Este test determina
            únicamente si se aceptaría una NUEVA orden con esa cantidad, no si Binance
            ejecutará o permitirá liquidar el saldo del TP residente.
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
