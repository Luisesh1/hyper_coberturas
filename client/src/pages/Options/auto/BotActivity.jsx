import { Fragment, useMemo } from 'react';
import { ChartLegend } from '../strategies/common/LineChart';
import PnlChart from '../strategies/common/PnlChart';
import { formatDateTime, formatNumber, formatPct, formatUsdt } from '../strategies/common/format';
import { buildEquity } from '../strategies/strategyView';
import { WarningIcon } from '../strategies/common/icons';
import { closedTradeRows, openPositionRows, pendingOrderRows, usageRows } from './botActivity';
import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';

const LEGEND = [
  { label: 'Sombra', variant: 'primary' },
  { label: 'Real', variant: 'live', dashed: true },
];

const price = (v) => (v === null || v === undefined ? '—' : formatNumber(v, { decimals: 4, minDecimals: 2 }));
const usdt = (v) => (v === null || v === undefined ? '—' : `${formatUsdt(v)} USDT`);
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

// Posición del precio entre el stop (0 %) y el objetivo (100 %).
function rangePct(r) {
  if (r.mark === null || r.stopPrice === null || r.tpPrice === null || r.tpPrice === r.stopPrice) return null;
  return Math.min(100, Math.max(0, ((r.mark - r.stopPrice) / (r.tpPrice - r.stopPrice)) * 100));
}

function TpStopBar({ row }) {
  const pct = rangePct(row);
  return (
    <div className={styles.tpStop}>
      <div
        className={styles.tpStopTrack}
        role="progressbar"
        aria-label={`Precio entre stop y objetivo de ${row.symbol}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
      >
        {pct !== null && <span className={styles.tpStopDot} style={{ left: `${pct}%` }} />}
      </div>
      <div className={styles.tpStopLabels}>
        <span>Stop {price(row.stopPrice)}</span>
        <span>TP {price(row.tpPrice)}</span>
      </div>
    </div>
  );
}

// Banda ATR: sin stop; muestra el objetivo fijado al llenarse y su cálculo.
function AtrTarget({ row }) {
  return (
    <div className={styles.atrTarget}>
      <span><strong>Objetivo {price(row.tpPrice)}</strong> · sin stop</span>
      <span className={`${ui.muted} ${ui.small}`}>{row.tpBreakdown}</span>
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

function Positions({ rows, mobile, multi, onClosePosition, onCloseAll, busy }) {
  const closeAll = onCloseAll && rows.length > 0 && (
    <button type="button" className={`${ICON_BTN} ${styles.touchBtn}`} onClick={() => onCloseAll()} disabled={busy}>Cerrar todo</button>
  );
  return (
    <Section title="Posiciones abiertas" actions={closeAll} mobile={mobile}>
      {!rows.length && <p className={ui.empty}>Sin posiciones abiertas</p>}
      {rows.length > 0 && mobile && (
        <ul className={styles.activityList}>
          {rows.map((r) => (
            <li key={r.id} className={styles.activityCard}>
              <div className={styles.activityCardHead}>
                <span className={`${ui.mono} ${styles.activitySymbol}`}>{r.symbol}</span>
                {multi && <span className={styles.underlyingTag}>{String(r.symbol).split('-')[0]}</span>}
                <span className={ui.muted}>{r.sideLabel} · {formatNumber(r.quantity, { decimals: 4, minDecimals: 0 })}</span>
              </div>
              <div className={`${styles.activityPnl} ${toneClass(r.tone)}`}>
                {pnl(r.pnlUsdt)}
                {r.pnlPct !== null && <small> {formatPct(r.pnlPct, { sign: true })}</small>}
              </div>
              <div className={`${ui.muted} ${ui.small}`}>
                Entrada {price(r.entry)} · Mark {price(r.mark)}{r.hoursToExpiry !== null ? ` · vence en ${r.hoursToExpiry} h` : ''}
              </div>
              <div className={`${ui.muted} ${ui.small}`}>
                Prima {usdt(r.premiumUsdt)} · ejecutada {formatDateTime(r.openedAt)}
              </div>
              {r.tpBreakdown !== null ? <AtrTarget row={r} /> : <TpStopBar row={r} />}
              <CloseBtn row={r} onClosePosition={onClosePosition} busy={busy} />
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && !mobile && (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Símbolo</th><th>Ejecutada</th><th>Lado</th><th className={ui.num}>Cantidad</th><th className={ui.num}>Entrada</th>
                <th className={ui.num}>Prima</th><th className={ui.num}>Mark</th><th className={ui.num}>P&amp;L</th><th className={ui.num}>Stop</th>
                <th className={ui.num}>TP</th><th className={ui.num}>Vence</th>{onClosePosition && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                <tr>
                  <td className={ui.mono}>{r.symbol}</td>
                  <td className={`${ui.mono} ${ui.muted}`}>{formatDateTime(r.openedAt)}</td>
                  <td>{r.sideLabel}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{formatNumber(r.quantity, { decimals: 4, minDecimals: 0 })}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{price(r.entry)}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{usdt(r.premiumUsdt)}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{price(r.mark)}</td>
                  <td className={`${ui.mono} ${ui.num} ${toneClass(r.tone)}`}>
                    {pnl(r.pnlUsdt)}{r.pnlPct !== null ? ` (${formatPct(r.pnlPct, { sign: true })})` : ''}
                  </td>
                  <td className={`${ui.mono} ${ui.num}`}>{price(r.stopPrice)}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{price(r.tpPrice)}</td>
                  <td className={`${ui.mono} ${ui.num}`}>{r.hoursToExpiry === null ? '—' : `${r.hoursToExpiry} h`}</td>
                  {onClosePosition && <td className={ui.num}><CloseBtn row={r} onClosePosition={onClosePosition} busy={busy} /></td>}
                </tr>
                {r.tpBreakdown !== null && (
                  <tr>
                    <td colSpan={onClosePosition ? 12 : 11} className={`${ui.muted} ${ui.small}`}>{r.tpBreakdown}</td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  return (
    <>
      <Positions rows={positions} mobile={mobile} multi={bot.underlyings?.length > 1} onClosePosition={onClosePosition} onCloseAll={onCloseAll} busy={busy} />
      <PendingOrders rows={orders} mobile={mobile} onCancelOrder={onCancelOrder} busy={busy} />
      <Usage rows={usage} mobile={mobile} />
    </>
  );
}
