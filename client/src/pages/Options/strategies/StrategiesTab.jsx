import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MOBILE_QUERY, useMediaQuery } from '../../TradingView/useMediaQuery';
import { optionsStrategiesApi } from '../optionsAutomationApi';
import StrategyList, { Pnl } from './StrategyList';
import StrategyDetail from './StrategyDetail';
import StrategyForm from './StrategyForm';
import LiveConfirmDialog from './LiveConfirmDialog';
import Sheet from './common/Sheet';
import { PlusIcon, StrategyIcon } from './common/icons';
import { useVisibleInterval } from '../../../hooks/useVisibleInterval';
import { formatUsdt } from './common/format';
import { normalizeStrategy, sumPnl } from './strategyView';
import ui from './common/ui.module.css';
import styles from './StrategiesTab.module.css';

export const DETAIL_POLL_MS = 30000;

// Pestaña «Estrategias» del módulo de Opciones: lista + detalle en
// escritorio; en el teléfono, lista de tarjetas con FAB y detalle a pantalla
// completa. No necesita props (`underlying` sólo preselecciona el subyacente
// de una estrategia nueva).
export default function StrategiesTab({ underlying } = {}) {
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const [strategies, setStrategies] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);

  const [form, setForm] = useState(null); // { mode: 'create' | 'edit' }
  const [modePending, setModePending] = useState(null);
  const [modeError, setModeError] = useState(null);
  const [liveDialog, setLiveDialog] = useState({ open: false, submitting: false, error: null });
  const [deleteDialog, setDeleteDialog] = useState({ open: false, submitting: false, error: null });

  const mounted = useRef(true);
  // StrictMode monta, desmonta y vuelve a montar en desarrollo: hay que
  // volver a marcar el montaje, o las respuestas se descartan para siempre.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // ── Carga ────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    try {
      const data = await optionsStrategiesApi.list();
      if (!mounted.current) return;
      setStrategies((Array.isArray(data) ? data : []).map(normalizeStrategy));
      setListError(null);
    } catch (err) {
      if (mounted.current) setListError(err);
    } finally {
      if (mounted.current) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
    optionsStrategiesApi.listTemplates()
      .then((data) => { if (mounted.current) setTemplates(Array.isArray(data) ? data : []); })
      .catch(() => { /* el formulario muestra «Cargando plantillas…»; la lista sigue funcionando */ });
  }, [loadList]);

  // En escritorio siempre hay una estrategia seleccionada si existe alguna.
  useEffect(() => {
    if (isMobile || listLoading) return;
    if (!strategies.length) { setSelectedId(null); return; }
    if (!strategies.some((s) => s.id === selectedId)) setSelectedId(strategies[0].id);
  }, [isMobile, listLoading, strategies, selectedId]);

  const detailVisible = selectedId !== null && (!isMobile || mobileDetailOpen);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const loadDetail = useCallback(async (id) => {
    if (id === null || id === undefined) return;
    try {
      const data = await optionsStrategiesApi.get(id);
      // Respuesta tardía de una estrategia que ya no está seleccionada.
      if (!mounted.current || selectedRef.current !== id) return;
      setDetail(normalizeStrategy({ id, ...data }));
      setDetailError(null);
    } catch (err) {
      if (mounted.current && selectedRef.current === id) setDetailError(err);
    }
  }, []);

  useEffect(() => {
    setModeError(null);
    if (!detailVisible) return;
    setDetail((prev) => (prev?.id === selectedId ? prev : null));
    loadDetail(selectedId);
  }, [detailVisible, selectedId, loadDetail]);

  useVisibleInterval(() => loadDetail(selectedId), DETAIL_POLL_MS, detailVisible);

  // El detalle móvil ocupa toda la pantalla: sin scroll del fondo.
  useEffect(() => {
    if (!(isMobile && mobileDetailOpen)) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isMobile, mobileDetailOpen]);

  const selected = strategies.find((s) => s.id === selectedId) || null;
  // Mientras llega el detalle se pinta lo que ya trae la lista.
  const shown = detail && detail.id === selectedId ? detail : selected;

  const patchLocal = (id, patch) => {
    setStrategies((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    setDetail((d) => (d && d.id === id ? { ...d, ...patch } : d));
  };

  // ── Acciones ─────────────────────────────────────────────────────────
  const selectStrategy = (id) => {
    setSelectedId(id);
    if (isMobile) setMobileDetailOpen(true);
  };

  const changeMode = async (mode) => {
    if (!shown || mode === shown.mode) return;
    setModeError(null);
    if (mode === 'live') {
      setLiveDialog({ open: true, submitting: false, error: null });
      return;
    }
    setModePending(mode);
    try {
      await optionsStrategiesApi.setMode(shown.id, mode);
      patchLocal(shown.id, { mode });
      loadDetail(shown.id);
      loadList();
    } catch (err) {
      setModeError(err);
    } finally {
      setModePending(null);
    }
  };

  const confirmLive = async () => {
    if (!shown) return;
    setLiveDialog((d) => ({ ...d, submitting: true, error: null }));
    try {
      await optionsStrategiesApi.setMode(shown.id, 'live', { confirm: true });
      patchLocal(shown.id, { mode: 'live' });
      setLiveDialog({ open: false, submitting: false, error: null });
      loadDetail(shown.id);
      loadList();
    } catch (err) {
      setLiveDialog({ open: true, submitting: false, error: err });
    }
  };

  const submitForm = async (payload) => {
    if (form?.mode === 'edit' && shown) {
      await optionsStrategiesApi.update(shown.id, payload);
      setForm(null);
      patchLocal(shown.id, { name: payload.name, underlying: payload.underlying, params: payload.params, limits: payload.limits });
      loadDetail(shown.id);
      loadList();
      return;
    }
    const created = await optionsStrategiesApi.create(payload);
    setForm(null);
    const item = normalizeStrategy({ mode: 'paused', ...payload, ...(created || {}) });
    setStrategies((list) => [item, ...list.filter((s) => s.id !== item.id)]);
    if (item.id !== undefined) {
      setSelectedId(item.id);
      if (isMobile) setMobileDetailOpen(true);
    }
    loadList();
  };

  const confirmDelete = async () => {
    if (!shown) return;
    const id = shown.id;
    setDeleteDialog({ open: true, submitting: true, error: null });
    try {
      await optionsStrategiesApi.remove(id);
      setDeleteDialog({ open: false, submitting: false, error: null });
      setStrategies((list) => list.filter((s) => s.id !== id));
      setDetail(null);
      setSelectedId(null);
      setMobileDetailOpen(false);
      loadList();
    } catch (err) {
      setDeleteDialog({ open: true, submitting: false, error: err });
    }
  };

  const totals = useMemo(() => ({
    live: sumPnl(strategies, 'pnlLive'),
    shadow: sumPnl(strategies, 'pnlShadow'),
  }), [strategies]);

  // ── Piezas comunes ───────────────────────────────────────────────────
  const detailProps = shown && {
    strategy: shown,
    templates,
    modePending,
    modeError,
    loadError: detailError,
    onModeSelect: changeMode,
    onEdit: () => setForm({ mode: 'edit' }),
    onDelete: () => setDeleteDialog({ open: true, submitting: false, error: null }),
    onBack: () => setMobileDetailOpen(false),
  };

  const dialogs = (
    <>
      <StrategyForm
        open={!!form}
        strategy={form?.mode === 'edit' ? shown : null}
        templates={templates}
        underlying={underlying}
        onCancel={() => setForm(null)}
        onSubmit={submitForm}
      />
      <LiveConfirmDialog
        open={liveDialog.open}
        strategy={shown}
        submitting={liveDialog.submitting}
        error={liveDialog.error}
        onConfirm={confirmLive}
        onCancel={() => setLiveDialog({ open: false, submitting: false, error: null })}
      />
      <Sheet
        open={deleteDialog.open}
        title="Eliminar estrategia"
        description={shown ? `«${shown.name}»` : undefined}
        size="sm"
        onClose={() => setDeleteDialog({ open: false, submitting: false, error: null })}
        closeDisabled={deleteDialog.submitting}
        footer={(
          <>
            <button
              type="button"
              className={ui.btn}
              onClick={() => setDeleteDialog({ open: false, submitting: false, error: null })}
              disabled={deleteDialog.submitting}
            >
              Cancelar
            </button>
            <button type="button" className={`${ui.btn} ${ui.btnDanger}`} onClick={confirmDelete} disabled={deleteDialog.submitting}>
              {deleteDialog.submitting ? 'Eliminando…' : 'Eliminar'}
            </button>
          </>
        )}
      >
        <p className={styles.prose}>
          Se borran la estrategia, su historial de decisiones y sus curvas de sombra y real. No se puede deshacer.
          {shown?.mode === 'live' && ' Está en modo Real: las posiciones abiertas en Binance no se cierran automáticamente.'}
        </p>
        {deleteDialog.error && <p className={`${ui.alert} ${ui.alertError}`} role="alert">{deleteDialog.error.message}</p>}
      </Sheet>
    </>
  );

  const listErrorAlert = listError && (
    <div className={`${ui.alert} ${ui.alertError}`} role="alert">
      <span>No se pudieron cargar las estrategias: {listError.message}</span>
      <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => { setListLoading(true); loadList(); }}>Reintentar</button>
    </div>
  );

  const emptyState = (
    <div className={styles.emptyState}>
      <StrategyIcon size={28} />
      <p className={styles.emptyTitle}>Aún no tienes estrategias</p>
      <p className={styles.emptyText}>
        Crea una a partir de una plantilla (strangle corto, call cubierta o put protectora). Empieza en pausa; pruébala en sombra con datos reales y llenados simulados antes de pasarla a real.
      </p>
    </div>
  );

  // ── Móvil ────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className={styles.mobileRoot}>
        <div className={ui.tileGrid}>
          <div className={ui.tile}>
            <span className={`${ui.tileLabel} ${styles.upper}`}>Real · 30d</span>
            <Pnl value={totals.live} className={styles.tileBig} />
          </div>
          <div className={ui.tile}>
            <span className={`${ui.tileLabel} ${styles.upper}`}>Sombra · 30d</span>
            <span className={`${ui.mono} ${styles.tileBig} ${styles.shadowValue}`}>
              {formatUsdt(totals.shadow, { sign: true })}
            </span>
          </div>
        </div>
        {listErrorAlert}
        {listLoading && !strategies.length && (
          <div className={styles.skeletons} aria-busy="true" aria-label="Cargando estrategias">
            {[0, 1, 2].map((i) => <div key={i} className={ui.skeleton} style={{ height: 96 }} />)}
          </div>
        )}
        {!listLoading && !strategies.length && !listError && emptyState}
        {strategies.length > 0 && (
          <StrategyList strategies={strategies} templates={templates} selectedId={selectedId} onSelect={selectStrategy} mobile />
        )}
        <button type="button" className={styles.fab} onClick={() => setForm({ mode: 'create' })}>
          <PlusIcon size={20} /> Nueva
        </button>
        {mobileDetailOpen && detailProps && <StrategyDetail {...detailProps} mobile />}
        {dialogs}
      </div>
    );
  }

  // ── Escritorio ───────────────────────────────────────────────────────
  return (
    <div className={styles.desktopRoot}>
      <aside className={styles.aside} aria-label="Lista de estrategias">
        <button type="button" className={styles.newBtn} onClick={() => setForm({ mode: 'create' })}>
          <PlusIcon size={16} /> Nueva estrategia
        </button>
        {listErrorAlert}
        {listLoading && !strategies.length && (
          <div className={styles.skeletons} aria-busy="true" aria-label="Cargando estrategias">
            {[0, 1, 2].map((i) => <div key={i} className={ui.skeleton} style={{ height: 92 }} />)}
          </div>
        )}
        {strategies.length > 0 && (
          <StrategyList strategies={strategies} templates={templates} selectedId={selectedId} onSelect={selectStrategy} />
        )}
      </aside>
      {detailProps
        ? <StrategyDetail {...detailProps} />
        : (!listLoading && !listError && <section className={styles.detail}>{emptyState}</section>)}
      {dialogs}
    </div>
  );
}
