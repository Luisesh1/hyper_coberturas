import { useEffect, useId, useMemo, useState } from 'react';
import { autoBotsApi } from '../autoTradingApi';
import { ChevronRightIcon } from '../strategies/common/icons';
import {
  SMALL_SAMPLE, SMALL_SAMPLE_TEXT, STOP_OPTIONS, actualModel, bestRows, buildGrid, coverageText,
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
            <span className={`${ui.muted} ${ui.small}`}>Acierto {r.hits} · media {r.avgHold} · vs real <span className={toneClass(r.vsValue)}>{r.vs}</span>{r.incomplete ? ' · con datos incompletos' : ''}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table} aria-label="Mejores combinaciones">
        <thead>
          <tr><th>TP</th><th>Tiempo máx.</th><th>Stop</th><th>P&amp;L</th><th>Acierto</th><th>Tiempo medio</th><th>vs real</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.tp}</td><td>{r.hold}</td><td>{r.stop}</td>
              <td className={`${ui.mono} ${toneClass(r.pnlValue)}`}>{r.pnl}</td>
              <td>{r.hits}</td><td>{r.avgHold}</td>
              <td className={`${ui.mono} ${toneClass(r.vsValue)}`}>{r.vs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeatMap({ grid, mark, selected, onSelect }) {
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
                const bg = c.sign === 'zero' ? undefined : `color-mix(in srgb, var(${c.sign === 'pos' ? '--green' : '--red'}) ${Math.round(12 + 50 * c.intensity)}%, transparent)`;
                const isSel = selected && selected.tp === r.tp && selected.hold === c.hold;
                return (
                  <td
                    key={String(c.hold)}
                    className={`${x.cell} ${isMark ? x.cellMark : ''} ${isSel ? x.cellSel : ''}`}
                    style={bg ? { background: bg } : undefined}
                    title={c.title}
                    data-sign={c.sign}
                    data-current={isMark ? 'true' : undefined}
                  >
                    <button type="button" className={x.cellBtn} onClick={() => onSelect({ tp: r.tp, hold: c.hold })} aria-pressed={!!isSel} aria-label={c.detail || undefined}>
                      {c.text}
                    </button>
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
  const [picked, setPicked] = useState(null);
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
  const actual = useMemo(() => actualModel(data), [data]);
  const trades = actual.trades;
  const pickedCell = useMemo(() => grid?.rows.find((r) => r.tp === picked?.tp)?.cells.find((cl) => cl.hold === picked?.hold) || null, [grid, picked]);

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
              <button type="button" className={`${ui.btn} ${ui.btnSmall} ${x.retry}`} onClick={() => setAttempt((n) => n + 1)}>Reintentar</button>
            </p>
          )}
          {data && !loading && (
            <>
              <div className={x.head}>
                <span className={ui.small}>{coverageText(data.coverage)}</span>
                <span>
                  <strong className={ui.mono}>{actual.main}</strong>
                  {actual.secondary && <span className={`${ui.muted} ${ui.small}`}> · {actual.secondary}</span>}
                </span>
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
              {grid.rows.length ? (
                <>
                  <HeatMap grid={grid} mark={mark} selected={picked} onSelect={setPicked} />
                  <p className={`${ui.small} ${x.detailLine}`} role="status">{pickedCell?.detail || 'Toca una celda para ver su detalle.'}</p>
                </>
              ) : <p className={ui.empty}>Sin escenarios para este stop.</p>}
              <p className={`${ui.muted} ${ui.small}`}>La intensidad del color usa una escala común a todos los stops.</p>
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
