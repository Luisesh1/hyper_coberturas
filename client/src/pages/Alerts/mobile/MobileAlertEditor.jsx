import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import BottomSheet from '../../TradingView/components/BottomSheet';
import { AlertRuleRow } from '../components/AlertRuleRow';
import { DirectionChip, DirectionSelector } from '../components/Direction';
import TestResultView from '../components/TestResultView';
import { botModeLabel, botOpensLabel, normalizeDirection } from '../lib/direction';
import { COOLDOWN_PRESETS, cooldownLabel } from '../lib/labels';
import RuleSummaryCard from './RuleSummaryCard';
import styles from './MobileAlertEditor.module.css';

const THRESHOLD_STEP = 5;
const clampThreshold = (v) => Math.min(100, Math.max(0, v));

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

// Editor móvil (Pantalla 2): cabecera fija, General compacta, Activos,
// reglas como tarjetas‑resumen y barra inferior fija con Probar / Guardar.
// Todo el estado vive en AlertsPage; aquí solo se presenta.
export default function MobileAlertEditor({
  form,
  selectedId,
  isSaving,
  effectiveDirty,
  saveValidationError,
  updateField,
  onBack,
  onSave,
  onRemove,
  onTest,
  onToggleActive,
  isTogglingActive,
  editorMode,
  rawText,
  rawError,
  onRawTextChange,
  onOpenRaw,
  onOpenVisual,
  onRefreshRaw,
  onApplyRaw,
  onCopyConfig,
  showPresets,
  presets,
  onApplyPreset,
  datasources,
  telegramPreview,
  showUsedBy,
  usedByBots,
  directionNote,
  showNeutralWarning,
  assetInput,
  onAssetInput,
  onAddAsset,
  onRemoveAsset,
  onOpenPicker,
  onOpenRule,
  onAddRule,
  openRuleIndex,
  updateRule,
  removeRule,
}) {
  const ids = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [testSheet, setTestSheet] = useState(null);
  const [testing, setTesting] = useState(false);

  const direction = normalizeDirection(form.direction);
  const threshold = Number(form.thresholdPercent) || 0;
  const cooldown = Number(form.cooldownSeconds);
  const cooldownKnown = COOLDOWN_PRESETS.some((p) => p.value === cooldown);
  const ds = datasources.find((d) => d.value === form.datasource);
  const dsShort = ds?.short || ds?.label || form.datasource;
  const title = form.name.trim() || (selectedId ? 'Sin nombre' : 'Nueva alerta');
  const canTest = !!selectedId && !effectiveDirty;
  const saveDisabled = isSaving || !!saveValidationError || (!effectiveDirty && !!selectedId);

  const runMenu = (fn) => () => { setMenuOpen(false); fn(); };

  const runTest = async () => {
    if (!canTest || testing) return;
    setTesting(true);
    try {
      const data = await onTest();
      if (data?.results) setTestSheet(data);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <button type="button" className={styles.iconBtn} onClick={onBack} aria-label="Volver a alertas">
          <BackIcon />
        </button>
        <div className={styles.headText}>
          <h1 className={styles.srOnly}>{selectedId ? 'Editar alerta' : 'Nueva alerta'}</h1>
          <div className={styles.headTitle} aria-hidden="true">{title}</div>
          {effectiveDirty && <div className={styles.dirty}>● Cambios sin guardar</div>}
        </div>
        <button type="button" className={`${styles.iconBtn} ${styles.iconBtnBorder}`} onClick={() => setMenuOpen(true)} aria-label="Más acciones">
          <MoreIcon />
        </button>
      </header>

      <div className={styles.body}>
        {showPresets && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Comienza con una plantilla</h2>
            <p className={styles.hint}>Elige un patrón común y ajústalo, o crea uno desde cero.</p>
            <div className={styles.presets}>
              {presets.map((p) => (
                <button key={p.id} type="button" className={styles.preset} onClick={() => onApplyPreset(p)}>
                  <span className={styles.presetHead}>
                    <span aria-hidden="true">{p.icon}</span>
                    <span className={styles.presetTitle}>{p.title}</span>
                    <DirectionChip direction={p.direction} />
                  </span>
                  <span className={styles.presetDesc}>{p.description}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {editorMode === 'raw' ? (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Configuración JSON</h2>
            <p className={styles.hint}>Edita o pega una configuración JSON de alerta.</p>
            <textarea
              className={styles.raw}
              aria-label="Configuración JSON"
              value={rawText}
              spellCheck={false}
              onChange={(e) => onRawTextChange(e.target.value)}
            />
            {rawError && <div className={styles.error} role="alert">{rawError}</div>}
            <div className={styles.rawActions}>
              <button type="button" className={styles.secondaryBtn} onClick={onRefreshRaw}>Regenerar desde visual</button>
              <button type="button" className={styles.secondaryBtn} onClick={() => onApplyRaw()}>Aplicar al formulario</button>
            </div>
          </section>
        ) : (
          <>
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle}>General</h2>
                {/* Guardada: se guarda al momento, como en escritorio y la lista.
                    Nueva: es un campo más del formulario. */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!form.isActive}
                  className={`${styles.switchBtn} ${form.isActive ? styles.switchOn : ''}`}
                  disabled={!!selectedId && (isSaving || isTogglingActive || effectiveDirty)}
                  title={selectedId && effectiveDirty ? 'Guarda o descarta los cambios antes de activar/desactivar' : undefined}
                  onClick={() => (selectedId ? onToggleActive() : updateField('isActive', !form.isActive))}
                >
                  <span className={styles.switchLabel}>Activa</span>
                  <span className={styles.switchTrack} aria-hidden="true"><span className={styles.switchThumb} /></span>
                </button>
              </div>

              <label className={styles.field}>
                <span className={styles.label}>Nombre</span>
                <input
                  className={styles.input}
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="Ej: BTC RSI sobreventa"
                />
              </label>

              <div className={styles.pair}>
                <div className={styles.field}>
                  <span className={styles.label} id={`${ids}-thr`}>Umbral</span>
                  <div className={styles.stepper} role="group" aria-labelledby={`${ids}-thr`}>
                    <button
                      type="button"
                      className={styles.stepBtn}
                      aria-label="Bajar umbral"
                      disabled={threshold <= 0}
                      onClick={() => updateField('thresholdPercent', clampThreshold(threshold - THRESHOLD_STEP))}
                    >
                      −
                    </button>
                    <span className={styles.stepValue} aria-live="polite">{threshold} %</span>
                    <button
                      type="button"
                      className={styles.stepBtn}
                      aria-label="Subir umbral"
                      disabled={threshold >= 100}
                      onClick={() => updateField('thresholdPercent', clampThreshold(threshold + THRESHOLD_STEP))}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`${ids}-cd`}>Cooldown</label>
                  <select
                    id={`${ids}-cd`}
                    className={styles.input}
                    value={String(cooldown)}
                    onChange={(e) => updateField('cooldownSeconds', Number(e.target.value))}
                  >
                    {!cooldownKnown && <option value={String(cooldown)}>{cooldownLabel(cooldown)}</option>}
                    {COOLDOWN_PRESETS.map((p) => <option key={p.value} value={String(p.value)}>{p.label}</option>)}
                  </select>
                </div>
              </div>

              <div className={styles.field}>
                <span className={styles.label}>Dirección de la señal</span>
                <div className={styles.dirGrid}>
                  <DirectionSelector value={direction} onChange={(next) => updateField('direction', next)} mobile />
                </div>
                <p
                  className={`${styles.dirNote} ${showNeutralWarning ? styles.dirNoteWarning : ''}`}
                  role={showNeutralWarning ? 'alert' : undefined}
                  data-testid="direction-note"
                >
                  {directionNote}
                </p>
              </div>

              <button
                type="button"
                className={styles.moreLink}
                aria-expanded={moreOpen}
                aria-controls={`${ids}-more`}
                onClick={() => setMoreOpen((v) => !v)}
              >
                Más opciones · {dsShort} · Telegram {form.telegramEnabled ? 'sí' : 'no'} {moreOpen ? '⌄' : '›'}
              </button>

              {moreOpen && (
                <div className={styles.more} id={`${ids}-more`}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`${ids}-ds`}>Datasource</label>
                    <select
                      id={`${ids}-ds`}
                      className={styles.input}
                      value={form.datasource}
                      onChange={(e) => updateField('datasource', e.target.value)}
                    >
                      {datasources.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                  </div>
                  <label className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={!!form.telegramEnabled}
                      onChange={(e) => updateField('telegramEnabled', e.target.checked)}
                    />
                    Enviar a Telegram (config en /config)
                  </label>
                  <div className={styles.field}>
                    <span className={styles.label}>Vista previa en Telegram</span>
                    <div className={styles.preview} data-testid="telegram-preview">{telegramPreview}</div>
                  </div>
                  {showUsedBy && (
                    <div className={styles.field} data-testid="used-by">
                      <span className={styles.label}>
                        Usada por {usedByBots.length} bot{usedByBots.length === 1 ? '' : 's'}
                      </span>
                      {usedByBots.map((b) => (
                        <Link key={b.id} to="/opciones?tab=auto" className={styles.botLink}>
                          <span className={styles.botName}>{b.name}</span>
                          <span className={styles.botMeta}>{botModeLabel(b.mode)} · {botOpensLabel(b.structure, direction)}</span>
                        </Link>
                      ))}
                      {usedByBots.length === 0 && (
                        <p className={styles.hint}>Ningún bot la usa todavía. Vincúlala desde Opciones › Trading automatizado.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle}>Activos ({form.assetList.length})</h2>
                <button type="button" className={styles.secondaryBtn} onClick={onOpenPicker}>+ Añadir</button>
              </div>
              <div className={styles.assets}>
                {form.assetList.map((a) => (
                  <span key={a} className={styles.asset}>
                    {a}
                    <button type="button" className={styles.assetRemove} aria-label={`Quitar ${a}`} onClick={() => onRemoveAsset(a)}>✕</button>
                  </span>
                ))}
              </div>
              <div className={styles.symbolRow}>
                <input
                  className={styles.input}
                  aria-label="Símbolo"
                  value={assetInput}
                  autoCapitalize="characters"
                  enterKeyHint="done"
                  placeholder={`Símbolo (${form.datasource === 'hyperliquid' ? 'BTC' : 'BTCUSDT'})`}
                  onChange={(e) => onAssetInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onAddAsset();
                    }
                  }}
                />
                <button type="button" className={styles.secondaryBtn} onClick={onAddAsset} disabled={!assetInput.trim()}>
                  Añadir
                </button>
              </div>
            </section>

            <section className={styles.card}>
              <div className={styles.rulesHead}>
                <h2 className={styles.cardTitle}>Reglas ({form.rules.length})</h2>
                <span className={styles.hint}>dispara con ≥ {threshold} % del peso</span>
              </div>
              {form.rules.map((rule, i) => (
                <div key={rule.id || i} className={styles.ruleItem}>
                  <RuleSummaryCard index={i} rule={rule} onOpen={onOpenRule} />
                  {/* Provisional hasta la hoja de regla: el editor de siempre, en línea. */}
                  {openRuleIndex === i && form.rules[i] && (
                    <div data-testid="rule-editor" className={styles.ruleEditor}>
                      <AlertRuleRow
                        index={i}
                        rule={rule}
                        onChange={(next) => updateRule(i, next)}
                        onRemove={() => removeRule(i)}
                      />
                    </div>
                  )}
                </div>
              ))}
              <button type="button" className={styles.addRule} onClick={onAddRule}>+ Añadir regla</button>
            </section>

          </>
        )}
      </div>

      <div className={styles.mobileCtaBar}>
        {saveValidationError && (effectiveDirty || !selectedId) && (
          <div className={styles.barError}>{saveValidationError}</div>
        )}
        <button
          type="button"
          className={styles.testBtn}
          onClick={runTest}
          disabled={!canTest || testing}
          title={!selectedId ? 'Guarda la alerta antes de probarla' : (effectiveDirty ? 'Guarda primero los cambios para probar' : 'Evalúa la alerta con las últimas velas, sin enviar Telegram')}
        >
          {testing ? 'Probando…' : 'Probar'}
        </button>
        <button
          type="button"
          className={styles.saveBtn}
          onClick={onSave}
          disabled={saveDisabled}
          title={saveValidationError || (!effectiveDirty && selectedId ? 'No hay cambios para guardar' : '')}
        >
          {isSaving ? 'Guardando…' : (selectedId ? 'Guardar cambios' : 'Crear alerta')}
        </button>
      </div>

      <BottomSheet open={menuOpen} title="Acciones" actionLabel="Cerrar" onClose={() => setMenuOpen(false)}>
        <div className={styles.menu}>
          {editorMode === 'raw' ? (
            <button type="button" className={styles.menuItem} onClick={runMenu(onOpenVisual)}>Modo visual</button>
          ) : (
            <button type="button" className={styles.menuItem} onClick={runMenu(onOpenRaw)}>Modo JSON</button>
          )}
          <button type="button" className={styles.menuItem} onClick={runMenu(onCopyConfig)}>Copiar config</button>
          {selectedId && (
            <button type="button" className={`${styles.menuItem} ${styles.menuDanger}`} onClick={runMenu(onRemove)} disabled={isSaving}>
              Eliminar alerta
            </button>
          )}
        </div>
      </BottomSheet>

      <BottomSheet open={!!testSheet} title={`Prueba · ${title}`} onClose={() => setTestSheet(null)}>
        {testSheet && (
          <>
            <p className={styles.hint}>Prueba sin enviar a Telegram.</p>
            <TestResultView result={testSheet} />
          </>
        )}
      </BottomSheet>
    </div>
  );
}
