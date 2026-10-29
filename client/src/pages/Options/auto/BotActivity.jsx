import { useMemo } from 'react';
import { ChartLegend } from '../strategies/common/LineChart';
import PnlChart from '../strategies/common/PnlChart';
import { formatDateTime, formatNumber, formatPct, formatUsdt } from '../strategies/common/format';
import { buildEquity } from '../strategies/strategyView';
import { WarningIcon } from '../strategies/common/icons';
import { closedTradeRows, openPositionRows, pendingOrderRows, usageRows } from './botActivity';
import { COMMON_DEFAULTS } from './botView';
import { DirectionGlyph } from './DirectionChip';
import PositionRange from './visual/PositionRange';
import { contractShort } from './visual/visualModel';
import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';
import v from './visual/visual.module.css';

const LEGEND = [
  { label: 'Sombra', variant: 'primary' },
  { label: 'Real', variant: 'live', dashed: true },
];

const price = (v) => (v === null || v === undefined ? '—' : formatNumber(v, { decimals: 4, minDecimals: 2 }));
const usdt = (v) => (v === null || v === undefined ? '—' : `${formatUsdt(v)} USDT`);
const tpPctText = (r) => (r.tpPct === null ? '' : ` (${formatPct(r.tpPct, { sign: true })})`);
const pnl = (v) => (v === null || v === undefined ? '—' : `${formatUsdt(v, { sign: true })} USDT`);
const toneClass = (t) => ui[`tone_${t === 'neutral' ? 'muted' : t}`];
const ICON_BTN = `${ui.btn} ${ui.btnSmall}`;

function Section({ title, actions, children, mobile }) {
  return (
    <section className={mobile ? styles.mobileSection : `${ui.panel} ${styles.activityPanel}`}>
      <div className={styles.sectionHead}>
        {mobile ? <h2 className={styles.mobileH2}>{title}</h2> : <h3 className={ui.h3}>{title}</h3>}
        {actions}
      </div>
      {children}
    </section>
  );
}

// Banda ATR: sin stop; muestra el objetivo fijado al llenarse y su cálculo.
function AtrTarget({ row }) {
  return (
    <div className={styles.atrTarget}>
      <span><strong>Objetivo {price(row.tpPrice)}{tpPctText(row)}</strong> · sin stop</span>
      <span className={`${ui.muted} ${ui.small}`}>{row.tpBreakdown}</span>
    </div>
  );
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const pad = (n) => String(n).padStart(2, '0');
// «24 oct 08:00 UTC»: los vencimientos de Binance son a las 08:00 UTC.
const utcText = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};
const hoursText = (h) => (h >= 48 ? `${Math.round(h / 24)} d` : `${h} h`);
const round2 = (n) => Math.round(n * 100) / 100;

// Estado del TP residente de una posición real (por positionId).
function tpFact(bot, row) {
  if (bot.mode !== 'live') return { label: 'TP', value: 'Simulado', tone: 'muted' };
  const orders = (Array.isArray(bot.takeProfitOrders) ? bot.takeProfitOrders : [])
    .filter((o) => o && o.positionId === row.id && o.status !== 'final');
  const label = 'TP en Binance';
  if (!orders.length) return { label, value: 'Sin TP', tone: 'warn' };
  if (orders.some((o) => o.status === 'attention')) return { label, value: 'Revisar', tone: 'neg' };
  if (orders.some((o) => o.cancelRequested)) return { label, value: 'Cancelando', tone: 'warn' };
  if (orders.some((o) => ['queued', 'sending'].includes(o.status))) return { label, value: 'Por confirmar', tone: 'warn' };
  return { label, value: 'GTC activo', tone: 'pos' };
}

