import { ModeBadge } from '../strategies/ModeSwitch';
import { Pnl } from '../strategies/StrategyList';
import DirectionChip from './DirectionChip';
import { BOT_MODE_LABEL, botDirections, cardPnl } from './botView';
import styles from './AutoTradingTab.module.css';

// Tarjetas de bots: nombre + modo, chips de dirección de sus alertas,
// estado y P&L de 30 días.
export default function BotList({ bots, selectedId, onSelect, mobile = false }) {
  return (
    <ul className={styles.cardList} aria-label="Bots">
      {bots.map((b) => {
        const selected = !mobile && b.id === selectedId;
        const dirs = botDirections(b.alerts);
        return (
          <li key={b.id}>
            <button
              type="button"
              className={`${styles.card} ${mobile ? styles.cardMobile : ''} ${selected ? styles.cardSelected : ''}`}
              aria-current={selected ? 'true' : undefined}
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
                <span className={styles.cardMeta}>{b.underlying}</span>
              </span>
              <span className={styles.cardBottom}>
                {mobile ? (
                  <>
                    <span>{b.statusLabel}</span>
                    <Pnl value={cardPnl(b)} className={styles.cardPnlBig} />
                  </>
                ) : (
                  <>
                    <span>P&amp;L 30d <Pnl value={cardPnl(b)} /></span>
                    <span>{b.statusLabel}</span>
                  </>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
