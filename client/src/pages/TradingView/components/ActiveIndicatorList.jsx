import { INDICATORS } from '../indicators/catalog';
import { formatParams } from '../indicators/formatParams';
import { MOBILE_QUERY, useMediaQuery } from '../useMediaQuery';
import { useSwipeToReveal } from './useSwipeToReveal';
import styles from './IndicatorConfigModal.module.css';
import swipeStyles from './ActiveIndicatorList.module.css';
import { EyeIcon, EyeOffIcon, PlusIcon, TrashIcon } from './icons';

// Ancho del botón «Quitar» (debe coincidir con .removeAction).
const REVEAL_WIDTH = 96;

export default function ActiveIndicatorList({ indicators, selectedUid, onSelect, onToggleVisible, onRemove, onAddNew }) {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const swipe = useSwipeToReveal({ revealWidth: REVEAL_WIDTH, enabled: isMobile });

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
        const open = swipe.openId === ind.uid;
        const handlers = swipe.bind(ind.uid);
        const offset = swipe.offsetFor(ind.uid);
        return (
          <div key={ind.uid} className={swipeStyles.swipeRow}>
            {isMobile && (
              // Cerrado queda tapado por la fila: fuera del foco y del árbol
              // accesible para no duplicar la papelera.
              <button
                type="button"
                className={swipeStyles.removeAction}
                aria-label={`Quitar ${meta.label}`}
                aria-hidden={!open}
                tabIndex={open ? 0 : -1}
                onClick={() => { swipe.close(); onRemove(ind.uid); }}
              >
                Quitar
              </button>
            )}
            <div
              data-swipe-row=""
              className={`${swipeStyles.swipeTrack} ${swipe.isDragging(ind.uid) ? swipeStyles.swipeTrackDragging : ''}`}
              style={offset ? { transform: `translateX(${offset}px)` } : undefined}
              // Los gestos que empiezan en un botón (ojo, papelera) no arrastran.
              onPointerDown={(e) => { if (!e.target.closest?.('button')) handlers.onPointerDown(e); }}
              onPointerMove={handlers.onPointerMove}
              onPointerUp={handlers.onPointerUp}
              onPointerCancel={handlers.onPointerCancel}
              onClick={() => { if (!swipe.shouldSuppressClick()) onSelect(ind.uid); }}
            >
              <div className={`${styles.activeItem} ${selected ? styles.activeItemSelected : ''}`}>
                <div className={swipeStyles.rowText}>
                  <div className={styles.activeItemLabel}>{meta.label}</div>
                  <div className={`${styles.activeItemParams} ${swipeStyles.paramsLine}`}>{formatParams(ind)}</div>
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
                    className={swipeStyles.trashBtn}
                    title="Eliminar"
                    aria-label={`Eliminar ${meta.label}`}
                    onClick={() => onRemove(ind.uid)}
                  >
                    <TrashIcon size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <button type="button" className={styles.addBtn} onClick={onAddNew}><PlusIcon size={16} /> Agregar desde catálogo</button>
    </>
  );
}