// Tiempo de la posición: % consumido entre la ejecución y el vencimiento,
// la franja final desde la primera salida por tiempo (antes del vencimiento
// o tiempo máximo en posición) y el texto de esa salida.
function expiryModel(row, bot, now) {
  const atr = bot?.params?.takeProfitMode === 'atr_band';
  const exitH = atr ? 0 : toNumberOr(bot?.params?.exitHoursBeforeExpiry, COMMON_DEFAULTS.exitHoursBeforeExpiry);
  const maxHold = toNumberOr(bot?.params?.maxHoldMinutes, null);
  const opened = toNumberOr(row.openedAt, null);
  const expiryCut = row.expiresAt !== null && exitH > 0 ? row.expiresAt - exitH * 3600e3 : null;
  const holdCut = maxHold > 0 && opened !== null ? opened + maxHold * 60e3 : null;
  const byHold = holdCut !== null && (expiryCut === null || holdCut <= expiryCut);
  const cut = byHold ? holdCut : expiryCut;
  const leftH = cut === null ? null : Math.round((cut - now) / 3600e3);
  const what = byHold ? 'cierre por tiempo máx.' : 'salida por tiempo';
  const exitText = cut === null
    ? (atr ? 'sin salida por tiempo' : '')
    : cut > now ? `${what} en ${leftH >= 1 ? hoursText(leftH) : `${Math.max(1, Math.round((cut - now) / 60e3))} min`}` : `${what} en curso`;
  const life = opened !== null && row.expiresAt !== null ? row.expiresAt - opened : null;
  const clamp = (x) => Math.min(100, Math.max(0, x));
  const elapsed = life > 0 ? clamp(((now - opened) / life) * 100) : null;
  const exitPct = life > 0 && cut !== null ? clamp(((row.expiresAt - cut) / life) * 100) : 0;
  // Se tiñe al acercarse al límite efectivo: la salida por tiempo o el vencimiento.
  const used = elapsed === null ? null : exitPct < 100 ? (elapsed / (100 - exitPct)) * 100 : 100;
  const tone = used === null ? null : used >= 90 ? 'neg' : used >= 70 ? 'warn' : 'ok';
  return { exitText, elapsed, exitPct, tone };
}

function ExpiryBar({ model: { elapsed, exitPct, tone } }) {
  if (elapsed === null) return null;
  return (
    <div className={v.expiry} role="img" aria-label={`Transcurrido ${Math.round(elapsed)} % de la vida de la opción`}>
      <i className={`${v.expiryElapsed} ${v[`expiry_${tone}`]}`} style={{ width: `${elapsed}%` }} />
      {exitPct > 0 && <i className={v.expiryExit} style={{ width: `${exitPct}%` }} />}
    </div>
  );
}

function Expiry({ row, bot, now }) {
  if (row.expiresAt === null) return null;
  const model = expiryModel(row, bot, now);
  return (
    <>
      <div className={v.split}><span>Vencimiento {utcText(row.expiresAt)}</span><span>{model.exitText}</span></div>
      <ExpiryBar model={model} />
    </>
  );
}

// Móvil: barra de tiempo consumido bajo «vence en», con el % y la salida.
function MobileExpiry({ row, bot, now }) {
  if (row.expiresAt === null) return null;
  const model = expiryModel(row, bot, now);
  if (model.elapsed === null) return null;
  return (
    <div className={styles.posTime}>
      <ExpiryBar model={model} />
      <div className={v.split}>
        <span className={model.tone === 'ok' ? undefined : toneClass(model.tone)}>Consumido {Math.round(model.elapsed)} % del tiempo</span>
        <span>{model.exitText}</span>
      </div>
    </div>
  );
}

