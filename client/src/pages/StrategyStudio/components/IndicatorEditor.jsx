import { Spinner } from '../../../components/shared/Spinner';
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog';
import { CodeEditor } from '../../../components/shared/CodeEditor';
import styles from './StrategyEditor.module.css';

export function IndicatorEditor({ form, errors, isSaving, onUpdate, onSave, onDelete, confirmDialog }) {
  const handleSubmit = (e) => { e.preventDefault(); onSave(); };

  return (
    <form className={styles.editor} onSubmit={handleSubmit}>
      <div className={styles.header}>
        <h2 className={styles.title}>{form.id ? 'Editar indicador' : 'Nuevo indicador'}</h2>
        {form.slug && <span className={styles.idBadge}>@{form.slug}</span>}
      </div>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Nombre *</span>
          <input value={form.name} onChange={(e) => onUpdate('name', e.target.value)} placeholder="EMA suavizada custom" />
          {errors.name && <span className={styles.fieldError}>{errors.name}</span>}
        </label>
        <label className={styles.field}>
          <span>Slug *</span>
          <input value={form.slug} onChange={(e) => onUpdate('slug', e.target.value)} placeholder="ema-custom" />
          {errors.slug && <span className={styles.fieldError}>{errors.slug}</span>}
        </label>
      </div>

      <div className={styles.codeField}>
        <span>Parameter schema (JSON)</span>
        <CodeEditor value={form.parameterSchema} onChange={(v) => onUpdate('parameterSchema', v)} minHeight="100px" />
        {errors.parameterSchema && <span className={styles.fieldError}>{errors.parameterSchema}</span>}
      </div>

      <div className={styles.codeField}>
        <span>Script</span>
        <CodeEditor value={form.scriptSource} onChange={(v) => onUpdate('scriptSource', v)} minHeight="260px" />
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.primaryBtn} disabled={isSaving}>
          {isSaving ? <><Spinner size={14} /> Guardando...</> : form.id ? 'Actualizar' : 'Guardar'}
        </button>
        {form.id && (
          <button type="button" className={styles.dangerBtn} onClick={onDelete}>Eliminar</button>
        )}
      </div>

      {confirmDialog.open && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          variant={confirmDialog.variant}
          onConfirm={confirmDialog.onConfirm}
          onCancel={confirmDialog.onCancel}
        />
      )}
    </form>
  );
}
