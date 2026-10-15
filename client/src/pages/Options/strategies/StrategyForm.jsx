import { useEffect, useMemo, useState } from 'react';
import Sheet from './common/Sheet';
import { ChoiceField, FieldGroup, NumberField, ParamFields, TextField } from './common/Fields';
import { initialParams, normalizeSchema, validateParams } from './common/paramSchema';
import { UNDERLYINGS, templateLabel } from './strategyView';
import ui from './common/ui.module.css';
import styles from './StrategiesTab.module.css';

const NAME_MAX = 80;

function initialState({ strategy, templates, underlying }) {
  if (strategy) {
    const template = templates.find((t) => t.id === strategy.template);
    return {
      name: strategy.name || '',
      template: strategy.template,
      underlying: strategy.underlying || underlying || 'BTC',
      params: initialParams(template, strategy.params),
      maxMarginUsdt: strategy.limits?.maxMarginUsdt ?? null,
      maxDailyLossUsdt: strategy.limits?.maxDailyLossUsdt ?? null,
    };
  }
  const template = templates[0];
  return {
    name: '',
    template: template?.id ?? '',
    underlying: underlying || 'BTC',
    params: initialParams(template),
    maxMarginUsdt: null,
    maxDailyLossUsdt: null,
  };
}

// Validación del formulario completo (nombre, plantilla, parámetros y
// límites). Exportada para los tests.
export function validateStrategyForm(form, schema) {
  const errors = {};
  const name = String(form.name || '').trim();
  if (!name) errors.name = 'Ponle un nombre';
  else if (name.length > NAME_MAX) errors.name = `Máximo ${NAME_MAX} caracteres`;
  if (!form.template) errors.template = 'Elige una plantilla';
  if (!form.underlying) errors.underlying = 'Elige un subyacente';
  for (const key of ['maxMarginUsdt', 'maxDailyLossUsdt']) {
    const v = form[key];
    if (v !== null && v !== undefined && v !== '' && !(Number(v) >= 0)) errors[key] = 'No puede ser negativo';
  }
  const paramErrors = validateParams(schema, form.params);
  if (Object.keys(paramErrors).length) errors.params = paramErrors;
  return errors;
}

