import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import ModeSwitch from '../strategies/ModeSwitch';
import { ChevronLeftIcon, CloseIcon, PencilIcon, TrashIcon, WarningIcon } from '../strategies/common/icons';
import { isCredentialsError } from '../strategies/strategyView';
import DirectionChip from './DirectionChip';
import Mapping from './Mapping';
import SignalsFeed, { SignalFilter } from './SignalsFeed';
import LiveTpStatus from './LiveTpStatus';
import BotActivity from './BotActivity';
import { BOT_MODE_LABEL, STRUCTURE_INFO, alertMeta, buildBotKpis, describeParams } from './botView';
import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';

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
  onDelete,
  onUnlink,
  onBack,
  onClosePosition,
  onCloseAll,
  onCancelOrder,
}) {
  const kpis = useMemo(() => buildBotKpis(bot, stats), [bot, stats]);
  const desc = useMemo(() => describeParams(bot), [bot]);
  const info = STRUCTURE_INFO[bot.structure];
  const isLive = bot.mode === 'live';
  const p = bot.params || {};
  const activity = { bot, mobile, onClosePosition, onCloseAll, onCancelOrder };

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
  const unlinkAlert = unlinkError && (
    <p className={`${ui.alert} ${ui.alertError}`} role="alert">No se pudo desvincular la alerta: {unlinkError.message}</p>
  );

  if (mobile) {
    const kSignals = kpis.find((k) => k.key === 'signals');
    const kTraded = kpis.find((k) => k.key === 'traded');
    const kPnl = kpis.find((k) => k.key === (isLive ? 'pnlLive' : 'pnlShadow'));
    return (
      <div className={styles.mobileDetail} role="dialog" aria-modal="true" aria-label={bot.name}>
        <header className={styles.mobileDetailHead}>
          <button type="button" className={ui.iconBtn} onClick={onBack} aria-label="Volver">
            <ChevronLeftIcon size={22} />
          </button>
          <div className={styles.mobileDetailTitle}>
            <span className={styles.mobileDetailName}>{bot.name}</span>
            <span className={styles.mobileDetailSub}>{bot.underlying} · {info.shorter}</span>
          </div>
          <button type="button" className={ui.iconBtn} onClick={onDelete} aria-label="Eliminar bot">
            <TrashIcon size={20} />
          </button>
        </header>
        <div className={styles.mobileDetailBody}>
          <ModeSwitch value={bot.mode} onSelect={onModeSelect} disabled={!!modePending} pending={modePending} labels={BOT_MODE_LABEL} block />
          <ModeError error={modeError} />
          {liveWarning}
          {loadAlert}
          <LiveTpStatus bot={bot} />
          <div className={ui.tileGrid}>
            <div className={ui.tile}>
              <span className={ui.tileLabel}>Señales 30d</span>
              <span className={`${ui.tileValue} ${ui.tone_neutral}`}>
                {kSignals.value}{stats ? ` · ${kTraded.value} operadas` : ''}
              </span>
            </div>
            <div className={ui.tile}>
              <span className={ui.tileLabel}>{kPnl.label}</span>
              <span className={`${ui.tileValue} ${ui[`tone_${kPnl.tone}`]}`}>{kPnl.value}</span>
            </div>
          </div>
          <BotActivity {...activity} part="top" />
          <section className={styles.mobileSection}>
            <h2 className={styles.mobileH2}>Al recibir la señal</h2>
            <span className={styles.structurePill}>{info.label}</span>
            <Mapping structure={bot.structure} targetDelta={p.targetDelta} expiryDays={p.expiryDays} compact />
            <AlertRows alerts={bot.alerts} />
            <button type="button" className={ui.btn} onClick={onEdit}>
              <PencilIcon size={18} /> Alertas, salidas y riesgo
            </button>
          </section>
          <section className={styles.mobileSection}>
            <div className={styles.sectionHead}>
              <h2 className={styles.mobileH2}>Señales y decisiones</h2>
            </div>
            <SignalFilter value={signalsFilter} onChange={onSignalsFilter} />
            <SignalsFeed signals={signals} filter={signalsFilter} loading={signalsLoading} error={signalsError} mobile />
          </section>
          <BotActivity {...activity} part="bottom" />
        </div>
      </div>
    );
  }

  return (
    <section className={styles.detail} aria-label="Detalle del bot">
      <div className={`${ui.panel} ${styles.detailHead}`}>
        <div className={styles.detailTitle}>
          <h2 className={styles.h2}>{bot.name}</h2>
          <span className={ui.muted} style={{ fontSize: 13 }}>
            Opera {bot.underlying} cuando se dispara una de sus alertas · {info.short}
            {bot.status ? ` · ${bot.status}` : ''}
          </span>
        </div>
        <div className={styles.detailActions}>
          <ModeSwitch value={bot.mode} onSelect={onModeSelect} disabled={!!modePending} pending={modePending} labels={BOT_MODE_LABEL} />
          <button type="button" className={ui.iconBtn} onClick={onEdit} aria-label="Editar bot" title="Editar">
            <PencilIcon size={18} />
          </button>
          <button type="button" className={ui.iconBtn} onClick={onDelete} aria-label="Eliminar bot" title="Eliminar">
            <TrashIcon size={18} />
          </button>
        </div>
      </div>

      <ModeError error={modeError} />
      {liveWarning}
      {loadAlert}
      <LiveTpStatus bot={bot} />

      <div className={ui.kpiGrid}>
        {kpis.map((k) => (
          <div key={k.key} className={ui.kpi}>
            <span className={ui.kpiLabel}>{k.label}</span>
            <span className={`${ui.kpiValue} ${ui[`tone_${k.tone}`]}`}>{k.value}</span>
            {k.hint && <span className={ui.kpiHint}>{k.hint}</span>}
          </div>
        ))}
      </div>

      <BotActivity {...activity} part="top" />

      <div className={styles.twoCol}>
        <div className={`${ui.panel} ${styles.col}`}>
          <div className={ui.panelHead}>
            <h3 className={ui.h3}>1 · Señales (alertas)</h3>
            <Link to="/alertas" className={styles.textLink}>Ir a Alertas</Link>
          </div>
          {unlinkAlert}
          <AlertRows alerts={bot.alerts} onUnlink={onUnlink} unlinking={unlinking} />
          <button type="button" className={ui.btn} onClick={onEdit}>Vincular alerta…</button>
          <p className={styles.note}>
            Solo se listan alertas alcistas o bajistas cuyo activo tiene opciones en Binance (BTC, ETH, BNB, SOL, XRP, DOGE). Las neutrales no operan.
          </p>
        </div>
        <div className={`${ui.panel} ${styles.colWide}`}>
          <div className={ui.panelHead}>
            <h3 className={ui.h3}>2 · Qué hacer con la señal</h3>
            <span className={styles.structurePill}>{info.label}</span>
          </div>
          <Mapping structure={bot.structure} targetDelta={p.targetDelta} expiryDays={p.expiryDays} />
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

      <div className={`${ui.panel} ${ui.panelFlush}`}>
        <div className={ui.panelHead}>
          <h3 className={ui.h3}>Señales recibidas y decisiones</h3>
          <SignalFilter value={signalsFilter} onChange={onSignalsFilter} />
        </div>
        <SignalsFeed signals={signals} filter={signalsFilter} loading={signalsLoading} error={signalsError} />
      </div>

      <BotActivity {...activity} part="bottom" />
    </section>
  );
}
