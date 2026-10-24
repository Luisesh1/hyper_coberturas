import { formatNumber } from '../../strategies/common/format';
import { ENTRY_WINDOW_MS, formatCountdown } from '../botView';
import { CountdownRing } from './BotNowStrip';
import { useNow } from './useNow';
import { contractShort } from './visualModel';
import styles from './visual.module.css';

const price = (v) => formatNumber(v, { decimals: 4, minDecimals: 0 });

/**
 * Banner de la lista móvil: «1 entrada pendiente · 6:12» sobre las tarjetas,
 * con el bot cuya entrada vence antes. `entry` ({ botId, row }) es la fila de
 * pendingEntryRows() del detalle ya cargado; solo se usa si es de ese bot y
 * de la misma entrada (la lista no trae el contrato ni el límite). Tocarlo abre el bot.
 * El temporizador de 1 s solo existe mientras hay alguna entrada pendiente.
 */
export default function PendingBanner({ bots = [], entry = null, onSelect }) {
  const pending = bots.filter((b) => b.pendingEntry && Number.isFinite(b.pendingEntry.deadlineAt));
  const now = useNow(pending.length > 0);
  if (!pending.length) return null;

  const first = pending.reduce((a, b) => (b.pendingEntry.deadlineAt < a.pendingEntry.deadlineAt ? b : a));
  const remainingMs = Math.max(0, first.pendingEntry.deadlineAt - now);
  const n = pending.length;
  const title = `${n} ${n === 1 ? 'entrada pendiente' : 'entradas pendientes'} · ${formatCountdown(remainingMs)}`;
  // Solo si es la misma entrada que anuncia la lista (mismo vencimiento): un
  // detalle viejo no debe poner el contrato de otra entrada.
  const row = entry && entry.botId === first.id && entry.row
    && Math.abs((entry.row.deadlineAt ?? NaN) - first.pendingEntry.deadlineAt) < 1000 ? entry.row : null;
  const sub = [
    first.name,
    row ? `${contractShort(row.symbol)} a ${price(row.limitPrice)}` : null,
    n > 1 ? `y ${n - 1} más` : null,
  ].filter(Boolean).join(' · ');

  return (
    <button type="button" className={styles.banner} onClick={() => onSelect?.(first.id)}>
      <span aria-hidden="true" className={styles.bannerRing}>
        <CountdownRing progress={Math.min(1, remainingMs / ENTRY_WINDOW_MS)} text="" label="" size={40} />
      </span>
      <span className={styles.bannerText}>
        <b className={styles.bannerTitle}>{title}</b>
        <span className={styles.bannerSub}>{sub}</span>
      </span>
    </button>
  );
}
