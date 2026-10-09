import { INDICATORS } from '../indicators/catalog';
import styles from './IndicatorConfigModal.module.css';
import { EyeIcon, EyeOffIcon, PlusIcon, TrashIcon } from './icons';

function formatParams(entry) {
  const meta = INDICATORS[entry.type];
  if (!meta) return '';
  const keys = (meta.paramSchema || []).map((p) => p.key);
  const parts = keys
    .filter((k) => entry.params?.[k] != null)
    .map((k) => `${k}=${entry.params[k]}`);
  return parts.join(' · ');
}

export default function ActiveIndicatorList({ indicators, selectedUid, onSelect, onToggleVisible, onRemove, onAddNew }) {
  return (
    <>
      <p className={styles.columnTitle}>Activos ({indicators.length})</p>
      {indicators.length === 0 && (
        <div className={styles.empty}>Sin indicadores. Agrega uno desde el catálogo.</div>
      )}
      {indicators.map((ind) => {
        const meta = INDICATORS[ind.type];
        if (!meta) return null;
        const selected = ind.uid === selectedUid;
        return (
          <div
            key={ind.uid}
            className={`${styles.activeItem} ${selected ? styles.activeItemSelected : ''}`}
            onClick={() => onSelect(ind.uid)}
          >
            <div style={{ flex: 1 }}>
              <div className={styles.activeItemLabel}>{meta.label}</div>
              <div className={styles.activeItemParams}>{formatParams(ind) || meta.fullName}</div>
            </div>
            <div className={styles.activeItemActions} onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                title={ind.visible ? 'Ocultar' : 'Mostrar'}
                aria-label={`${ind.visible ? 'Ocultar' : 'Mostrar'} ${meta.label}`}
                aria-pressed={ind.visible}
                onClick={() => onToggleVisible(ind.uid)}
              >
                {ind.visible ? <EyeIcon size={18} /> : <EyeOffIcon size={18} />}
              </button>
              <button
                type="button"
                title="Eliminar"
                aria-label={`Eliminar ${meta.label}`}
                onClick={() => onRemove(ind.uid)}
              >
                <TrashIcon size={18} />
              </button>
            </div>
          </div>
        );
      })}
      <button type="button" className={styles.addBtn} onClick={onAddNew}><PlusIcon size={16} /> Agregar desde catálogo</button>
    </>
  );
}
