import { useState } from 'react';
import {
  BUILTIN_OVERLAYS,
  INDICATOR_PARAM_SCHEMAS,
  blankOverlay,
  defaultOverlayParams,
} from '../../../components/Backtesting/backtesting-utils';
import { stringifyJson } from '../../../utils/json';
import styles from './OverlayManager.module.css';

function OverlayChip({ overlay, onRemove }) {
  const params = (() => {
    try { return JSON.parse(overlay.params); } catch { return {}; }
  })();
  const summary = Object.values(params).join(', ');
  const paneLabel = overlay.pane === 'price' ? 'precio' : 'separado';

  return (
    <div className={styles.chip}>
      <span className={styles.chipName}>
        {overlay.slug.toUpperCase()}
        {summary && <span className={styles.chipParams}>({summary})</span>}
      </span>
      <span className={styles.chipPane}>@ {paneLabel}</span>
      <button type="button" className={styles.chipRemove} onClick={() => onRemove(overlay.id)}>
        &times;
      </button>
    </div>
  );
}

function OverlayManager({ overlays, indicators, onChange }) {
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState('builtin');
  const [newSlug, setNewSlug] = useState('ema');
  const [newPane, setNewPane] = useState('price');
  const [newParams, setNewParams] = useState({});
  const [newCustomJson, setNewCustomJson] = useState('{}');

  const schema = INDICATOR_PARAM_SCHEMAS[newSlug] || [];

  const handleRemove = (id) => {
    onChange(overlays.filter((o) => o.id !== id));
  };

  const handleAdd = () => {
    const params = newKind === 'builtin'
      ? { ...defaultOverlayParams(newSlug), ...newParams }
      : (() => { try { return JSON.parse(newCustomJson); } catch { return {}; } })();

    const overlay = {
      ...blankOverlay(newKind),
      slug: newSlug,
      params: stringifyJson(params),
      pane: newPane,
    };
    onChange([...overlays, overlay]);
    setAdding(false);
    setNewParams({});
    setNewCustomJson('{}');
  };

  const startAdd = (kind) => {
    setNewKind(kind);
    setNewSlug(kind === 'builtin' ? 'ema' : (indicators[0]?.slug || ''));
    setNewPane('price');
    setNewParams({});
    setNewCustomJson('{}');
    setAdding(true);
  };

  return (
    <div className={styles.manager}>
      <div className={styles.chipList}>
        {overlays.map((o) => (
          <OverlayChip key={o.id} overlay={o} onRemove={handleRemove} />
        ))}
      </div>

      {adding ? (
        <div className={styles.addForm}>
          <div className={styles.addRow}>
            <select
              className={styles.select}
              value={newKind}
              onChange={(e) => {
                setNewKind(e.target.value);
                setNewSlug(e.target.value === 'builtin' ? 'ema' : (indicators[0]?.slug || ''));
              }}
            >
              <option value="builtin">Built-in</option>
              <option value="custom">Custom</option>
            </select>
            <select
              className={styles.select}
              value={newSlug}
              onChange={(e) => { setNewSlug(e.target.value); setNewParams({}); }}
            >
              {(newKind === 'builtin' ? BUILTIN_OVERLAYS : indicators.map((i) => i.slug)).map(
                (slug) => <option key={slug} value={slug}>{slug}</option>
              )}
            </select>
            <select className={styles.select} value={newPane} onChange={(e) => setNewPane(e.target.value)}>
              <option value="price">Precio</option>
              <option value="separate">Separado</option>
            </select>
          </div>

          {newKind === 'builtin' && schema.length > 0 && (
            <div className={styles.addRow}>
              {schema.map((field) => (
                <label key={field.key} className={styles.paramField}>
                  <span>{field.label}</span>
                  <input
                    type="number"
                    className={styles.input}
                    value={newParams[field.key] ?? field.default}
                    onChange={(e) =>
                      setNewParams((p) => ({ ...p, [field.key]: Number(e.target.value) }))
                    }
                  />
                </label>
              ))}
            </div>
          )}

          {newKind === 'custom' && (
            <textarea
              className={styles.textarea}
              rows={2}
              value={newCustomJson}
              onChange={(e) => setNewCustomJson(e.target.value)}
              placeholder='{"period": 14}'
            />
          )}

          <div className={styles.addActions}>
            <button type="button" className={styles.addBtn} onClick={handleAdd}>Agregar</button>
            <button type="button" className={styles.cancelBtn} onClick={() => setAdding(false)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className={styles.addActions}>
          <button type="button" className={styles.addBtn} onClick={() => startAdd('builtin')}>+ Built-in</button>
          {indicators.length > 0 && (
            <button type="button" className={styles.addBtn} onClick={() => startAdd('custom')}>+ Custom</button>
          )}
        </div>
      )}
    </div>
  );
}

export default OverlayManager;
