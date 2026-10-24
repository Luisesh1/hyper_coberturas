import { formatNumber, toNumber } from '../../strategies/common/format';
import styles from './visual.module.css';

const price = (v) => formatNumber(v, { decimals: 4, minDecimals: 0 });

// Posición de `value` entre el stop (0 %) y el objetivo (100 %). Sirve igual
// para ventas: con stop > TP el cociente sigue dando 0 en el stop.
export function rangePct(r, value = r.mark) {
  const v = toNumber(value);
  const lo = toNumber(r.stopPrice);
  const hi = toNumber(r.tpPrice);
  if (v === null || lo === null || hi === null || hi === lo) return null;
  return Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
}

function Marker({ pct, label, kind, up = false }) {
  const edge = pct < 8 ? styles.mkEdgeL : pct > 92 ? styles.mkEdgeR : '';
  return (
    <span className={`${styles.mk} ${edge}`} style={{ left: `${pct}%` }}>
      <span className={kind === 'now' ? styles.markNow : `${styles.pin} ${styles[`pin_${kind}`]}`} />
      <span className={`${styles.mkLabel} ${up ? styles.mkUp : styles.mkDown} ${styles[`mkLabel_${kind}`]}`}>{label}</span>
    </span>
  );
}

/**
 * Barra stop – entrada – ahora – TP de una posición. Sin stop (banda ATR) la
 * barra va de la entrada al objetivo. Sin objetivo no pinta nada.
 */
export default function PositionRange({ stop = null, entry = null, mark = null, tp = null, compact = false }) {
  const low = toNumber(stop) ?? toNumber(entry);
  const high = toNumber(tp);
  if (low === null || high === null || low === high) return null;
  const r = { stopPrice: low, tpPrice: high };
  const entryPct = rangePct(r, entry) ?? 0;
  const nowPct = rangePct(r, mark);
  const hasStop = toNumber(stop) !== null;
  const t = (word, v) => (compact ? price(v) : `${word} ${price(v)}`);
  const label = `Precio actual ${mark === null ? 'sin cotización' : price(mark)} entre ${hasStop ? `stop ${price(stop)}` : `entrada ${price(entry)}`} y objetivo ${price(tp)}`;
  return (
    <div
      className={`${styles.range} ${compact ? styles.rangeCompact : ''}`}
      style={{ '--entry': `${entryPct}%` }}
      role="img"
      aria-label={label}
    >
      {hasStop && <Marker pct={0} label={t('stop', stop)} kind="stop" />}
      {toNumber(entry) !== null && <Marker pct={entryPct} label={t('entrada', entry)} kind="entry" />}
      {nowPct !== null && <Marker pct={nowPct} label={t('ahora', mark)} kind="now" up />}
      <Marker pct={100} label={t('TP', tp)} kind="tp" />
    </div>
  );
}
