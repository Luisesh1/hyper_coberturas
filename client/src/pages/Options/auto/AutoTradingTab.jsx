import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MOBILE_QUERY, useMediaQuery } from '../../TradingView/useMediaQuery';
import { optionsStrategiesApi } from '../optionsAutomationApi';
import { autoBotsApi } from '../autoTradingApi';
import { optionsApi } from '../../../services/api';
import LiveConfirmDialog from '../strategies/LiveConfirmDialog';
import Sheet from '../strategies/common/Sheet';
import { PlusIcon } from '../strategies/common/icons';
import { useVisibleInterval } from '../../../hooks/useVisibleInterval';
import { formatDateTime } from '../strategies/common/format';
import BotList from './BotList';
import BotDetail from './BotDetail';
import BotForm from './BotForm';
import DirectionChip from './DirectionChip';
import PendingBanner from './visual/PendingBanner';
import { pendingEntryRows } from './botActivity';
import { AutoIcon as BoltIcon } from '../icons';
import { DECISION_LABEL, filterSignals, latestSignal, normalizeBot, normalizeSignals, signalStats } from './botView';
import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';

export const SIGNALS_POLL_MS = 15000;
export const DETAIL_POLL_MS = 30000;
export const LIST_POLL_MS = 30000;

const LIVE_POINTS = [
  'Abre una opción cuando se dispara una de sus alertas alcistas o bajistas, según la estructura elegida.',
  'Las salidas (toma de ganancia, stop y cierre antes del vencimiento) se revisan cada 5 minutos.',
  'Respeta los límites de riesgo globales y los del bot; si se supera alguno, no envía la orden.',
  'El modo sombra sigue corriendo en paralelo. Puedes volver a Sombra o Pausado cuando quieras; las posiciones abiertas no se cierran solas.',
];

const CLOSED_DIALOG = { open: false, submitting: false, error: null };
const CLOSED_CLOSE = { open: false, positionIds: undefined, submitting: false, error: null, result: null };
const CLOSE_RESULT = {
  closed: 'Cerrado.',
  pending: 'Orden enviada; esperando ejecución.',
  nothing_to_close: 'No había posiciones abiertas que cerrar.',
  not_submitted: 'No se envió la orden.',
};

