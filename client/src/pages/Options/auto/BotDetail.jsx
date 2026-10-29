import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BacktestIcon } from '../icons';
import ModeSwitch from '../strategies/ModeSwitch';
import { ChevronLeftIcon, CloseIcon, CopyIcon, PencilIcon, TrashIcon, WarningIcon } from '../strategies/common/icons';
import { isCredentialsError } from '../strategies/strategyView';
import DirectionChip from './DirectionChip';
import Mapping from './Mapping';
import SignalsFeed, { SignalFilter } from './SignalsFeed';
import LiveTpStatus from './LiveTpStatus';
import BotActivity from './BotActivity';
import { BOT_MODE_LABEL, STRUCTURE_INFO, alertMeta, botDirections, botStatus, buildBotKpis, describeParams, flowSteps } from './botView';
import { pendingEntryRows } from './botActivity';
import BotFlow from './visual/BotFlow';
import BotNowStrip from './visual/BotNowStrip';
import KpiCards from './visual/KpiCards';
import { kpiCardsModel } from './visual/visualModel';
import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';
import v from './visual/visual.module.css';

function ModeError({ error }) {
  if (!error) return null;
  return (
    <p className={`${ui.alert} ${ui.alertError}`} role="alert">
      <span>
        {error.message || 'No se pudo cambiar el modo.'}
        {isCredentialsError(error) && <> <a href="/config">Ir a Configuración</a>.</>}
      </span>
    </p>
  );
}

