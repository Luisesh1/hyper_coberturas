import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MOBILE_QUERY, useMediaQuery } from '../../TradingView/useMediaQuery';
import { autoBotsApi } from '../autoTradingApi';
import { optionsBacktestsApi, optionsStrategiesApi } from '../optionsAutomationApi';
import Sheet from '../strategies/common/Sheet';
import { formatPct, formatUsdt, toNumber } from '../strategies/common/format';
import { HistoryIcon, RunIcon, SlidersIcon } from '../strategies/common/icons';
import { normalizeStrategy } from '../strategies/strategyView';
import { rawBotUnderlyings } from '../auto/botView';
import BacktestForm from './BacktestForm';
import BacktestResults, { RunProgress, SourceNote } from './BacktestResults';
import {
  STATUS_LABEL, buildBacktestPayload, countErrors, defaultForm, isFinished, normalizeRun,
  parseSelection, periodLabel, runSubtitle, runTitle, selectedStrategy, sourceByKey, validateBacktestForm,
} from './backtestView';
import ui from '../strategies/common/ui.module.css';
import styles from './BacktestingTab.module.css';

export const BACKTEST_POLL_MS = 2000;

function HistoryList({ runs, activeId, onOpen, strategies, templates }) {
  if (!runs.length) return <p className={`${ui.muted} ${ui.small}`} style={{ margin: 0 }}>Todavía no has ejecutado ningún backtest.</p>;
  return (
    <ul className={styles.history}>
      {runs.map((r) => {
        const ret = toNumber(r.result?.metrics?.returnPct);
        const active = r.id === activeId;
        return (
          <li key={r.id}>
            <button
              type="button"
              className={`${styles.historyItem} ${active ? styles.historyItemOn : ''}`}
              aria-current={active ? 'true' : undefined}
              onClick={() => onOpen(r)}
            >
              <span className={styles.historyTop}>
                <span className={styles.historyName}>{runTitle(r, { strategies, templates })}</span>
                {r.status === 'done' && ret !== null
                  ? <span className={`${ui.mono} ${ret > 0 ? ui.tone_pos : ret < 0 ? ui.tone_neg : ui.tone_muted}`}>{formatPct(ret, { sign: true })}</span>
                  : <span className={`${ui.badge} ${ui[`badge_${r.status}`] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span>}
              </span>
              <span className={styles.historySub}>{runSubtitle(r)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Pestaña «Backtesting» del módulo de Opciones. Sin props obligatorias
// (`underlying` sólo preselecciona el subyacente).
export default function BacktestingTab({ underlying, initialStrategyId = null } = {}) {
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const [strategies, setStrategies] = useState([]);
  const [bots, setBots] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState(() => defaultForm({ underlying }));
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState({});

  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [pollError, setPollError] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const mounted = useRef(true);
  // StrictMode monta, desmonta y vuelve a montar en desarrollo: hay que
  // volver a marcar el montaje, o las respuestas se descartan para siempre.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const allStrategies = useMemo(() => [...strategies, ...bots], [strategies, bots]);
  const ctx = useMemo(() => ({ strategies: allStrategies, templates }), [allStrategies, templates]);

  // ── Carga inicial ────────────────────────────────────────────────────
  const loadHistory = useCallback(async ({ autoOpen = false } = {}) => {
    try {
      const data = await optionsBacktestsApi.list();
      if (!mounted.current) return;
      const runs = (Array.isArray(data) ? data : []).map(normalizeRun)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      setHistory(runs);
      setHistoryError(null);
      if (autoOpen) {
        const latest = runs.find((r) => r.status === 'done') || runs.find((r) => !isFinished(r.status));
        if (latest) {
          setActiveRun((cur) => cur || latest);
          if (latest.status === 'done' && !latest.result) {
            const full = await optionsBacktestsApi.get(latest.id);
            if (mounted.current) setActiveRun((cur) => (cur && cur.id === latest.id ? normalizeRun(full) : cur));
          }
        }
      }
    } catch (err) {
      if (mounted.current) setHistoryError(err);
    }
  }, []);

  useEffect(() => {
    optionsStrategiesApi.list()
      .then((data) => { if (mounted.current) setStrategies((Array.isArray(data) ? data : []).map(normalizeStrategy)); })
      .catch(() => {});
    autoBotsApi.list()
      .then((data) => { if (mounted.current) setBots((Array.isArray(data) ? data : []).map((r) => ({ ...normalizeStrategy(r), underlyings: rawBotUnderlyings(r) }))); })
      .catch(() => {});
    optionsStrategiesApi.listTemplates()
      .then((data) => { if (mounted.current) setTemplates(Array.isArray(data) ? data : []); })
      .catch(() => {});
    loadHistory({ autoOpen: true });
  }, [loadHistory]);

  // Preselección desde `?strategyId=` (botón «Backtestear» del bot).
  useEffect(() => {
    if (form.selection || initialStrategyId === null || initialStrategyId === undefined || initialStrategyId === '') return;
    const s = allStrategies.find((x) => String(x.id) === String(initialStrategyId));
    if (!s) return;
    const isBot = bots.some((b) => b.id === s.id);
    setForm((f) => {
      if (f.selection) return f;
      const und = s.underlying || f.underlying;
      const dvolOk = ['BTC', 'ETH'].includes(und);
      let source = f.source;
      if ((isBot && source === 'recorded') || (source === 'dvol' && !dvolOk)) source = dvolOk ? 'dvol' : 'realized';
      return { ...f, selection: `s:${s.id}`, underlying: und, source };
    });
  }, [allStrategies, bots, initialStrategyId, form.selection]);

  // Preselección: la primera estrategia guardada o, si no hay, la primera plantilla.
  useEffect(() => {
    if (form.selection) return;
    if (initialStrategyId !== null && initialStrategyId !== undefined && initialStrategyId !== '') return;
    if (strategies.length) {
      const s = strategies[0];
      setForm((f) => (f.selection ? f : {
        ...f,
        selection: `s:${s.id}`,
        underlying: s.underlying || f.underlying,
        source: ['BTC', 'ETH'].includes(s.underlying || f.underlying) ? f.source : 'realized',
      }));
    }
  }, [strategies, form.selection]);

  // ── Sondeo de la ejecución en curso ──────────────────────────────────
  const activeId = activeRun?.id;
  const activeStatus = activeRun?.status;
  useEffect(() => {
    if (activeId === undefined || activeId === null || isFinished(activeStatus)) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await optionsBacktestsApi.get(activeId);
        if (cancelled || !mounted.current) return;
        const run = normalizeRun({ id: activeId, ...data });
        setPollError(null);
        setActiveRun((cur) => (cur && cur.id === activeId ? { ...run, config: Object.keys(run.config).length ? run.config : cur.config } : cur));
        setHistory((list) => list.map((r) => (r.id === activeId ? { ...r, ...run, config: Object.keys(run.config).length ? run.config : r.config } : r)));
        if (isFinished(run.status)) loadHistory();
      } catch (err) {
        if (cancelled || !mounted.current) return;
        // Un fallo puntual no detiene el sondeo: se reintenta en el siguiente ciclo.
        setPollError(err);
        setActiveRun((cur) => (cur ? { ...cur } : cur));
      }
    }, BACKTEST_POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeId, activeStatus, activeRun, loadHistory]);

  // ── Formulario ───────────────────────────────────────────────────────
  const updateForm = (next) => {
    setForm(next);
    if (submitted) setErrors(validateBacktestForm(next, ctx));
  };

  const running = !!activeRun && !isFinished(activeRun.status);

  const submit = async () => {
    setSubmitted(true);
    const found = validateBacktestForm(form, ctx);
    setErrors(found);
    if (Object.keys(found).length) {
      if (isMobile) setSheetOpen(true);
      return;
    }
    const payload = buildBacktestPayload(form);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await optionsBacktestsApi.create(payload);
      if (!mounted.current) return;
      const run = normalizeRun({ status: 'queued', ...(res || {}), config: res?.config || payload });
      setActiveRun(run);
      setPollError(null);
      setHistory((list) => [run, ...list.filter((r) => r.id !== run.id)]);
      setSheetOpen(false);
    } catch (err) {
      if (mounted.current) setSubmitError(err);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  const openRun = async (run) => {
    setActiveRun(run);
    setPollError(null);
    if (run.status === 'done' && !run.result) {
      try {
        const full = await optionsBacktestsApi.get(run.id);
        if (mounted.current) setActiveRun((cur) => (cur && cur.id === run.id ? normalizeRun({ id: run.id, ...full }) : cur));
      } catch (err) {
        if (mounted.current) setPollError(err);
      }
    }
  };

  // ── Resultado / estado ───────────────────────────────────────────────
  const errorCount = countErrors(errors);
  const resultArea = (() => {
    if (!activeRun) {
      return (
        <>
          <SourceNote source={form.source} mobile={isMobile} />
          <div className={styles.emptyState}>
            <HistoryIcon size={28} />
            <p className={styles.emptyTitle}>Sin resultados todavía</p>
            <p className={styles.emptyText}>
              Elige una estrategia, el periodo y la fuente de precios y pulsa «Ejecutar backtest». El cálculo corre en el servidor y la página se actualiza sola.
            </p>
          </div>
        </>
      );
    }
    if (!isFinished(activeRun.status)) return <RunProgress run={activeRun} mobile={isMobile} />;
    if (activeRun.status === 'failed') {
      return (
        <p className={`${ui.alert} ${ui.alertError}`} role="alert">
          El backtest falló: {activeRun.error || 'error desconocido'}.
        </p>
      );
    }
    if (!activeRun.result) return <div className={ui.skeleton} style={{ height: 220 }} aria-busy="true" aria-label="Cargando resultado" />;
    return <BacktestResults run={activeRun} mobile={isMobile} />;
  })();

  const alerts = (
    <>
      {submitError && <p className={`${ui.alert} ${ui.alertError}`} role="alert">No se pudo lanzar el backtest: {submitError.message}</p>}
      {pollError && <p className={`${ui.alert} ${ui.alertError}`} role="alert">No se pudo consultar el backtest: {pollError.message}. Se reintentará.</p>}
    </>
  );

  const formNode = (
    <BacktestForm
      form={form}
      onChange={updateForm}
      strategies={strategies}
      bots={bots}
      templates={templates}
      errors={errors}
      disabled={submitting}
      mobile={isMobile}
    />
  );

  const runLabel = submitting ? 'Enviando…' : running ? 'Ejecutando…' : 'Ejecutar backtest';

  // ── Móvil ────────────────────────────────────────────────────────────
  if (isMobile) {
    const sel = parseSelection(form.selection);
    const strat = selectedStrategy(form, allStrategies);
    const tpl = sel?.kind === 'template' ? templates.find((t) => t.id === sel.id) : null;
    const title = strat?.name || (tpl ? `${tpl.label || tpl.id} (plantilla)` : 'Elige una estrategia');
    const summary = [periodLabel(form), `${formatUsdt(form.capitalUsdt, { decimals: 0 })} USDT`, sourceByKey(form.source).short]
      .filter(Boolean).join(' · ');
    return (
      <div className={styles.mobileRoot}>
        <button type="button" className={styles.summaryCard} onClick={() => setSheetOpen(true)} aria-label={`Configurar backtest: ${title}`}>
          <span className={styles.summaryText}>
            <span className={styles.summaryTitle}>{title}</span>
            <span className={styles.summarySub}>{form.underlying} · {summary}</span>
            {submitted && errorCount > 0 && <span className={styles.fieldError}>Revisa {errorCount === 1 ? '1 campo' : `${errorCount} campos`}</span>}
          </span>
          <SlidersIcon size={20} />
        </button>
        {alerts}
        {resultArea}
        <section className={styles.mobileSection}>
          <h2 className={styles.mobileH2}>Ejecuciones anteriores</h2>
          {historyError && <p className={`${ui.alert} ${ui.alertError}`}>No se pudo cargar el historial: {historyError.message}</p>}
          <HistoryList runs={history} activeId={activeRun?.id} onOpen={openRun} {...ctx} />
        </section>

        <div className={styles.stickyCta}>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary} ${styles.ctaBtn}`} onClick={submit} disabled={submitting || running}>
            <RunIcon size={16} /> {runLabel}
          </button>
        </div>

        <Sheet
          open={sheetOpen}
          title="Configuración del backtest"
          onClose={() => setSheetOpen(false)}
          footer={<button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => setSheetOpen(false)}>Listo</button>}
        >
          {formNode}
          {submitted && errorCount > 0 && (
            <p className={`${ui.alert} ${ui.alertError}`} role="alert">Revisa {errorCount === 1 ? 'el campo marcado' : `los ${errorCount} campos marcados`}.</p>
          )}
        </Sheet>
      </div>
    );
  }

  // ── Escritorio ───────────────────────────────────────────────────────
  return (
    <div className={styles.desktopRoot}>
      <div className={styles.aside}>
        <form
          className={`${ui.panel} ${styles.formPanel}`}
          aria-label="Configuración del backtest"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          noValidate
        >
          <h2 className={styles.h2}>Configuración</h2>
          {formNode}
          {submitted && errorCount > 0 && (
            <p className={`${ui.alert} ${ui.alertError}`} role="alert">Revisa {errorCount === 1 ? 'el campo marcado' : `los ${errorCount} campos marcados`}.</p>
          )}
          <button type="submit" className={`${ui.btn} ${ui.btnPrimary} ${styles.ctaBtn}`} disabled={submitting || running}>
            <RunIcon size={16} /> {runLabel}
          </button>
        </form>
        <div className={ui.panel}>
          <h3 className={ui.h3}>Ejecuciones anteriores</h3>
          {historyError && <p className={`${ui.alert} ${ui.alertError}`}>No se pudo cargar el historial: {historyError.message}</p>}
          <HistoryList runs={history} activeId={activeRun?.id} onOpen={openRun} {...ctx} />
        </div>
      </div>
      <section className={styles.results} aria-label="Resultados">
        {alerts}
        {resultArea}
      </section>
    </div>
  );
}