// Crear o editar una estrategia. El formulario de parámetros se genera del
// `paramSchema` de la plantilla elegida.
export default function StrategyForm({ open, strategy = null, templates = [], underlying, onCancel, onSubmit }) {
  const editing = !!strategy;
  const [form, setForm] = useState(() => initialState({ strategy, templates, underlying }));
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(initialState({ strategy, templates, underlying }));
    setErrors({});
    setSubmitted(false);
    setServerError(null);
    setSaving(false);
    // Sólo al abrir: las plantillas pueden llegar después sin pisar lo escrito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, strategy?.id]);

  // Si las plantillas llegan con la hoja ya abierta y aún no hay elegida.
  useEffect(() => {
    if (!open || editing || form.template || !templates.length) return;
    setForm((f) => ({ ...f, template: templates[0].id, params: initialParams(templates[0]) }));
  }, [open, editing, form.template, templates]);

  const template = templates.find((t) => t.id === form.template);
  const schema = useMemo(() => normalizeSchema(template?.paramSchema), [template]);

  const update = (patch) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (submitted) setErrors(validateStrategyForm(next, schema));
  };

  const pickTemplate = (id) => {
    const t = templates.find((x) => x.id === id);
    const next = { ...form, template: id, params: initialParams(t) };
    setForm(next);
    if (submitted) setErrors(validateStrategyForm(next, normalizeSchema(t?.paramSchema)));
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    setSubmitted(true);
    const found = validateStrategyForm(form, schema);
    setErrors(found);
    if (Object.keys(found).length) return;
    // 0 o vacío = sin límite propio (sólo el global).
    const limits = { ...(strategy?.limits || {}) };
    for (const key of ['maxMarginUsdt', 'maxDailyLossUsdt']) {
      if (Number(form[key]) > 0) limits[key] = Number(form[key]);
      else delete limits[key];
    }
    const payload = {
      name: form.name.trim(),
      underlying: form.underlying,
      params: form.params,
      limits,
    };
    if (!editing) payload.template = form.template;
    setSaving(true);
    setServerError(null);
    try {
      await onSubmit(payload);
    } catch (err) {
      setServerError(err?.message || 'No se pudo guardar la estrategia');
      setSaving(false);
    }
  };

  const errorCount = Object.keys(errors).filter((k) => k !== 'params').length
    + Object.keys(errors.params || {}).length;

  return (
    <Sheet
      open={open}
      title={editing ? 'Editar estrategia' : 'Nueva estrategia'}
      description={editing
        ? `Plantilla «${templateLabel(templates, form.template)}». Los cambios se aplican en la próxima evaluación.`
        : 'Se crea en pausa. Pruébala en sombra antes de pasarla a real.'}
      onClose={onCancel}
      closeDisabled={saving}
      size="md"
      footer={(
        <>
          <button type="button" className={ui.btn} onClick={onCancel} disabled={saving}>Cancelar</button>
          <button type="submit" form="options-strategy-form" className={`${ui.btn} ${ui.btnPrimary}`} disabled={saving}>
            {saving ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear estrategia'}
          </button>
        </>
      )}
    >
      <form id="options-strategy-form" className={styles.form} onSubmit={submit} noValidate>
        <FieldGroup title="General">
          <TextField
            label="Nombre"
            value={form.name}
            onChange={(name) => update({ name })}
            error={errors.name}
            placeholder="p. ej. Strangle semanal BTC"
            maxLength={NAME_MAX + 20}
          />
          <ChoiceField
            label="Subyacente"
            options={UNDERLYINGS.map((u) => ({ value: u, label: u }))}
            value={form.underlying}
            onChange={(u) => update({ underlying: u })}
            error={errors.underlying}
            columns={3}
          />
        </FieldGroup>

        {!editing && (
          <fieldset className={styles.templateSet}>
            <legend className={styles.legend}>Plantilla</legend>
            {!templates.length && <p className={ui.empty}>Cargando plantillas…</p>}
            {templates.map((t) => {
              const active = t.id === form.template;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.choiceCard} ${active ? styles.choiceCardOn : ''}`}
                  aria-pressed={active}
                  onClick={() => pickTemplate(t.id)}
                >
                  <span className={styles.choiceTitle}>{t.label || templateLabel(templates, t.id)}</span>
                  {t.description && <span className={styles.choiceHint}>{t.description}</span>}
                </button>
              );
            })}
            {errors.template && <span className={styles.fieldError} role="alert">{errors.template}</span>}
          </fieldset>
        )}

        <FieldGroup title="Parámetros">
          <ParamFields
            schema={schema}
            values={form.params}
            errors={errors.params || {}}
            onChange={(params) => update({ params })}
          />
        </FieldGroup>

        <FieldGroup title="Límites de la estrategia">
          <NumberField
            label="Margen máximo"
            help="0 o vacío: sólo aplica el límite global"
            unit="USDT"
            value={form.maxMarginUsdt}
            min={0}
            step={100}
            error={errors.maxMarginUsdt}
            onChange={(v) => update({ maxMarginUsdt: v })}
          />
          <NumberField
            label="Pérdida diaria máx."
            unit="USDT"
            value={form.maxDailyLossUsdt}
            min={0}
            step={50}
            error={errors.maxDailyLossUsdt}
            onChange={(v) => update({ maxDailyLossUsdt: v })}
          />
        </FieldGroup>

        {submitted && errorCount > 0 && (
          <p className={`${ui.alert} ${ui.alertError}`} role="alert">
            Revisa {errorCount === 1 ? 'el campo marcado' : `los ${errorCount} campos marcados`}.
          </p>
        )}
        {serverError && <p className={`${ui.alert} ${ui.alertError}`} role="alert">{serverError}</p>}
      </form>
    </Sheet>
  );
}