function ParamRows({ rows }) {
  return (
    <dl className={styles.params}>
      {rows.map((r) => (
        <div key={r.key} className={styles.paramRow}>
          <dt>{r.label}</dt>
          <dd className={r.text ? undefined : ui.mono}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// El bot fusionado trae el detalle (GET /options/strategies/:id) cuando ya
// llegó: entonces botStatus mira sus entradas, bloqueos y posiciones.
const hasDetail = (bot) => Array.isArray(bot.pendingEntries) || Array.isArray(bot.positions)
  || (bot.blockedUnderlyings && typeof bot.blockedUnderlyings === 'object');

// Entrada en curso que enseña la franja: la que vence antes.
function currentEntry(bot) {
  const rows = pendingEntryRows(bot);
  return rows.reduce((best, r) => (!best || (r.deadlineAt ?? Infinity) < (best.deadlineAt ?? Infinity) ? r : best), null);
}

const underlyingsText = (bot) => (bot.underlyings?.length ? bot.underlyings : [bot.underlying]).join(' · ');

// Menú «Probar señal ▾»: simula una señal alcista o bajista solo en sombra.
// Con varios subyacentes cada entrada lleva el suyo («Alcista · ETH»).
function SimulateMenu({ bot, onSimulate, busy, mobile }) {
  const [open, setOpen] = useState(false);
  if (!onSimulate) return null;
  const paused = bot.mode === 'paused';
  const multi = bot.underlyings?.length > 1;
  const choose = (direction, underlying) => {
    setOpen(false);
    if (multi) onSimulate(direction, underlying);
    else onSimulate(direction);
  };
  return (
    <div className={styles.simMenu} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
      <button
        type="button"
        className={`${ui.btn} ${mobile ? styles.touchBtn : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={paused || busy}
        title={paused ? 'Pasa el bot a Sombra para simular' : 'Simula una señal solo en sombra; no envía órdenes reales'}
        onClick={() => setOpen((o) => !o)}
      >
        Probar señal ▾
      </button>
      {open && !paused && (
        <div role="menu" aria-label="Probar señal" className={styles.simMenuList}>
          {(multi ? bot.underlyings : [null]).flatMap((u) => [['bullish', 'Alcista'], ['bearish', 'Bajista']].map(([dir, text]) => (
            <button
              key={`${dir}-${u}`}
              type="button"
              role="menuitem"
              className={`${ui.btn} ${styles.touchBtn}`}
              onClick={() => choose(dir, u)}
            >
              {u ? `${text} · ${u}` : text}
            </button>
          )))}
        </div>
      )}
    </div>
  );
}

function AlertRows({ alerts, onUnlink, unlinking }) {
  if (!alerts.length) return <p className={`${ui.muted} ${ui.small}`} style={{ margin: 0 }}>Sin alertas vinculadas: el bot no recibirá señales.</p>;
  return (
    <ul className={styles.linkedAlerts}>
      {alerts.map((a) => (
        <li key={a.id} className={styles.linkedAlert}>
          <span className={styles.linkedAlertMain}>
            <DirectionChip direction={a.direction} />
            <span className={styles.linkedAlertText}>
              <span className={styles.linkedAlertName}>{a.name}</span>
              {alertMeta(a) && <span className={styles.linkedAlertMeta}>{alertMeta(a)}</span>}
            </span>
          </span>
          {onUnlink && (
            <button
              type="button"
              className={ui.iconBtn}
              aria-label={`Desvincular ${a.name}`}
              title={alerts.length <= 1 ? 'Un bot necesita al menos una alerta' : 'Desvincular'}
              onClick={() => onUnlink(a.id)}
              disabled={unlinking || alerts.length <= 1}
            >
              <CloseIcon size={16} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function BotDetail({
  bot,
  signals,
  signalsFilter,
  onSignalsFilter,
  signalsLoading = false,
  signalsError = null,
  stats = null,
  mobile = false,
  modePending = null,
  modeError = null,
  loadError = null,
  unlinkError = null,
  unlinking = false,
  onModeSelect,
  onEdit,
  onClone,
  onDelete,
  cloning = false,
  onUnlink,
  onBack,
  onClosePosition,
  onCloseAll,
  onCancelOrder,
  onSimulate,
  onUnblock,
  unblocking = null,
  actionBusy = false,
  actionNotice = null,
}) {
  const kpis = useMemo(() => buildBotKpis(bot, stats), [bot, stats]);
  const desc = useMemo(() => describeParams(bot), [bot]);
  const info = STRUCTURE_INFO[bot.structure];
  const isLive = bot.mode === 'live';
  const backtestHref = `/opciones?tab=backtesting&strategyId=${encodeURIComponent(bot.id)}`;
  const p = bot.params || {};
  const activity = { bot, mobile, onClosePosition, onCloseAll, onCancelOrder, busy: actionBusy };

  const liveWarning = isLive && (
    <p className={`${ui.alert} ${ui.alertWarn}`}>
      <WarningIcon size={18} />
      <span>
        {mobile
          ? 'Envía órdenes reales a Binance cuando llega una señal. La sombra sigue corriendo.'
          : <>En modo <strong>Real</strong> el bot envía órdenes a tu cuenta de Binance cuando se dispara una de sus alertas. La sombra sigue corriendo en paralelo para comparar.</>}
      </span>
    </p>
  );
  const loadAlert = loadError && (
    <p className={`${ui.alert} ${ui.alertError}`} role="alert">No se pudo actualizar el detalle: {loadError.message}</p>
  );
  // Resultado de la última cancelación de orden (éxito o error).
  const noticeAlert = actionNotice && (
    <p className={`${ui.alert} ${actionNotice.error ? ui.alertError : ui.alertInfo}`} role={actionNotice.error ? 'alert' : 'status'}>
      {actionNotice.message}
    </p>
  );
  const unlinkAlert = unlinkError && (
    <p className={`${ui.alert} ${ui.alertError}`} role="alert">No se pudo desvincular la alerta: {unlinkError.message}</p>
  );

  const status = botStatus(bot, hasDetail(bot) ? bot : null);
  const entry = status.kind === 'pending' ? currentEntry(bot) : null;
  const blocked = Object.keys(bot.blockedUnderlyings || {});
  const kSignals = kpis.find((k) => k.key === 'signals');
  const nowStrip = (
    <BotNowStrip
      key={bot.id}
      status={status}
      entry={entry}
      blocked={blocked}
      onUnblock={onUnblock}
      unblocking={unblocking}
      unknown={bot.pendingEntryUnknown === true}
      compact={mobile}
    />
  );

  // Teléfono: estado → KPIs 2×2 → posición → flujo → cronología; debajo,
  // órdenes y límites, la configuración de la señal y la curva.
  if (mobile) {
    return (
      <div className={styles.mobileDetail} role="dialog" aria-modal="true" aria-label={bot.name}>
        <header className={styles.mobileDetailHead}>
          <button type="button" className={ui.iconBtn} onClick={onBack} aria-label="Volver">
            <ChevronLeftIcon size={22} />
          </button>
          <div className={styles.mobileDetailTitle}>
            <span className={styles.mobileDetailName}>{bot.name}</span>
            <span className={styles.mobileDetailSub}>{underlyingsText(bot)} · {info.shorter}</span>
          </div>
          <Link to={backtestHref} className={`${ui.iconBtn} ${styles.touchBtn}`} aria-label="Backtestear este bot">
            <BacktestIcon size={20} />
          </Link>
          <button type="button" className={ui.iconBtn} onClick={onClone} disabled={cloning} aria-label="Clonar bot">
            <CopyIcon size={20} />
          </button>
          <button type="button" className={ui.iconBtn} onClick={onDelete} aria-label="Eliminar bot">
            <TrashIcon size={20} />
          </button>
        </header>
        <div className={styles.mobileDetailBody}>
          <ModeSwitch value={bot.mode} onSelect={onModeSelect} disabled={!!modePending} pending={modePending} labels={BOT_MODE_LABEL} block />
          <ModeError error={modeError} />
          {liveWarning}
          {loadAlert}
          {noticeAlert}
          {nowStrip}
          <KpiCards model={kpiCardsModel(bot)} compact />
          <LiveTpStatus bot={bot} />
          <BotActivity {...activity} part="positions" />
          <section className={`${styles.mobileSection} ${styles.mobileCard}`} aria-label="Regla del bot">
            <BotFlow steps={flowSteps(bot)} directions={botDirections(bot.alerts)} compact />
            <div className={styles.mobileActions}>
              <button type="button" className={`${ui.btn} ${styles.touchBtn}`} onClick={onEdit}>
                <PencilIcon size={18} /> Alertas, salidas y riesgo
              </button>
              <SimulateMenu key={bot.id} bot={bot} onSimulate={onSimulate} busy={actionBusy} mobile />
            </div>
          </section>
          <section className={styles.mobileSection}>
            <div className={styles.sectionHead}>
              <h2 className={styles.mobileH2}>Señales y decisiones</h2>
            </div>
            {stats && (
              <p className={styles.signalsStats}>
                <span>{kSignals.value} señales en 30 d</span> · <span>{kSignals.hint}</span> · <span>{stats.traded} operadas</span>
              </p>
            )}
            <SignalFilter value={signalsFilter} onChange={onSignalsFilter} />
            <div className={styles.mobileCard}>
              <SignalsFeed signals={signals} filter={signalsFilter} loading={signalsLoading} error={signalsError} mobile />
            </div>
          </section>
          <BotActivity {...activity} part="orders" />
          <section className={styles.mobileSection}>
            <h2 className={styles.mobileH2}>Al recibir la señal</h2>
            <span className={styles.structurePill}>{info.label}</span>
            <Mapping structure={bot.structure} targetDelta={p.targetDelta} expiryDays={p.expiryDays} alerts={bot.alerts} compact />
            <AlertRows alerts={bot.alerts} />
          </section>
          <BotActivity {...activity} part="bottom" />
        </div>
      </div>
    );
  }

  return (
    <section className={styles.detail} aria-label="Detalle del bot">
      <div className={`${ui.panel} ${styles.detailHead}`}>
        <div className={styles.detailHeadRow}>
          <div className={styles.detailTitle}>
            <div className={styles.titleRow}>
              <h2 className={styles.h2}>{bot.name}</h2>
              <span className={`${v.pill} ${v[`pill_${bot.mode}`] || ''}`}>{isLive ? '● ' : ''}{BOT_MODE_LABEL[bot.mode] || bot.mode}</span>
            </div>
            <span className={ui.muted} style={{ fontSize: 13 }}>
              Opera {underlyingsText(bot)} cuando se dispara una de sus alertas · {info.short}
              {bot.status ? ` · ${bot.statusLabel}` : ''}
            </span>
          </div>
          <div className={styles.detailActions}>
            <ModeSwitch value={bot.mode} onSelect={onModeSelect} disabled={!!modePending} pending={modePending} labels={BOT_MODE_LABEL} />
            <Link to={backtestHref} className={ui.btn} title="Simula este bot con las alertas históricas">
              <BacktestIcon size={16} /> Backtestear
            </Link>
            <button type="button" className={ui.iconBtn} onClick={onEdit} aria-label="Editar bot" title="Editar">
              <PencilIcon size={18} />
            </button>
            <button type="button" className={ui.iconBtn} onClick={onClone} disabled={cloning} aria-label="Clonar bot" title="Clonar (se crea en sombra)">
              <CopyIcon size={18} />
            </button>
            <button type="button" className={ui.iconBtn} onClick={onDelete} aria-label="Eliminar bot" title="Eliminar">
              <TrashIcon size={18} />
            </button>
          </div>
        </div>
        <BotFlow steps={flowSteps(bot)} directions={botDirections(bot.alerts)} />
      </div>

      <ModeError error={modeError} />
      {liveWarning}
      {loadAlert}
      {noticeAlert}
      <LiveTpStatus bot={bot} />

      {nowStrip}

      <KpiCards model={kpiCardsModel(bot)} />

      <div className={styles.grid2}>
        <BotActivity {...activity} part="positions" />
        <div className={`${ui.panel} ${styles.signalsPanel}`}>
          <div className={ui.panelHead}>
            <h3 className={ui.h3}>Señales</h3>
            <SignalFilter value={signalsFilter} onChange={onSignalsFilter} />
          </div>
          {stats && (
            <p className={styles.signalsStats}>
              <span>{kSignals.value} señales en 30 d</span> · <span>{kSignals.hint}</span> · <span>{stats.traded} operadas</span>
            </p>
          )}
          <div className={styles.signalsScroll}>
            <SignalsFeed signals={signals} filter={signalsFilter} loading={signalsLoading} error={signalsError} />
          </div>
        </div>
      </div>

      <BotActivity {...activity} part="orders" />

      <div className={styles.twoCol}>
        <div className={`${ui.panel} ${styles.col}`}>
          <div className={ui.panelHead}>
            <h3 className={ui.h3}>1 · Señales (alertas)</h3>
            <Link to="/alertas" className={styles.textLink}>Ir a Alertas</Link>
          </div>
          {unlinkAlert}
          <AlertRows alerts={bot.alerts} onUnlink={onUnlink} unlinking={unlinking} />
          <div className={styles.simRow}>
            <button type="button" className={ui.btn} onClick={onEdit}>Vincular alerta…</button>
            <SimulateMenu key={bot.id} bot={bot} onSimulate={onSimulate} busy={actionBusy} />
          </div>
          <p className={styles.note}>
            Solo se listan alertas alcistas o bajistas cuyo activo tiene opciones en Binance (BTC, ETH, BNB, SOL, XRP, DOGE). Las neutrales no operan.
          </p>
        </div>
        <div className={`${ui.panel} ${styles.colWide}`}>
          <div className={ui.panelHead}>
            <h3 className={ui.h3}>2 · Qué hacer con la señal</h3>
            <span className={styles.structurePill}>{info.label}</span>
          </div>
          <Mapping structure={bot.structure} targetDelta={p.targetDelta} expiryDays={p.expiryDays} alerts={bot.alerts} />
          <ParamRows rows={desc.entry} />
        </div>
      </div>

      <div className={styles.twoCol}>
        <div className={`${ui.panel} ${styles.col}`}>
          <h3 className={ui.h3}>3 · Salidas</h3>
          <ParamRows rows={desc.exits} />
        </div>
        <div className={`${ui.panel} ${styles.col}`}>
          <h3 className={ui.h3}>4 · Riesgo</h3>
          <ParamRows rows={desc.risk} />
        </div>
      </div>

      <BotActivity {...activity} part="bottom" />
    </section>
  );
}
