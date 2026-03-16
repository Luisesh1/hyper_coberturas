import { Spinner } from '../../../components/shared/Spinner';
import { DropdownMenu } from '../../../components/shared/DropdownMenu';
import styles from './BotActionBar.module.css';

export function BotActionBar({ bot, isSaving, isActing, onSave, onAction }) {
  const status = bot?.status || 'draft';
  const isNew = !bot?.id;

  const primaryAction = getPrimaryAction(status);
  const secondaryItems = getSecondaryItems(status, isActing, onAction);

  return (
    <div className={styles.bar}>
      <button type="submit" className={styles.saveBtn} disabled={isSaving} onClick={onSave}>
        {isSaving ? <><Spinner size={14} /> Guardando...</> : isNew ? 'Crear bot' : 'Actualizar'}
      </button>

      {!isNew && primaryAction && (
        <button
          type="button"
          className={`${styles.actionBtn} ${styles[primaryAction.cls]}`}
          disabled={isActing}
          onClick={() => onAction(primaryAction.action)}
        >
          {isActing ? <Spinner size={14} /> : primaryAction.label}
        </button>
      )}

      {!isNew && secondaryItems.length > 0 && (
        <DropdownMenu trigger="..." items={secondaryItems} />
      )}
    </div>
  );
}

function getPrimaryAction(status) {
  switch (status) {
    case 'draft': case 'stopped': return { label: 'Activar', action: 'activate', cls: 'activate' };
    case 'active': return { label: 'Pausar', action: 'pause', cls: 'pause' };
    case 'paused': return { label: 'Reanudar', action: 'activate', cls: 'activate' };
    case 'error': return { label: 'Reintentar', action: 'activate', cls: 'activate' };
    default: return null;
  }
}

function getSecondaryItems(status, isActing, onAction) {
  const items = [];
  if (status === 'active') items.push({ label: 'Detener', onClick: () => onAction('stop'), danger: true, disabled: isActing });
  items.push({ label: 'Duplicar', onClick: () => onAction('duplicate'), disabled: isActing });
  if (status !== 'active') items.push({ label: 'Eliminar', onClick: () => onAction('delete'), danger: true, disabled: isActing });
  return items;
}
