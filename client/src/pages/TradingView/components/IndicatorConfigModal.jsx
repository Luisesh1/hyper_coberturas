import { useEffect, useState, useCallback } from 'react';
import styles from './IndicatorConfigModal.module.css';
import ActiveIndicatorList from './ActiveIndicatorList';
import IndicatorCatalogPanel from './IndicatorCatalogPanel';
import IndicatorSettingsForm from './IndicatorSettingsForm';
import { makeIndicatorEntry, INDICATORS } from '../indicators/catalog';

export default function IndicatorConfigModal({ open, initialIndicators, onSave, onCancel }) {
  const [draft, setDraft] = useState([]);
  const [selectedUid, setSelectedUid] = useState(null);
  const [rightMode, setRightMode] = useState('catalog'); // 'catalog' | 'edit'
  const [saving, setSaving] = useState(false);

  // Resetea estado al abrir
  useEffect(() => {
    if (open) {
      setDraft(Array.isArray(initialIndicators) ? JSON.parse(JSON.stringify(initialIndicators)) : []);
      setSelectedUid(null);
      setRightMode('catalog');
      setSaving(false);
    }
  }, [open, initialIndicators]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onCancel?.();
  }, [onCancel]);

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
    return undefined;
  }, [open, handleKeyDown]);

  if (!open) return null;

  const selectedIndicator = draft.find((d) => d.uid === selectedUid) || null;

  const handleAddFromCatalog = (type) => {
    const entry = makeIndicatorEntry(type);
    if (!entry) return;
    setDraft((prev) => [...prev, entry]);
    setSelectedUid(entry.uid);
    setRightMode('edit');
  };

  const handleSelect = (uid) => {
    setSelectedUid(uid);
    setRightMode('edit');
  };

  const handleToggleVisible = (uid) => {
    setDraft((prev) => prev.map((d) => (d.uid === uid ? { ...d, visible: !d.visible } : d)));
  };

  const handleRemove = (uid) => {
    setDraft((prev) => prev.filter((d) => d.uid !== uid));
    if (selectedUid === uid) {
      setSelectedUid(null);
      setRightMode('catalog');
    }
  };

  const handleChangeSelected = (next) => {
    setDraft((prev) => prev.map((d) => (d.uid === next.uid ? next : d)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onCancel} role="dialog" aria-modal="true" aria-label="Configurar indicadores">
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>⚙️ Indicadores</span>
          <button type="button" className={styles.closeBtn} onClick={onCancel} aria-label="Cerrar">✕</button>
        </div>

        <div className={styles.body}>
          <div className={styles.column}>
            <ActiveIndicatorList
              indicators={draft}
              selectedUid={selectedUid}
              onSelect={handleSelect}
              onToggleVisible={handleToggleVisible}
              onRemove={handleRemove}
              onAddNew={() => { setSelectedUid(null); setRightMode('catalog'); }}
            />
          </div>
          <div className={styles.column}>
            {rightMode === 'edit' && selectedIndicator ? (
              <IndicatorSettingsForm
                key={selectedIndicator.uid}
                indicator={selectedIndicator}
                onChange={handleChangeSelected}
              />
            ) : (
              <IndicatorCatalogPanel onAdd={handleAddFromCatalog} />
            )}
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={saving}>Cancelar</button>
          <button type="button" className={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Utilidad para badges / resumen (no usado dentro del modal pero re-exportado).
export function countIndicators(list) {
  return (list || []).filter((d) => d && INDICATORS[d.type]).length;
}
