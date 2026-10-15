import { DIRECTION_LABEL, normalizeDirection } from './botView';
import styles from './AutoTradingTab.module.css';

// La dirección no se distingue sólo por color: alcista lleva un triángulo
// hacia arriba, bajista uno hacia abajo y neutral una barra.
const SHAPES = {
  bullish: <path d="M12 4l9 16H3z" />,
  bearish: <path d="M12 20L3 4h18z" />,
  neutral: <rect x="4" y="10" width="16" height="4" rx="1.5" />,
};

export function DirectionGlyph({ direction, size = 12 }) {
  const d = normalizeDirection(direction);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      {SHAPES[d]}
    </svg>
  );
}

export default function DirectionChip({ direction, suffix = '', size = 'md', className = '' }) {
  const d = normalizeDirection(direction);
  return (
    <span className={`${styles.dirChip} ${styles[`dir_${d}`]} ${size === 'lg' ? styles.dirChipLg : ''} ${className}`}>
      <DirectionGlyph direction={d} size={size === 'lg' ? 12 : 11} />
      {DIRECTION_LABEL[d]}{suffix}
    </span>
  );
}
