import { useCallback, useRef } from 'react';
import { Spinner } from '../../../components/shared/Spinner';
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog';
import styles from './StrategyEditor.module.css';

const TIMEFRAMES = ['1m', '5m', '15m', '1h'];

export function StrategyEditor({ form, errors, isSaving, isValidating, isBacktesting, onUpdate, onSave, onDelete, onValidate, onBacktest, confirmDialog }) {
  const codeRef = useRef(null);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      ta.value = val.substring(0, start) + '  ' + val.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      onUpdate('scriptSource', ta.value);
    }
  }, [onUpdate]);

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
            {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
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

      <label className={styles.codeField}>
        <span>Params (JSON)</span>
        <textarea value={form.defaultParams} onChange={(e) => onUpdate('defaultParams', e.target.value)} rows={6} />
        {errors.defaultParams && <span className={styles.fieldError}>{errors.defaultParams}</span>}
      </label>

      <label className={styles.codeField}>
        <span>Script</span>
        <textarea ref={codeRef} value={form.scriptSource} onChange={(e) => onUpdate('scriptSource', e.target.value)} onKeyDown={handleKeyDown} rows={18} spellCheck={false} />
        {errors.scriptSource && <span className={styles.fieldError}>{errors.scriptSource}</span>}
      </label>

      <div className={styles.actions}>
        <button type="submit" className={styles.primaryBtn} disabled={isSaving}>
          {isSaving ? <><Spinner size={14} /> Guardando...</> : form.id ? 'Actualizar' : 'Guardar'}
        </button>
        <button type="button" className={styles.secondaryBtn} onClick={onValidate} disabled={isValidating || !form.id}>
          {isValidating ? <><Spinner size={14} /> Validando...</> : 'Validar'}
        </button>
        <button type="button" className={styles.secondaryBtn} onClick={onBacktest} disabled={isBacktesting || !form.id}>
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
