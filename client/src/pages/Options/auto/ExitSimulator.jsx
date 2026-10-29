import { useEffect, useId, useMemo, useState } from 'react';
import { autoBotsApi } from '../autoTradingApi';
import { ChevronRightIcon } from '../strategies/common/icons';
import {
  SMALL_SAMPLE, SMALL_SAMPLE_TEXT, STOP_OPTIONS, actualText, bestRows, buildGrid, coverageText,
  defaultStop, holdText, nearestCell, tpText,
} from './exitSimulator';
import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';
import x from './ExitSimulator.module.css';

const toneClass = (p) => (p > 0 ? ui.tone_pos : p < 0 ? ui.tone_neg : ui.tone_muted);

function BestTable({ rows, mobile }) {
  if (!rows.length) return <p className={ui.empty}>Sin combinaciones para mostrar.</p>;
  if (mobile) {
    return (
      <ul className={x.bestCards} aria-label="Mejores combinaciones">
        {rows.map((r) => (
          <li key={r.key} className={x.bestCard}>
            <div className={x.bestCardHead}>
              <strong>TP {r.tp} · {r.hold} · stop {r.stop}</strong>
              <span className={`${ui.mono} ${toneClass(r.pnlValue)}`}>{r.pnl}</span>
            </div>
            <span className={`${ui.muted} ${ui.small}`}>Acierto {r.hits} · media {r.avgHold}{r.incomplete ? ' · con datos incompletos' : ''}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table} aria-label="Mejores combinaciones">
        <thead>
          <tr><th>TP</th><th>Tiempo máx.</th><th>Stop</th><th>P&amp;L</th><th>Acierto</th><th>Tiempo medio</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.tp}</td><td>{r.hold}</td><td>{r.stop}</td>
              <td className={`${ui.mono} ${toneClass(r.pnlValue)}`}>{r.pnl}</td>
              <td>{r.hits}</td><td>{r.avgHold}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeatMap({ grid, mark }) {
  return (
    <div className={x.mapWrap} tabIndex={0} role="region" aria-label="Mapa de P&L por TP y tiempo máximo">
      <table className={x.map}>
        <thead>
          <tr><th scope="col">TP \ Tiempo</th>{grid.holds.map((h) => <th key={String(h)} scope="col">{holdText(h)}</th>)}</tr>
        </thead>
        <tbody>
          {grid.rows.map((r) => (
            <tr key={String(r.tp)}>
              <th scope="row">{tpText(r.tp)}</th>
              {r.cells.map((c) => {
                const isMark = mark && mark.tp === r.tp && mark.hold === c.hold;
                const bg = c.sign === 'zero' ? undefined : `rgba(${c.sign === 'pos' ? '34, 197, 94' : '239, 68, 68'}, ${(0.12 + 0.5 * c.intensity).toFixed(2)})`;
                return (
                  <td
                    key={String(c.hold)}
                    className={`${x.cell} ${isMark ? x.cellMark : ''}`}
                    style={bg ? { background: bg } : undefined}
                    title={c.title}
                    data-sign={c.sign}
                    data-current={isMark ? 'true' : undefined}
                    aria-label={isMark ? `${c.title} (configuración actual)` : undefined}
                  >
                    {c.text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// «Simulador de salidas»: qué habría pasado con otros TP, tiempos máximos y
// stops sobre las posiciones cerradas. Se carga al abrirla, no con cada
// refresco del detalle.
export default function ExitSimulator({ bot, mobile = false, since }) {
  const mode = bot.mode === 'live' ? 'live' : 'shadow';
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [attempt, setAttempt] = useState(0);
  const [stop, setStop] = useState(() => defaultStop(bot.params));
  const bodyId = useId();

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(() => autoBotsApi.exitSimulation(bot.id, { mode, since }))
      .then((data) => { if (!cancelled) setState({ loading: false, error: null, data }); })
      .catch((error) => { if (!cancelled) setState({ loading: false, error, data: null }); });
    return () => { cancelled = true; };
  }, [open, bot.id, mode, since, attempt]);

  const { data, loading, error } = state;
  const grid = useMemo(() => (data ? buildGrid(data.scenarios, stop) : null), [data, stop]);
  const mark = useMemo(() => (grid ? nearestCell(bot.params, grid) : null), [grid, bot.params]);
  const rows = useMemo(() => bestRows(data), [data]);
  const trades = data?.actual?.trades ?? data?.coverage?.positions ?? 0;

  return (
    <section className={mobile ? styles.mobileSection : `${ui.panel} ${styles.activityPanel}`} aria-label="Simulador de salidas">
      <button type="button" className={x.toggle} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}><ChevronRightIcon size={16} /></span>
        <span className={mobile ? styles.mobileH2 : ui.h3}>Simulador de salidas</span>
      </button>
      {open && (
        <div id={bodyId} className={x.body}>
          <p className={`${ui.muted} ${ui.small} ${x.intro}`}>Qué habría pasado con otros objetivos, tiempos máximos y stops sobre tus operaciones compradas ya cerradas.</p>
          {loading && <p className={ui.muted} role="status">Calculando escenarios…</p>}
          {error && (
            <p className={`${ui.alert} ${ui.alertError}`} role="alert">
              <span>No se pudo calcular el simulador: {error.message || 'error desconocido'}</span>
              <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => setAttempt((n) => n + 1)}>Reintentar</button>
            </p>
          )}
          {data && !loading && (
            <>
              <div className={x.head}>
                <span className={ui.small}>{coverageText(data.coverage)}</span>
                <strong className={ui.mono}>{actualText(data.actual)}</strong>
              </div>
              {trades < SMALL_SAMPLE && <p className={`${ui.alert} ${ui.alertWarn}`} role="note">{SMALL_SAMPLE_TEXT}</p>}
              <h4 className={x.h4}>Mejores combinaciones</h4>
              <BestTable rows={rows} mobile={mobile} />
              <div className={x.mapHead}>
                <h4 className={x.h4}>Mapa TP × tiempo máximo</h4>
                <div className={x.stopSel} role="group" aria-label="Stop">
                  <span className={ui.small}>Stop:</span>
                  {STOP_OPTIONS.map((o) => (
                    <button
                      key={String(o.value)}
                      type="button"
                      className={`${x.stopBtn} ${stop === o.value ? x.stopBtnOn : ''}`}
                      aria-pressed={stop === o.value}
                      onClick={() => setStop(o.value)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <HeatMap grid={grid} mark={mark} />
              <p className={`${ui.muted} ${ui.small}`}>
                {mark ? 'El borde marca la celda más cercana a la configuración actual del bot.' : 'Con este tipo de objetivo no se marca una celda: el TP no es un porcentaje fijo.'}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
