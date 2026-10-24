import { formatNumber } from '../../strategies/common/format';
import { formatCountdown } from '../botView';
import { useNow } from './useNow';
import { contractShort } from './visualModel';
import styles from './visual.module.css';

const R = 24;
const CIRC = 2 * Math.PI * R;
const price = (v) => formatNumber(v, { decimals: 4, minDecimals: 0 });
const MODE_TEXT = { live: 'Real', shadow: 'Sombra' };

function countdownLabel(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `Quedan ${Math.floor(total / 60)} min ${total % 60} s`;
}

/** Anillo de cuenta atrás: `progress` 0–1 es la parte de la ventana que queda. */
export function CountdownRing({ progress = 0, text, label, size = 58 }) {
  const p = Math.min(1, Math.max(0, progress));
  return (
    <svg className={styles.ring} width={size} height={size} viewBox="0 0 58 58" role="img" aria-label={label}>
      <circle cx="29" cy="29" r={R} className={styles.ringTrack} />
      <circle
        cx="29" cy="29" r={R}
        className={styles.ringFill}
        strokeDasharray={CIRC.toFixed(1)}
        strokeDashoffset={(CIRC * (1 - p)).toFixed(1)}
        transform="rotate(-90 29 29)"
      />
      <text x="29" y="33" textAnchor="middle" className={styles.ringText}>{text}</text>
    </svg>
  );
}

// Icono de estado (sin cuenta atrás): anillo del color del estado con un glifo.
function StateIcon({ glyph, label, size }) {
  return (
    <svg className={styles.ring} width={size} height={size} viewBox="0 0 58 58" role="img" aria-label={label}>
      <circle cx="29" cy="29" r={R} className={styles.ringState} />
      <text x="29" y="34" textAnchor="middle" className={styles.ringGlyph}>{glyph}</text>
    </svg>
  );
}

const GLYPH = { blocked: '!', position: '●', waiting: '…', paused: '❚❚', unknown: '?' };

function Ladder({ entry }) {
  const l = entry.ladder;
  if (!l) return null;
  const at = (pct) => `${8 + pct * 0.84}%`;
  const sell = entry.sideLabel === 'Vender';
  const saving = formatNumber(l.savingPerContract, { decimals: 2, minDecimals: 0 });
  return (
    <div className={styles.ladder}>
      <div
        className={styles.ladderBar}
        role="img"
        aria-label={`Límite ${price(entry.limitPrice)} entre bid ${price(entry.bid)} y ask ${price(entry.ask)}`}
      >
        <span className={`${styles.tick} ${styles.tick_bid}`} style={{ left: at(l.bidPct) }}>
          <span className={`${styles.tickLabel} ${styles.tickLabelDown}`}>bid {price(entry.bid)}</span>
        </span>
        <span className={`${styles.tick} ${styles.tick_mid}`} style={{ left: at(l.midPct) }}>
          <span className={styles.tickLabel}>límite {price(entry.limitPrice)}</span>
        </span>
        <span className={`${styles.tick} ${styles.tick_ask}`} style={{ left: at(l.askPct) }}>
          <span className={`${styles.tickLabel} ${styles.tickLabelDown}`}>ask {price(entry.ask)}</span>
        </span>
      </div>
      <div className={styles.ladderCap}>
        <span>vender</span>
        <span>{sell ? `mejora frente al bid: ${saving} USDT/contrato` : `ahorro frente al ask: ${saving} USDT/contrato`}</span>
        <span>comprar</span>
      </div>
    </div>
  );
}

function minutesText(ms) {
  const min = Math.floor(ms / 60_000);
  return min >= 1 ? `${min} min` : 'menos de 1 min';
}

/**
 * Franja «qué está pasando ahora». `status` sale de botStatus(); `entry` es la
 * fila de pendingEntryRows() de la entrada en curso. Solo con `kind ===
 * 'pending'` hay un temporizador de 1 s para la cuenta atrás.
 * `blocked` lista los subyacentes bloqueados y `onUnblock(u)` los desbloquea.
 */
export default function BotNowStrip({
  status, entry = null, blocked = [], onUnblock, unblocking = null, unknown = false, compact = false,
}) {
  const kind = status?.kind || 'waiting';
  const pending = kind === 'pending';
  const now = useNow(pending);
  if (!status) return null;

  const deadlineAt = status.deadlineAt ?? entry?.deadlineAt ?? null;
  const remainingMs = deadlineAt === null ? (status.remainingMs ?? 0) : Math.max(0, deadlineAt - now);
  const iconSize = compact ? 46 : 58;
  const tone = unknown && kind === 'waiting' ? 'unknown' : kind;

  const icon = pending
    ? (
      <CountdownRing
        progress={Math.min(1, remainingMs / 600_000)}
        text={formatCountdown(remainingMs)}
        label={countdownLabel(remainingMs)}
        size={iconSize}
      />
    )
    : <StateIcon glyph={GLYPH[tone] || '…'} label={status.title} size={iconSize} />;

  return (
    <section
      className={`${styles.now} ${styles[`now_${tone}`] || ''} ${compact ? styles.nowCompact : ''}`}
      aria-label="Estado actual"
    >
      {icon}
      <div className={styles.nowText}>
        <div className={styles.nowHead}>
          <h3 className={styles.nowTitle}>{compact && pending ? 'Entrada pendiente' : status.title}</h3>
          {pending && MODE_TEXT[entry?.mode] && (
            <span className={`${styles.pill} ${styles[`pill_${entry.mode}`]}`}>{MODE_TEXT[entry.mode]}</span>
          )}
        </div>
        {pending && entry ? (
          <>
            <p>
              {compact ? (
                <>{entry.sideLabel === 'Vender' ? 'Venta' : 'Compra'} {formatNumber(entry.quantity, { decimals: 4, minDecimals: 0 })} {contractShort(entry.symbol)} a <b className={styles.limit}>{price(entry.limitPrice)}</b> · bid {price(entry.bid)} / ask {price(entry.ask)}</>
              ) : (
                <>
                  Orden límite GTC a <b className={styles.limit}>{price(entry.limitPrice)}</b> (precio medio).{' '}
                  {remainingMs > 0
                    ? `Si en ${minutesText(remainingMs)} no se ejecuta, se cancela y el bot espera la siguiente señal.`
                    : 'Ha vencido: se cancela en la próxima comprobación.'}
                </>
              )}
            </p>
            <p>
              {entry.feeText && <span className={styles.fee}>{entry.feeText}</span>}
              {entry.feeText ? ' · ' : ''}ejecutado {entry.filled}
            </p>
          </>
        ) : (
          <p>{status.detail}</p>
        )}
        {kind === 'blocked' && onUnblock && blocked.length > 0 && (
          <div className={styles.nowActions}>
            {blocked.map((u) => (
              <button
                key={u}
                type="button"
                className={styles.unblockBtn}
                onClick={() => onUnblock(u)}
                disabled={unblocking !== null}
              >
                {unblocking === u ? `Desbloqueando ${u}…` : `Desbloquear ${u}`}
              </button>
            ))}
          </div>
        )}
      </div>
      {pending && entry && !compact && <Ladder entry={entry} />}
    </section>
  );
}
