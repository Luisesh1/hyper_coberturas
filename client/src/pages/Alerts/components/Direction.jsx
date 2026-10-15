import { useRef } from 'react';
import { DIRECTIONS, DIRECTION_META, normalizeDirection } from '../lib/direction';
import styles from '../AlertsPage.module.css';

// Forma propia por dirección: la dirección no depende solo del color.
const ICON_PATHS = {
  bullish: 'M12 4l9 16H3z',
  bearish: 'M12 20L3 4h18z',
  neutral: 'M4 9h16v6H4z',
};

export function DirectionIcon({ direction, size = 12 }) {
  const d = normalizeDirection(direction);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-direction-icon={d}
    >
      <path d={ICON_PATHS[d]} />
    </svg>
  );
}

const CHIP_CLASS = {
  bullish: styles.dirChipBullish,
  bearish: styles.dirChipBearish,
  neutral: styles.dirChipNeutral,
};

export function DirectionChip({ direction }) {
  const d = normalizeDirection(direction);
  return (
    <span className={`${styles.dirChip} ${CHIP_CLASS[d]}`} data-testid="direction-chip" data-direction={d}>
      <DirectionIcon direction={d} size={10} />
      {DIRECTION_META[d].label}
    </span>
  );
}

const OPTION_ON_CLASS = {
  bullish: styles.dirOptionBullish,
  bearish: styles.dirOptionBearish,
  neutral: styles.dirOptionNeutral,
};

/**
 * Selector «Dirección de la señal» (radiogroup accesible con flechas).
 * Con `mobile` las opciones van apiladas, a todo el ancho y más altas.
 */
export function DirectionSelector({ value, onChange, mobile = false }) {
  const current = normalizeDirection(value);
  const refs = useRef({});

  const onKeyDown = (e) => {
    const idx = DIRECTIONS.indexOf(current);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = DIRECTIONS[(idx + 1) % DIRECTIONS.length];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = DIRECTIONS[(idx - 1 + DIRECTIONS.length) % DIRECTIONS.length];
    if (!next) return;
    e.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Dirección de la señal"
      className={`${styles.dirOptions} ${mobile ? styles.dirOptionsMobile : ''}`}
      onKeyDown={onKeyDown}
    >
      {DIRECTIONS.map((d) => {
        const checked = d === current;
        return (
          <button
            key={d}
            ref={(el) => { refs.current[d] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={`${styles.dirOption} ${checked ? OPTION_ON_CLASS[d] : ''}`}
            onClick={() => onChange(d)}
          >
            <span className={`${styles.dirOptionIcon} ${styles[`dirOptionIcon_${d}`]}`}>
              <DirectionIcon direction={d} size={mobile ? 16 : 14} />
            </span>
            <span className={styles.dirOptionText}>
              <span className={styles.dirOptionLabel}>{DIRECTION_META[d].label}</span>
              <span className={styles.dirOptionHint}>
                {mobile ? DIRECTION_META[d].mobileHint : DIRECTION_META[d].hint}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