function toNumberOr(x, fallback) {
  const n = x === null || x === undefined || x === '' ? NaN : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// P&L a mercado menos las comisiones ya pagadas, y su % sobre la prima.
function netPnl(row) {
  const net = row.pnlUsdt === null ? null : round2(row.pnlUsdt - (row.feesUsdt ?? 0));
  return { net, pct: net !== null && row.premiumUsdt ? (net / row.premiumUsdt) * 100 : null };
}

// Tarjeta de posición (teléfono): contrato y P&L neto, barra compacta
// stop–entrada–ahora–TP, comisiones y vencimiento, y «Cerrar» a todo ancho.
function MobilePositionCard({ row: r, bot, now, multi, onClosePosition, busy }) {
  const { net, pct } = netPnl(r);
  const legend = [r.stopPrice !== null ? `Stop ${price(r.stopPrice)}` : null, r.tpPrice !== null ? `TP ${price(r.tpPrice)}${tpPctText(r)}` : null].filter(Boolean).join(' · ');
  const hasRange = r.tpPrice !== null && (r.stopPrice !== null || r.entry !== null);
  return (
    <li className={`${styles.activityCard} ${styles.posCardMobile}`}>
      <div className={v.posTop}>
        <span className={v.posSym}>
          {contractShort(r.symbol)} · {formatNumber(r.quantity, { decimals: 4, minDecimals: 0 })}
          {multi && <span className={styles.underlyingTag}>{String(r.symbol).split('-')[0]}</span>}
        </span>
        <span className={`${v.posPnl} ${toneClass(r.tone)}`}>
          {net === null ? '—' : `${formatUsdt(net, { sign: true })} neto`}
          {pct !== null && <small> {formatPct(pct, { sign: true })}</small>}
        </span>
      </div>
      <div className={styles.posSymbolLine}>
        <span className={ui.mono}>{r.symbol}</span>
        <span>{r.sideLabel}</span>
      </div>
      {hasRange && <PositionRange stop={r.stopPrice} entry={r.entry} mark={r.mark} tp={r.tpPrice} compact />}
      {r.tpBreakdown !== null
        ? <AtrTarget row={r} />
        : legend && <span className={styles.posLegend}>{legend}</span>}
      <div className={v.split}>
        <span>Comisiones <b className={v.t_fee}>{r.feesUsdt === null ? '—' : formatUsdt(r.feesUsdt)}</b></span>
        {r.hoursToExpiry !== null && <span>vence en {hoursText(r.hoursToExpiry)}</span>}
      </div>
      <MobileExpiry row={r} bot={bot} now={now} />
      <div className={`${ui.muted} ${ui.small}`}>
        Entrada {price(r.entry)} · Mark {price(r.mark)} · Prima {usdt(r.premiumUsdt)} · ejecutada {formatDateTime(r.openedAt)}
      </div>
      {onClosePosition && (
        <button type="button" className={`${ui.btn} ${styles.touchBtn} ${styles.posCloseMobile}`} aria-label={`Cerrar ${r.symbol}`} onClick={() => onClosePosition(r.id)} disabled={busy}>
          Cerrar
        </button>
      )}
    </li>
  );
}

// Tarjeta de posición (escritorio): barra stop–entrada–ahora–TP, hechos,
// vencimiento y P&L neto de comisiones.
function PositionCard({ row, bot, count, onClosePosition, busy, now }) {
  const type = /-C$/.test(row.symbol || '') ? 'Call' : /-P$/.test(row.symbol || '') ? 'Put' : 'Opción';
  const sell = row.sideLabel === 'Vender';
  const bullish = (type === 'Call') !== sell;
  const { net, pct: netPct } = netPnl(row);
  const usage = bot.usage || {};
  const delta = usage.mode === undefined || usage.mode === (bot.mode === 'live' ? 'live' : 'shadow') ? usage.netDelta : null;
  const tp = tpFact(bot, row);
  return (
    <div className={v.pos}>
      <div className={v.posTop}>
        <span className={`${v.pill} ${bullish ? v.pill_up : v.pill_down}`}>
          <DirectionGlyph direction={bullish ? 'bullish' : 'bearish'} size={9} /> {type} · {sell ? 'vendida' : 'comprada'}
        </span>
        <span className={v.posSym}><span>{row.symbol}</span> · {formatNumber(row.quantity, { decimals: 4, minDecimals: 0 })}</span>
        <span className={`${v.posPnl} ${toneClass(row.tone)}`}>
          {net === null ? '—' : `${formatUsdt(net, { sign: true })} USDT neto`}{netPct !== null ? ` (${formatPct(netPct, { sign: true })})` : ''}
        </span>
      </div>
      <PositionRange stop={row.stopPrice} entry={row.entry} mark={row.mark} tp={row.tpPrice} />
      {row.tpBreakdown !== null && <span className={`${ui.muted} ${ui.small}`}>{row.tpBreakdown}</span>}
      <div className={v.facts}>
        <div className={v.fact}><span>{sell ? 'Prima cobrada' : 'Prima pagada'}</span><b>{row.premiumUsdt === null ? '—' : formatUsdt(row.premiumUsdt)}</b></div>
        <div className={v.fact}><span>Comisiones</span><b className={v.t_fee}>{row.feesUsdt === null ? '—' : formatUsdt(row.feesUsdt)}</b></div>
        <div className={v.fact}><span>{count > 1 ? 'Δ neta del bot' : 'Δ posición'}</span><b>{delta === null || delta === undefined ? '—' : formatNumber(delta, { decimals: 3, sign: true })}</b></div>
        <div className={v.fact}><span>{tp.label}</span><b className={v[`t_${tp.tone}`]}>{tp.value}</b></div>
      </div>
      <Expiry row={row} bot={bot} now={now} />
      <div className={v.posFoot}>
        <span>Ejecutada {formatDateTime(row.openedAt)} · entrada {price(row.entry)} · mark {price(row.mark)}</span>
        <CloseBtn row={row} onClosePosition={onClosePosition} busy={busy} />
      </div>
    </div>
  );
}

function CloseBtn({ row, onClosePosition, busy }) {
  if (!onClosePosition) return null;
  return (
    <button type="button" className={`${ICON_BTN} ${styles.touchBtn}`} aria-label={`Cerrar ${row.symbol}`} onClick={() => onClosePosition(row.id)} disabled={busy}>
      Cerrar
    </button>
  );
}

function Positions({ rows, bot, mobile, multi, onClosePosition, onCloseAll, busy }) {
  const now = Date.now();
  const closeAll = onCloseAll && rows.length > 0 && (
    <button type="button" className={`${ICON_BTN} ${styles.touchBtn}`} onClick={() => onCloseAll()} disabled={busy}>Cerrar todo</button>
  );
  return (
    <Section title={!mobile && rows.length === 1 ? 'Posición abierta' : 'Posiciones abiertas'} actions={closeAll} mobile={mobile}>
      {!rows.length && <p className={ui.empty}>Sin posiciones abiertas</p>}
      {rows.length > 0 && mobile && (
        <ul className={styles.activityList}>
          {rows.map((r) => (
            <MobilePositionCard key={r.id} row={r} bot={bot} now={now} multi={multi} onClosePosition={onClosePosition} busy={busy} />
          ))}
        </ul>
      )}
      {rows.length > 0 && !mobile && rows.map((r) => (
        <PositionCard key={r.id} row={r} bot={bot} count={rows.length} onClosePosition={onClosePosition} busy={busy} now={now} />
      ))}
    </Section>
  );
}

function Attention({ row }) {
  if (!row.needsAttention) return <span>{row.status}</span>;
  return (
    <span className={`${styles.attention} ${ui.tone_neg}`}><WarningIcon size={14} /> {row.status}</span>
  );
}

function CancelBtn({ row, onCancelOrder, busy }) {
  if (!onCancelOrder) return null;
  if (row.cancelRequested) return <span className={`${ui.muted} ${ui.small}`}>Cancelación solicitada</span>;
  if (!row.cancellable) return null;
  return (
    <button type="button" className={`${ICON_BTN} ${styles.touchBtn}`} aria-label={`Cancelar orden ${row.id}`} onClick={() => onCancelOrder(row.id)} disabled={busy}>
      Cancelar
    </button>
  );
}

function PendingOrders({ rows, mobile, onCancelOrder, busy }) {
  if (!rows.length) return null;
  return (
    <Section title="Órdenes pendientes" mobile={mobile}>
      {mobile ? (
        <ul className={styles.activityList}>
          {rows.map((o) => (
            <li key={o.id} className={styles.activityRow}>
              <div className={styles.activityRowMain}>
                <span className={ui.mono}>{o.symbol}</span>
                <span className={`${ui.muted} ${ui.small}`}>
                  {o.kindLabel} · {o.sideLabel} a {price(o.price)} · {o.filled}{o.expiresIn ? ` · vence ${o.expiresIn}` : ''}
                </span>
                <Attention row={o} />
              </div>
              <CancelBtn row={o} onCancelOrder={onCancelOrder} busy={busy} />
            </li>
          ))}
        </ul>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Tipo</th><th>Símbolo</th><th>Lado</th><th className={ui.num}>Precio</th>
                <th className={ui.num}>Llenado</th><th>Estado</th><th className={ui.num}>Vence</th>{onCancelOrder && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td>{o.kindLabel}</td>
                  <td className={ui.mono}>{o.symbol}</td>
                  <td>{o.sideLabel}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{price(o.price)}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{o.filled}</td>
                  <td><Attention row={o} /></td>
                  <td className={`${ui.mono} ${ui.num}`}>{o.expiresIn || '—'}</td>
                  {onCancelOrder && <td className={ui.num}><CancelBtn row={o} onCancelOrder={onCancelOrder} busy={busy} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Usage({ rows, mobile }) {
  return (
    <Section title="Uso de límites" mobile={mobile}>
      <ul className={styles.usageList}>
        {rows.map((r) => (
          <li key={r.label} className={styles.usageItem}>
            <div className={styles.usageHead}>
              <span>{r.label}</span>
              <span className={ui.mono}>
                {r.text ?? `${formatNumber(r.used, { decimals: 2, minDecimals: 0 })} / ${r.max === null ? '—' : formatNumber(r.max, { decimals: 2, minDecimals: 0 })}`}
              </span>
            </div>
            <div
              className={styles.usageTrack}
              role="progressbar"
              aria-label={r.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={r.pct === null ? undefined : Math.round(r.pct)}
            >
              <span className={`${styles.usageFill} ${r.pct !== null && r.pct >= 90 ? styles.usageFillHot : ''}`} style={{ width: `${r.pct ?? 0}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ClosedTrades({ rows, mobile }) {
  return (
    <Section title="Operaciones cerradas" mobile={mobile}>
      {!rows.length && <p className={ui.empty}>Todavía no hay operaciones cerradas.</p>}
      {rows.length > 0 && mobile && (
        <ul className={styles.activityList}>
          {rows.map((r) => (
            <li key={r.id} className={styles.activityRow}>
              <div className={styles.activityRowMain}>
                <span className={ui.mono}>{r.symbol}</span>
                <span className={`${ui.muted} ${ui.small}`}>{r.reasonLabel} · {formatDateTime(r.closedAt)}</span>
              </div>
              <span className={`${ui.mono} ${toneClass(r.pnlUsdt > 0 ? 'pos' : r.pnlUsdt < 0 ? 'neg' : 'neutral')}`}>{pnl(r.pnlUsdt)}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && !mobile && (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr><th>Símbolo</th><th>Abierta</th><th>Cerrada</th><th className={ui.num}>Entrada</th><th className={ui.num}>Salida</th><th className={ui.num}>P&amp;L</th><th>Motivo</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={ui.mono}>{r.symbol}</td>
                  <td className={`${ui.mono} ${ui.muted}`}>{formatDateTime(r.openedAt)}</td>
                  <td className={`${ui.mono} ${ui.muted}`}>{formatDateTime(r.closedAt)}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{price(r.entry)}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{price(r.exit)}</td>
                  <td className={`${ui.mono} ${ui.num} ${toneClass(r.pnlUsdt > 0 ? 'pos' : r.pnlUsdt < 0 ? 'neg' : 'neutral')}`}>{pnl(r.pnlUsdt)}</td>
                  <td>{r.reasonLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/**
 * Actividad del bot. `part="top"` (posiciones, órdenes, límites) va entre los
 * KPIs y las señales; `part="bottom"` (curva y operaciones cerradas) al final.
 * El escritorio parte «top» en `positions` (tarjetas con barra de rango, junto
 * a la cronología) y `orders` (órdenes pendientes y límites).
 * Sin callbacks no se pintan botones de acción; `busy` los deshabilita
 * mientras hay una petición de cierre o cancelación en curso.
 */
export default function BotActivity({ bot, mobile = false, part = 'top', onClosePosition, onCloseAll, onCancelOrder, busy = false }) {
  const mode = bot.mode === 'live' ? 'live' : 'shadow';
  const positions = useMemo(() => openPositionRows(bot, mode), [bot, mode]);
  const orders = useMemo(() => pendingOrderRows(bot), [bot]);
  const usage = useMemo(() => usageRows(bot), [bot]);
  const closed = useMemo(() => closedTradeRows(bot, mode), [bot, mode]);
  const equity = useMemo(() => buildEquity(bot.equity), [bot.equity]);

  if (part === 'bottom') {
    return (
      <>
        <section className={mobile ? styles.mobileSection : `${ui.panel} ${styles.activityPanel}`}>
          <div className={styles.sectionHead}>
            {mobile ? <h2 className={styles.mobileH2}>Curva de P&amp;L · sombra vs real</h2> : <h3 className={ui.h3}>Curva de P&amp;L · sombra vs real</h3>}
            {equity.hasLive && <ChartLegend items={LEGEND} />}
          </div>
          <PnlChart equity={equity} height={mobile ? 110 : 180} />
        </section>
        <ClosedTrades rows={closed} mobile={mobile} />
      </>
    );
  }
  const positionsPart = (
    <Positions rows={positions} bot={bot} mobile={mobile} multi={bot.underlyings?.length > 1} onClosePosition={onClosePosition} onCloseAll={onCloseAll} busy={busy} />
  );
  const ordersPart = (
    <>
      <PendingOrders rows={orders} mobile={mobile} onCancelOrder={onCancelOrder} busy={busy} />
      <Usage rows={usage} mobile={mobile} />
    </>
  );
  if (part === 'positions') return positionsPart;
  if (part === 'orders') return ordersPart;
  return <>{positionsPart}{ordersPart}</>;
}