// Pestaña «Trading automatizado» del módulo de Opciones: bots que abren y
// cierran opciones cuando se disparan alertas alcistas o bajistas.
// Escritorio: lista + detalle. Teléfono: banner de entrada pendiente,
// «Última señal», tarjetas, FAB y detalle a pantalla completa.
export default function AutoTradingTab({ underlying } = {}) {
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const [bots, setBots] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);

  const [signalsFilter, setSignalsFilter] = useState('all');
  const [signals, setSignals] = useState({ id: null, filter: 'all', list: [], loading: false, error: null });
  const [stats, setStats] = useState({ id: null, value: null });

  const [form, setForm] = useState(null); // { mode: 'create' | 'edit' }
  const [modePending, setModePending] = useState(null);
  const [modeError, setModeError] = useState(null);
  const [liveDialog, setLiveDialog] = useState(CLOSED_DIALOG);
  const [deleteDialog, setDeleteDialog] = useState(CLOSED_DIALOG);
  const [unlink, setUnlink] = useState({ pending: false, error: null });
  const [closeDialog, setCloseDialog] = useState(CLOSED_CLOSE);
  const [cancel, setCancel] = useState({ pendingId: null, notice: null });
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState(null);
  const [sim, setSim] = useState({ pending: false, notice: null });
  const [unblock, setUnblock] = useState({ pending: null, error: null });
  // Bloqueo síncrono: un doble clic no puede lanzar dos peticiones antes
  // de que React vuelva a pintar los botones deshabilitados.
  const actionInFlight = useRef(false);

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
      const data = await autoBotsApi.list();
      if (!mounted.current) return;
      setBots((Array.isArray(data) ? data : []).map(normalizeBot));
      setListError(null);
    } catch (err) {
      if (mounted.current) setListError(err);
    } finally {
      if (mounted.current) setListLoading(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useVisibleInterval(loadList, LIST_POLL_MS, true);

  // En escritorio siempre hay un bot seleccionado si existe alguno.
  useEffect(() => {
    if (isMobile || listLoading) return;
    if (!bots.length) { setSelectedId(null); return; }
    if (!bots.some((b) => b.id === selectedId)) setSelectedId(bots[0].id);
  }, [isMobile, listLoading, bots, selectedId]);

  const detailVisible = selectedId !== null && (!isMobile || mobileDetailOpen);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const filterRef = useRef(signalsFilter);
  filterRef.current = signalsFilter;

  const loadDetail = useCallback(async (id) => {
    if (id === null || id === undefined) return;
    try {
      const data = await optionsStrategiesApi.get(id);
      if (!mounted.current || selectedRef.current !== id) return;
      setDetail({ id, ...data });
      setDetailError(null);
    } catch (err) {
      if (mounted.current && selectedRef.current === id) setDetailError(err);
    }
  }, []);

  const loadSignals = useCallback(async (id, filter) => {
    if (id === null || id === undefined) return;
    setSignals((s) => ({ ...s, loading: true }));
    try {
      const data = await autoBotsApi.signals(id, { limit: 100, filter });
      if (!mounted.current || selectedRef.current !== id || filterRef.current !== filter) return;
      const list = normalizeSignals(data);
      setSignals({ id, filter, list: filterSignals(list, filter), loading: false, error: null });
      if (filter === 'all') setStats({ id, value: signalStats(list) });
    } catch (err) {
      if (mounted.current && selectedRef.current === id && filterRef.current === filter) {
        setSignals((s) => ({ ...s, loading: false, error: err }));
      }
    }
  }, []);

  useEffect(() => {
    setModeError(null);
    setUnlink({ pending: false, error: null });
    setCancel({ pendingId: null, notice: null });
    setSim({ pending: false, notice: null });
    setUnblock({ pending: null, error: null });
    if (!detailVisible) return;
    setDetail((prev) => (prev?.id === selectedId ? prev : null));
    loadDetail(selectedId);
  }, [detailVisible, selectedId, loadDetail]);

  useEffect(() => {
    if (!detailVisible) return;
    setSignals((s) => (s.id === selectedId && s.filter === signalsFilter
      ? s
      : { id: selectedId, filter: signalsFilter, list: [], loading: true, error: null }));
    loadSignals(selectedId, signalsFilter);
  }, [detailVisible, selectedId, signalsFilter, loadSignals]);

  useVisibleInterval(() => loadDetail(selectedId), DETAIL_POLL_MS, detailVisible);
  useVisibleInterval(() => loadSignals(selectedId, filterRef.current), SIGNALS_POLL_MS, detailVisible);

  // El detalle móvil ocupa toda la pantalla: sin scroll del fondo.
  useEffect(() => {
    if (!(isMobile && mobileDetailOpen)) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isMobile, mobileDetailOpen]);

  // El aviso de un clonado fallido es del bot que se clonó: se limpia al cambiar de selección.
  useEffect(() => { setCloneError(null); }, [selectedId]);
  // La confirmación de cierre es del bot en pantalla: al cambiar de bot se
  // descarta (no debe poder confirmarse contra otro bot).
  useEffect(() => { setCloseDialog(CLOSED_CLOSE); }, [selectedId]);

  const selected = bots.find((b) => b.id === selectedId) || null;
  // Lo que trae la lista (alertas, estado) + el detalle (kpis, params, límites).
  const shown = useMemo(() => {
    if (!selected) return null;
    const d = detail && detail.id === selected.id ? detail : null;
    if (!d) return selected;
    return normalizeBot({
      ...selected,
      ...d,
      alerts: Array.isArray(d.alerts) ? d.alerts : selected.alerts,
      status: d.status || selected.status,
      pnl30d: d.pnl30d || selected.pnl30d,
    });
  }, [selected, detail]);

  const patchLocal = (id, patch) => {
    setBots((list) => list.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    setDetail((d) => (d && d.id === id ? { ...d, ...patch } : d));
  };

  const refresh = (id) => {
    loadDetail(id);
    loadList();
  };

  // ── Acciones ─────────────────────────────────────────────────────────
  const selectBot = (id) => {
    if (id !== selectedId) setSignalsFilter('all');
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
      refresh(shown.id);
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
      setLiveDialog(CLOSED_DIALOG);
      refresh(shown.id);
    } catch (err) {
      setLiveDialog({ open: true, submitting: false, error: err });
    }
  };

  const submitForm = async (payload) => {
    if (form?.mode === 'edit' && shown) {
      await autoBotsApi.update(shown.id, payload);
      setForm(null);
      patchLocal(shown.id, {
        name: payload.name,
        alertIds: payload.alertIds,
        params: { ...(shown.params || {}), ...payload.params, alertIds: payload.alertIds },
        limits: payload.limits,
        structure: payload.params.structure,
      });
      refresh(shown.id);
      return;
    }
    const created = await autoBotsApi.create(payload);
    setForm(null);
    const item = normalizeBot({ mode: 'shadow', ...payload, params: { ...payload.params, alertIds: payload.alertIds }, ...(created || {}) });
    setBots((list) => [item, ...list.filter((b) => b.id !== item.id)]);
    if (item.id !== undefined) {
      setSelectedId(item.id);
      if (isMobile) setMobileDetailOpen(true);
    }
    loadList();
  };

  const cloneBot = async () => {
    if (!shown || cloning) return;
    setCloning(true);
    setCloneError(null);
    try {
      const created = await autoBotsApi.clone(shown.id);
      if (!mounted.current) return;
      const item = normalizeBot({ mode: 'shadow', ...(created || {}) });
      setBots((list) => [item, ...list.filter((b) => b.id !== item.id)]);
      if (item.id !== undefined) {
        setSelectedId(item.id);
        if (isMobile) setMobileDetailOpen(true);
      }
      setCloneError(null);
      loadList();
    } catch (err) {
      if (mounted.current) setCloneError(err);
    } finally {
      if (mounted.current) setCloning(false);
    }
  };

  const unlinkAlert = async (alertId) => {
    if (!shown) return;
    const ids = (shown.alertIds || []).filter((id) => id !== alertId);
    if (!ids.length) return;
    setUnlink({ pending: true, error: null });
    try {
      await autoBotsApi.update(shown.id, { alertIds: ids });
      if (!mounted.current) return;
      patchLocal(shown.id, {
        alertIds: ids,
        alerts: (shown.alerts || []).filter((a) => a.id !== alertId),
        params: { ...(shown.params || {}), alertIds: ids },
      });
      setUnlink({ pending: false, error: null });
      refresh(shown.id);
    } catch (err) {
      if (mounted.current) setUnlink({ pending: false, error: err });
    }
  };

  const confirmDelete = async () => {
    if (!shown) return;
    const id = shown.id;
    setDeleteDialog({ open: true, submitting: true, error: null });
    try {
      await optionsStrategiesApi.remove(id);
      setDeleteDialog(CLOSED_DIALOG);
      setBots((list) => list.filter((b) => b.id !== id));
      setDetail(null);
      setSelectedId(null);
      setMobileDetailOpen(false);
      loadList();
    } catch (err) {
      setDeleteDialog({ open: true, submitting: false, error: err });
    }
  };

  const openClose = (positionIds) => {
    if (actionInFlight.current) return;
    setCloseDialog({ ...CLOSED_CLOSE, open: true, positionIds });
  };

  const dismissClose = () => {
    if (closeDialog.submitting) return;
    setCloseDialog(CLOSED_CLOSE);
  };

  const confirmClose = async () => {
    if (!shown || actionInFlight.current) return;
    const id = shown.id;
    const { positionIds } = closeDialog;
    actionInFlight.current = true;
    setCloseDialog((d) => ({ ...d, submitting: true, error: null, result: null }));
    try {
      const result = await autoBotsApi.close(id, { positionIds });
      if (mounted.current) setCloseDialog((d) => ({ ...d, submitting: false, result: result || { status: 'closed' } }));
      refresh(id);
    } catch (err) {
      if (mounted.current) setCloseDialog((d) => ({ ...d, submitting: false, error: err }));
    } finally {
      actionInFlight.current = false;
    }
  };

  const cancelOrder = async (orderId) => {
    if (!shown || actionInFlight.current) return;
    const id = shown.id;
    actionInFlight.current = true;
    setSim((x) => ({ ...x, notice: null }));
    setCancel({ pendingId: orderId, notice: null });
    try {
      await autoBotsApi.cancelOrder(id, orderId);
      if (mounted.current) {
        setCancel({ pendingId: null, notice: { message: 'Cancelación solicitada: se cancelará en Binance en la próxima conciliación.' } });
        setDetail((d) => (d && d.id === id && Array.isArray(d.pendingOrders)
          ? { ...d, pendingOrders: d.pendingOrders.map((o) => (o.id === orderId ? { ...o, cancelRequested: true } : o)) }
          : d));
      }
      refresh(id);
    } catch (err) {
      if (mounted.current) setCancel({ pendingId: null, notice: { error: true, message: `No se pudo cancelar la orden: ${err.message}` } });
    } finally {
      actionInFlight.current = false;
    }
  };

  const simulate = async (direction, simUnderlying) => {
    if (!shown || actionInFlight.current) return;
    const id = shown.id;
    actionInFlight.current = true;
    setSim({ pending: true, notice: null });
    try {
      const res = await autoBotsApi.simulate(id, simUnderlying ? { direction, underlying: simUnderlying } : { direction });
      if (mounted.current) {
        const label = DECISION_LABEL[res?.decision] || res?.decision || '—';
        setSim({ pending: false, notice: { message: `Simulación enviada: ${label}${res?.detail ? ` · ${res.detail}` : ''}` } });
      }
      loadSignals(id, filterRef.current);
      refresh(id);
    } catch (err) {
      if (mounted.current) setSim({ pending: false, notice: { error: true, message: err.message || 'No se pudo simular la señal' } });
    } finally {
      actionInFlight.current = false;
    }
  };

  // Quita el bloqueo de un subyacente (tras revisar a mano una entrada
  // parcial inoperable). El servidor devuelve el resumen del bot.
  const unblockUnderlying = async (u) => {
    if (!shown || actionInFlight.current) return;
    const id = shown.id;
    actionInFlight.current = true;
    setUnblock({ pending: u, error: null });
    try {
      await optionsApi.unblockAutoBot(id, u);
      if (mounted.current) {
        setUnblock({ pending: null, error: null });
        const remaining = Object.keys(shown.blockedUnderlyings || {}).filter((k) => k !== u).length;
        setDetail((d) => {
          if (!d || d.id !== id || !d.blockedUnderlyings) return d;
          const rest = { ...d.blockedUnderlyings };
          delete rest[u];
          return { ...d, blockedUnderlyings: rest };
        });
        setBots((list) => list.map((b) => (b.id === id ? { ...b, blocked: remaining > 0 } : b)));
      }
      refresh(id);
    } catch (err) {
      if (mounted.current) setUnblock({ pending: null, error: err });
    } finally {
      actionInFlight.current = false;
    }
  };

  // ── Piezas comunes ───────────────────────────────────────────────────
  const signalsReady = shown && signals.id === shown.id && signals.filter === signalsFilter;
  const detailProps = shown && {
    bot: shown,
    signals: signalsReady ? signals.list : [],
    signalsFilter,
    onSignalsFilter: setSignalsFilter,
    signalsLoading: !signalsReady || signals.loading,
    signalsError: signalsReady ? signals.error : null,
    stats: stats.id === shown.id ? stats.value : null,
    modePending,
    modeError,
    loadError: detailError,
    unlinkError: unlink.error,
    unlinking: unlink.pending,
    onModeSelect: changeMode,
    onEdit: () => setForm({ mode: 'edit' }),
    onClone: cloneBot,
    cloning,
    onDelete: () => setDeleteDialog({ open: true, submitting: false, error: null }),
    onUnlink: unlinkAlert,
    onBack: () => setMobileDetailOpen(false),
    onClosePosition: (positionId) => openClose([positionId]),
    onCloseAll: () => openClose(undefined),
    onCancelOrder: cancelOrder,
    onSimulate: simulate,
    onUnblock: unblockUnderlying,
    unblocking: unblock.pending,
    actionBusy: closeDialog.submitting || cancel.pendingId !== null || sim.pending || unblock.pending !== null,
    actionNotice: sim.notice || cancel.notice
      || (unblock.error ? { error: true, message: `No se pudo desbloquear: ${unblock.error.message}` } : null)
      || (cloneError ? { error: true, message: `No se pudo clonar el bot: ${cloneError.message}` } : null),
  };

  const closeAll = closeDialog.positionIds === undefined;
  const closeResult = closeDialog.result;
  const closeTone = closeResult && ['closed', 'pending'].includes(closeResult.status) ? ui.alertInfo : ui.alertWarn;

  const dialogs = (
    <>
      <BotForm
        open={!!form}
        bot={form?.mode === 'edit' ? shown : null}
        underlying={underlying}
        onCancel={() => setForm(null)}
        onSubmit={submitForm}
      />
      <LiveConfirmDialog
        open={liveDialog.open}
        strategy={shown}
        subject="El bot"
        points={LIVE_POINTS}
        submitting={liveDialog.submitting}
        error={liveDialog.error}
        onConfirm={confirmLive}
        onCancel={() => setLiveDialog(CLOSED_DIALOG)}
      />
      <Sheet
        open={deleteDialog.open}
        title="Eliminar bot"
        description={shown ? `«${shown.name}»` : undefined}
        size="sm"
        onClose={() => setDeleteDialog(CLOSED_DIALOG)}
        closeDisabled={deleteDialog.submitting}
        footer={(
          <>
            <button type="button" className={ui.btn} onClick={() => setDeleteDialog(CLOSED_DIALOG)} disabled={deleteDialog.submitting}>
              Cancelar
            </button>
            <button type="button" className={`${ui.btn} ${ui.btnDanger}`} onClick={confirmDelete} disabled={deleteDialog.submitting}>
              {deleteDialog.submitting ? 'Eliminando…' : 'Eliminar'}
            </button>
          </>
        )}
      >
        <p className={styles.prose}>
          Se borran el bot, su registro de señales y sus curvas de sombra y real. Las alertas no se tocan. No se puede deshacer.
          {shown?.mode === 'live' && ' Está en modo Real: las posiciones abiertas en Binance no se cierran automáticamente.'}
        </p>
        {deleteDialog.error && <p className={`${ui.alert} ${ui.alertError}`} role="alert">{deleteDialog.error.message}</p>}
      </Sheet>
      <Sheet
        open={closeDialog.open}
        title={closeAll ? 'Cerrar todas las posiciones' : 'Cerrar posición'}
        description={shown ? `«${shown.name}»` : undefined}
        size="sm"
        tone={shown?.mode === 'live' ? 'warning' : 'default'}
        onClose={dismissClose}
        closeDisabled={closeDialog.submitting}
        footer={closeResult ? (
          <button type="button" className={ui.btn} onClick={dismissClose}>Listo</button>
        ) : (
          <>
            <button type="button" className={ui.btn} onClick={dismissClose} disabled={closeDialog.submitting}>
              Volver
            </button>
            <button type="button" className={`${ui.btn} ${ui.btnDanger}`} onClick={confirmClose} disabled={closeDialog.submitting}>
              {closeDialog.submitting ? 'Cerrando…' : 'Confirmar cierre'}
            </button>
          </>
        )}
      >
        {!closeResult && (
          <p className={styles.prose}>
            {shown?.mode === 'live'
              ? <>Se enviará una orden LIMIT real a Binance para cerrar {closeAll ? 'todas las posiciones reales del bot' : 'esta posición'} al precio de mercado actual. Si hay un TP residente, primero se cancela.</>
              : <>Se cerrará{closeAll ? 'n todas las posiciones' : ' la posición'} del libro en sombra con un llenado simulado. No se envía nada a Binance.</>}
          </p>
        )}
        {closeResult && (
          <p className={`${ui.alert} ${closeTone}`} role="status">
            {CLOSE_RESULT[closeResult.status] || ''} {closeResult.detail || ''}
          </p>
        )}
        {closeDialog.error && <p className={`${ui.alert} ${ui.alertError}`} role="alert">{closeDialog.error.message}</p>}
      </Sheet>
    </>
  );

  const listErrorAlert = listError && (
    <div className={`${ui.alert} ${ui.alertError}`} role="alert">
      <span>No se pudieron cargar los bots: {listError.message}</span>
      <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => { setListLoading(true); loadList(); }}>Reintentar</button>
    </div>
  );

  const emptyState = (
    <div className={styles.emptyState}>
      <BoltIcon size={28} />
      <p className={styles.emptyTitle}>Aún no tienes bots</p>
      <p className={styles.emptyText}>
        Un bot abre una opción cuando se dispara una de tus alertas alcistas o bajistas y la cierra con sus reglas de salida. Empieza en modo sombra, con llenados simulados.
      </p>
    </div>
  );

  const skeletons = (h) => (
    <div className={styles.skeletons} aria-busy="true" aria-label="Cargando bots">
      {[0, 1, 2].map((i) => <div key={i} className={ui.skeleton} style={{ height: h }} />)}
    </div>
  );

  // ── Móvil ────────────────────────────────────────────────────────────
  if (isMobile) {
    const last = latestSignal(bots);
    // El contrato y el límite solo llegan con el detalle (ya visto) del bot.
    const detailEntry = detail && Array.isArray(detail.pendingEntries)
      ? pendingEntryRows(detail).reduce((a, r) => (!a || (r.deadlineAt ?? Infinity) < (a.deadlineAt ?? Infinity) ? r : a), null)
      : null;
    return (
      <div className={styles.mobileRoot}>
        <PendingBanner bots={bots} entry={detailEntry ? { botId: detail.id, row: detailEntry } : null} onSelect={selectBot} />
        {last && (
          <button type="button" className={styles.lastSignal} onClick={() => selectBot(last.bot.id)}>
            <span className={styles.lastSignalLabel}>Última señal</span>
            <span className={styles.lastSignalRow}>
              <DirectionChip direction={last.signal.direction} suffix={` · ${last.bot.underlying || last.signal.asset}`} size="lg" />
              <span className={`${ui.mono} ${styles.signalTime}`}>{formatDateTime(last.signal.at)}</span>
            </span>
            <span className={styles.lastSignalText}>
              {last.bot.name} · {last.signal.decisionLabel}{last.signal.detail ? `: ${last.signal.detail}` : ''}
            </span>
          </button>
        )}
        {listErrorAlert}
        {listLoading && !bots.length && skeletons(104)}
        {!listLoading && !bots.length && !listError && emptyState}
        {bots.length > 0 && <BotList bots={bots} selectedId={selectedId} onSelect={selectBot} mobile />}
        <button type="button" className={styles.fab} onClick={() => setForm({ mode: 'create' })}>
          <PlusIcon size={20} /> Nuevo bot
        </button>
        {mobileDetailOpen && detailProps && <BotDetail {...detailProps} mobile />}
        {dialogs}
      </div>
    );
  }

  // ── Escritorio ───────────────────────────────────────────────────────
  return (
    <div className={styles.desktopRoot}>
      <aside className={styles.aside} aria-label="Bots por alertas">
        <button type="button" className={styles.newBtn} onClick={() => setForm({ mode: 'create' })}>
          <PlusIcon size={16} /> Nuevo bot
        </button>
        {listErrorAlert}
        {listLoading && !bots.length && skeletons(100)}
        {bots.length > 0 && <BotList bots={bots} selectedId={selectedId} onSelect={selectBot} />}
      </aside>
      {detailProps
        ? <BotDetail {...detailProps} />
        : (!listLoading && !listError && <section className={styles.detail}>{emptyState}</section>)}
      {dialogs}
    </div>
  );
}
