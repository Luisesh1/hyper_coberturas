import { Spinner } from '../../../components/shared/Spinner';
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog';
import { CodeEditor } from '../../../components/shared/CodeEditor';
import { TIMEFRAMES } from '../../../config/timeframes';
import styles from './StrategyEditor.module.css';

export function StrategyEditor({ form, errors, isSaving, isValidating, isBacktesting, onUpdate, onSave, onDelete, onValidate, onBacktest, confirmDialog }) {
  const handleSubmit = (e) => { e.preventDefault(); onSave(); };

  return (
    <form className={styles.editor} onSubmit={handleSubmit}>
      <div className={styles.header}>
        <h2 className={styles.title}>{form.id ? 'Editar estrategia' : 'Nueva estrategia'}</h2>
        {form.id && <span className={styles.idBadge}>#{form.id}</span>}
      </div>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Nombre *</span>
          <input value={form.name} onChange={(e) => onUpdate('name', e.target.value)} placeholder="Momentum EMA crossover" />
          {errors.name && <span className={styles.fieldError}>{errors.name}</span>}
        </label>
        <label className={styles.field}>
          <span>Timeframe</span>
          <select value={form.timeframe} onChange={(e) => onUpdate('timeframe', e.target.value)}>
            {TIMEFRAMES.map((tf) => <option key={tf.value} value={tf.value}>{tf.label}</option>)}
          </select>
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span>Descripcion</span>
          <input value={form.description} onChange={(e) => onUpdate('description', e.target.value)} placeholder="Cruce de EMA con cierre por inversion" />
        </label>
        <label className={styles.field}>
          <span>Assets</span>
          <input value={form.assetUniverse} onChange={(e) => onUpdate('assetUniverse', e.target.value)} placeholder="BTC, ETH" />
        </label>
        <label className={styles.checkField}>
          <input type="checkbox" checked={form.isActiveDraft} onChange={(e) => onUpdate('isActiveDraft', e.target.checked)} />
          <span>Editable como draft</span>
        </label>
      </div>

      <div className={styles.codeField}>
        <span>Params (JSON)</span>
        <CodeEditor value={form.defaultParams} onChange={(v) => onUpdate('defaultParams', v)} minHeight="120px" />
        {errors.defaultParams && <span className={styles.fieldError}>{errors.defaultParams}</span>}
      </div>

      <div className={styles.codeField}>
        <span>Script</span>
        <CodeEditor value={form.scriptSource} onChange={(v) => onUpdate('scriptSource', v)} minHeight="320px" />
        {errors.scriptSource && <span className={styles.fieldError}>{errors.scriptSource}</span>}
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.primaryBtn} disabled={isSaving}>
          {isSaving ? <><Spinner size={14} /> Guardando...</> : form.id ? 'Actualizar' : 'Guardar'}
        </button>
        <button type="button" className={styles.secondaryBtn} onClick={onValidate} disabled={isValidating}>
          {isValidating ? <><Spinner size={14} /> Validando...</> : 'Validar'}
        </button>
        <button type="button" className={styles.secondaryBtn} onClick={onBacktest} disabled={isBacktesting}>
          {isBacktesting ? <><Spinner size={14} /> Backtest...</> : 'Backtest'}
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
