import { MODES, MODE_LABEL } from './strategyView';
import ui from './common/ui.module.css';
import styles from './ModeSwitch.module.css';

export function ModeBadge({ mode }) {
  return <span className={`${ui.badge} ${ui[`badge_${mode}`] || ''}`}>{MODE_LABEL[mode] || mode}</span>;
}

// Control segmentado Pausada / Sombra / Real (radiogroup con flechas).
export default function ModeSwitch({ value, onSelect, disabled = false, block = false, pending = null }) {
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = MODES.indexOf(value);
    const next = MODES[(i + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length];
    onSelect(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Modo de ejecución"
      className={`${styles.group} ${block ? styles.block : ''}`}
      onKeyDown={onKeyDown}
    >
      {MODES.map((m) => {
        const checked = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={`${styles.option} ${checked ? styles[`on_${m}`] : ''} ${pending === m ? styles.pending : ''}`}
            onClick={() => { if (!checked) onSelect(m); }}
            disabled={disabled}
          >
            {MODE_LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}
