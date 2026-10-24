import { ModeBadge } from '../strategies/ModeSwitch';
import { Pnl } from '../strategies/StrategyList';
import DirectionChip from './DirectionChip';
import { BOT_MODE_LABEL, STRUCTURE_INFO, botDirections, cardPnl, formatCountdown } from './botView';
import Sparkline from './visual/Sparkline';
import { useNow } from './visual/useNow';
import { relativeTime } from './visual/visualModel';
import styles from './AutoTradingTab.module.css';
import v from './visual/visual.module.css';

const underlyingsText = (b) => (b.underlyings?.length ? b.underlyings : [b.underlying]).join(' · ');

// Chip de la esquina: lo más urgente del bot (entrada en curso, bloqueo,
// error, posición) o, si no hay nada, su modo.
function StatusChip({ bot, now }) {
  if (bot.pendingEntry) {
    return <span className={`${v.pill} ${v.pill_wait}`}>Entrada {formatCountdown(Math.max(0, bot.pendingEntry.deadlineAt - now))}</span>;
  }
  if (bot.pendingEntryUnknown) return <span className={`${v.pill} ${v.pill_wait}`} title="Estado de la entrada desconocido">Entrada ?</span>;
  if (bot.blocked) return <span className={`${v.pill} ${v.pill_down}`}>Bloqueado</span>;
  if (bot.status === 'error') return <span className={`${v.pill} ${v.pill_down}`}>Con error</span>;
  if (bot.status === 'in_position') return <span className={`${v.pill} ${v.pill_mute}`}>En posición</span>;
  return <span className={`${v.pill} ${v[`pill_${bot.mode}`]}`}>{BOT_MODE_LABEL[bot.mode] || bot.mode}</span>;
}

function DesktopCard({ bot: b, selected, onSelect, now }) {
  const dirs = botDirections(b.alerts);
  const info = STRUCTURE_INFO[b.structure];
  const lastAt = b.lastSignal?.at ?? null;
  return (
    <button
      type="button"
      className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(b.id)}
    >
      <span className={styles.cardTop}>
        <span className={styles.cardTopMain}>
          <span className={`${v.dot} ${v[`dot_${b.mode}`]}`} title={BOT_MODE_LABEL[b.mode]} />
          <span className={styles.cardName}>{b.name}</span>
        </span>
        <StatusChip bot={b} now={now} />
      </span>
      <span className={styles.cardRow}>
        <span className={styles.cardMeta}>
          {underlyingsText(b)}{info ? ` · ${info.shorter}` : ''} · {lastAt !== null ? relativeTime(lastAt, now) : 'sin señales'}
        </span>
        <Sparkline values={b.pnlSeries} />
      </span>
      <span className={styles.cardRow}>
        <span className={styles.chips}>
          {dirs.length
            ? dirs.map((d) => <DirectionChip key={d} direction={d} />)
            : <span className={styles.cardMeta}>Sin alertas vinculadas</span>}
        </span>
        <Pnl value={cardPnl(b)} />
      </span>
    </button>
  );
}

// Tarjetas de bots. Escritorio: punto de estado (Real late), chip de lo más
// urgente con la cuenta atrás de la entrada, sparkline de 30 días y P&L.
// Móvil: tarjeta compacta de siempre (la rediseña la tarea móvil).
export default function BotList({ bots, selectedId, onSelect, mobile = false }) {
  const now = useNow(!mobile && bots.some((b) => b.pendingEntry));
  return (
    <ul className={styles.cardList} aria-label="Bots">
      {bots.map((b) => {
        if (!mobile) {
          return (
            <li key={b.id}>
              <DesktopCard bot={b} selected={b.id === selectedId} onSelect={onSelect} now={now} />
            </li>
          );
        }
        const dirs = botDirections(b.alerts);
        return (
          <li key={b.id}>
            <button
              type="button"
              className={`${styles.card} ${styles.cardMobile}`}
              onClick={() => onSelect(b.id)}
            >
              <span className={styles.cardTop}>
                <span className={styles.cardName}>{b.name}</span>
                <ModeBadge mode={b.mode} labels={BOT_MODE_LABEL} />
              </span>
              <span className={styles.chips}>
                {dirs.length
                  ? dirs.map((d) => <DirectionChip key={d} direction={d} />)
                  : <span className={styles.cardMeta}>Sin alertas vinculadas</span>}
                <span className={styles.cardMeta}>{underlyingsText(b)}</span>
              </span>
              <span className={styles.cardBottom}>
                <span>{b.statusLabel}</span>
                <Pnl value={cardPnl(b)} className={styles.cardPnlBig} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
