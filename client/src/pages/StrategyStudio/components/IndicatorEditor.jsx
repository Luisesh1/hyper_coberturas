import { useCallback } from 'react';
import { Spinner } from '../../../components/shared/Spinner';
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog';
import styles from './StrategyEditor.module.css';

export function IndicatorEditor({ form, errors, isSaving, onUpdate, onSave, onDelete, confirmDialog }) {
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      onUpdate('scriptSource', ta.value);
    }
  }, [onUpdate]);

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

      <label className={styles.codeField}>
        <span>Parameter schema (JSON)</span>
        <textarea value={form.parameterSchema} onChange={(e) => onUpdate('parameterSchema', e.target.value)} rows={5} />
        {errors.parameterSchema && <span className={styles.fieldError}>{errors.parameterSchema}</span>}
      </label>

      <label className={styles.codeField}>
        <span>Script</span>
        <textarea value={form.scriptSource} onChange={(e) => onUpdate('scriptSource', e.target.value)} onKeyDown={handleKeyDown} rows={14} spellCheck={false} />
      </label>

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
