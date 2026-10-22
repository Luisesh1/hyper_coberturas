import { useMemo } from 'react';
import ModeSwitch, { ModeBadge } from './ModeSwitch';
import { ChartLegend } from './common/LineChart';
import PnlChart from './common/PnlChart';
import { formatDateTime, formatDay, formatNumber, formatUsdt, tone } from './common/format';
import { formatParamValue, normalizeSchema } from './common/paramSchema';
import { ChevronLeftIcon, PencilIcon, TrashIcon, WarningIcon } from './common/icons';
import {
  buildEquity, buildKpis, buildLimits, isCredentialsError, normalizeEvents, openLegs, templateLabel,
} from './strategyView';
import ui from './common/ui.module.css';
import styles from './StrategiesTab.module.css';

const LEGEND = [
  { label: 'Sombra', variant: 'primary' },
  { label: 'Real', variant: 'live', dashed: true },
];

function EventsTable({ events }) {
  if (!events.length) return <p className={ui.empty}>Todavía no hay decisiones registradas.</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr><th>Hora</th><th>Modo</th><th>Decisión</th><th>Detalle</th><th className={ui.num}>Prima</th></tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className={`${ui.mono} ${ui.muted}`} style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.at)}</td>
              <td><ModeBadge mode={e.mode} /></td>
              <td className={`${styles.eventAction} ${e.action === 'error' ? ui.tone_neg : ''}`}>{e.actionLabel}</td>
              <td className={styles.eventDetail}>{e.detail}</td>
              <td className={`${ui.mono} ${ui.num} ${ui[`tone_${tone(e.premium) === 'neutral' ? 'muted' : tone(e.premium)}`]}`}>
                {e.premium === null ? '—' : formatUsdt(e.premium, { sign: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventCards({ events }) {
  if (!events.length) return <p className={ui.empty}>Todavía no hay decisiones registradas.</p>;
  return (
    <ul className={styles.eventCards}>
      {events.map((e) => (
        <li key={e.id} className={styles.eventCard}>
          <span className={styles.eventCardTop}>
            <span className={`${styles.eventAction} ${e.action === 'error' ? ui.tone_neg : ''}`}>
              {e.actionLabel} <ModeBadge mode={e.mode} />
            </span>
            <span className={`${ui.mono} ${styles.eventTime}`}>{formatDateTime(e.at)}</span>
          </span>
          {(e.detail || e.premium !== null) && (
            <span className={styles.eventCardDetail}>
              {e.detail}
              {e.premium !== null && (
                <>
                  {e.detail ? ' · ' : ''}
                  <span className={`${ui.mono} ${ui[`tone_${tone(e.premium) === 'neutral' ? 'muted' : tone(e.premium)}`]}`}>
                    {formatUsdt(e.premium, { sign: true })}
                  </span>
                </>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Legs({ legs }) {
  if (!legs.length) return <p className={`${ui.muted} ${ui.small}`} style={{ margin: 0 }}>Sin patas abiertas.</p>;
  return (
    <ul className={styles.legs}>
      {legs.map((l) => (
        <li key={l.id} className={styles.leg}>
          <span className={ui[`tone_${l.sideTone === 'neutral' ? 'muted' : l.sideTone}`]} style={{ fontWeight: 600 }}>{l.side}</span>
          <span>{l.type}</span>
          <span className={`${ui.mono} ${styles.legSymbol}`}>{l.symbol}</span>
          <span className={`${ui.mono} ${ui.muted} ${ui.num}`}>
            {l.quantity === null ? '—' : formatNumber(l.quantity, { decimals: 4, minDecimals: 0 })}
            {l.mode && <> <ModeBadge mode={l.mode} /></>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ParamsList({ schema, params }) {
  const keys = schema.length ? schema : Object.keys(params || {}).map((k) => ({ key: k, label: k, type: 'text', options: [] }));
  if (!keys.length) return <p className={`${ui.muted} ${ui.small}`} style={{ margin: 0 }}>Sin parámetros.</p>;
  return (
    <dl className={styles.params}>
      {keys.map((spec) => (
        <div key={spec.key} className={styles.paramRow}>
          <dt>{spec.label}</dt>
          <dd className={ui.mono}>{formatParamValue(spec, params?.[spec.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function Limits({ rows }) {
  if (!rows.length) {
    return <p className={`${ui.muted} ${ui.small}`} style={{ margin: 0 }}>Sin límites propios: aplican los globales de Configuración.</p>;
  }
  return rows.map((lm) => (
    <div key={lm.key} className={styles.limit}>
      <div className={styles.limitHead}><span className={ui.muted}>{lm.label}</span><span className={ui.mono}>{lm.value}</span></div>
      <div
        className={styles.limitTrack}
        role="meter"
        aria-label={lm.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(lm.pct)}
      >
        <div className={`${styles.limitBar} ${styles[`bar_${lm.bar}`]}`} style={{ width: `${lm.pct}%` }} />
      </div>
    </div>
  ));
}

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

export default function StrategyDetail({
  strategy,
  templates,
  mobile = false,
  modePending = null,
  modeError = null,
  loadError = null,
  onModeSelect,
  onEdit,
  onDelete,
  onBack,
}) {
  const template = templates.find((t) => t.id === strategy.template);
  const schema = useMemo(() => normalizeSchema(template?.paramSchema), [template]);
  const kpis = useMemo(() => buildKpis(strategy), [strategy]);
  const equity = useMemo(() => buildEquity(strategy.equity), [strategy.equity]);
  const events = useMemo(() => normalizeEvents(strategy.events), [strategy.events]);
  const legs = useMemo(() => openLegs(strategy), [strategy]);
  const limits = useMemo(() => buildLimits(strategy), [strategy]);
  const tplLabel = templateLabel(templates, strategy.template);
  const isLive = strategy.mode === 'live';

  const liveWarning = isLive && (
    <p className={`${ui.alert} ${ui.alertWarn}`}>
      <WarningIcon size={18} />
      <span>
        {mobile
          ? 'Envía órdenes reales a Binance. La sombra sigue corriendo para comparar.'
          : <>En modo <strong>Real</strong> la estrategia envía órdenes a tu cuenta de Binance. La sombra sigue corriendo en paralelo para comparar.</>}
      </span>
    </p>
  );

  const loadAlert = loadError && (
    <p className={`${ui.alert} ${ui.alertError}`} role="alert">No se pudo actualizar el detalle: {loadError.message}</p>
  );

  if (mobile) {
    return (
      <div className={styles.mobileDetail} role="dialog" aria-modal="true" aria-label={strategy.name}>
        <header className={styles.mobileDetailHead}>
          <button type="button" className={ui.iconBtn} onClick={onBack} aria-label="Volver">
            <ChevronLeftIcon size={22} />
          </button>
          <div className={styles.mobileDetailTitle}>
            <span className={styles.mobileDetailName}>{strategy.name}</span>
            <span className={styles.mobileDetailSub}>{tplLabel} · {strategy.underlying}</span>
          </div>
          <button type="button" className={ui.iconBtn} onClick={onDelete} aria-label="Eliminar estrategia">
            <TrashIcon size={20} />
          </button>
        </header>
        <div className={styles.mobileDetailBody}>
          <ModeSwitch value={strategy.mode} onSelect={onModeSelect} disabled={!!modePending} pending={modePending} block />
          <ModeError error={modeError} />
          {liveWarning}
          {loadAlert}
          <div className={ui.tileGrid}>
            {kpis.slice(0, 4).map((k) => (
              <div key={k.label} className={ui.tile}>
                <span className={ui.tileLabel}>{k.label}</span>
                <span className={`${ui.tileValue} ${ui[`tone_${k.tone}`]}`}>{k.value}</span>
              </div>
            ))}
          </div>
          <div className={ui.panel} style={{ padding: 12 }}>
            {equity.hasLive && <ChartLegend items={LEGEND} />}
            <PnlChart equity={equity} height={110} />
          </div>
          <section className={styles.mobileSection}>
            <h2 className={styles.mobileH2}>Patas y reglas</h2>
            <div className={styles.mobileBox}>
              <Legs legs={legs} />
              <ParamsList schema={schema} params={strategy.params} />
            </div>
            <button type="button" className={ui.btn} onClick={onEdit}>
              <PencilIcon size={18} /> Editar parámetros
            </button>
          </section>
          {limits.length > 0 && (
            <section className={styles.mobileSection}>
              <h2 className={styles.mobileH2}>Límites de riesgo</h2>
              <div className={styles.mobileBox}><Limits rows={limits} /></div>
            </section>
          )}
          <section className={styles.mobileSection}>
            <h2 className={styles.mobileH2}>Últimas decisiones</h2>
            <EventCards events={events.slice(0, 30)} />
          </section>
        </div>
      </div>
    );
  }

  return (
    <section className={styles.detail} aria-label="Detalle de la estrategia">
      <div className={`${ui.panel} ${styles.detailHead}`}>
        <div className={styles.detailTitle}>
          <h2 className={styles.h2}>{strategy.name}</h2>
          <span className={ui.muted} style={{ fontSize: 13 }}>
            Plantilla «{tplLabel}» · {strategy.underlying} · evalúa cada 5 min
            {strategy.status ? ` · ${strategy.status}` : ''}
          </span>
        </div>
        <div className={styles.detailActions}>
          <ModeSwitch value={strategy.mode} onSelect={onModeSelect} disabled={!!modePending} pending={modePending} />
          <button type="button" className={ui.iconBtn} onClick={onEdit} aria-label="Editar estrategia" title="Editar">
            <PencilIcon size={18} />
          </button>
          <button type="button" className={ui.iconBtn} onClick={onDelete} aria-label="Eliminar estrategia" title="Eliminar">
            <TrashIcon size={18} />
          </button>
        </div>
      </div>

      <ModeError error={modeError} />
      {liveWarning}
      {loadAlert}

      <div className={ui.kpiGrid}>
        {kpis.map((k) => (
          <div key={k.label} className={ui.kpi}>
            <span className={ui.kpiLabel}>{k.label}</span>
            <span className={`${ui.kpiValue} ${ui[`tone_${k.tone}`]}`}>{k.value}</span>
            {k.hint && <span className={ui.kpiHint}>{k.hint}</span>}
          </div>
        ))}
      </div>

      <div className={ui.panel}>
        <div className={ui.panelHead}>
          <h3 className={ui.h3}>P&amp;L acumulado · sombra vs real</h3>
          <ChartLegend items={LEGEND} />
        </div>
        <PnlChart equity={equity} height={180} />
      </div>

      <div className={styles.twoCol}>
        <div className={`${ui.panel} ${styles.colWide}`}>
          <h3 className={ui.h3}>Patas</h3>
          <Legs legs={legs} />
          <h3 className={ui.h3} style={{ marginTop: 4 }}>Parámetros</h3>
          <ParamsList schema={schema} params={strategy.params} />
        </div>
        <div className={`${ui.panel} ${styles.colNarrow}`}>
          <h3 className={ui.h3}>Límites de riesgo</h3>
          <Limits rows={limits} />
          <h3 className={ui.h3} style={{ marginTop: 4 }}>Simulación de ejecución (sombra)</h3>
          <p className={styles.prose}>
            Llena al lado contrario del libro (ask al comprar, bid al vender) con la profundidad real de ese momento, más la comisión de Binance.
          </p>
        </div>
      </div>

      <div className={`${ui.panel} ${ui.panelFlush}`}>
        <div className={ui.panelHead}>
          <h3 className={ui.h3}>Registro de decisiones</h3>
          {events.length > 0 && <span className={`${ui.muted} ${ui.small}`}>Últimas {events.length} · desde {formatDay(events[events.length - 1].at)}</span>}
        </div>
        <EventsTable events={events} />
      </div>
    </section>
  );
}
