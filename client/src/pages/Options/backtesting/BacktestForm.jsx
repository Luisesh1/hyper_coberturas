import { useId, useMemo } from 'react';
import { ChoiceField, FieldGroup, NumberField, ParamFields, TextField } from '../strategies/common/Fields';
import { initialParams, normalizeSchema } from '../strategies/common/paramSchema';
import { UNDERLYINGS, templateLabel } from '../strategies/strategyView';
import { BOT_SOURCE_REASON, DVOL_UNDERLYINGS, SOURCES, parseSelection, sourceAvailable } from './backtestView';
import styles from './BacktestingTab.module.css';

// Formulario del backtest. Es el mismo en la columna de escritorio y en la
// hoja inferior del teléfono (`mobile` sólo acorta los textos de las fuentes).
export default function BacktestForm({ form, onChange, strategies, bots = [], templates, errors = {}, disabled = false, mobile = false }) {
  const selectId = useId();
  const sel = parseSelection(form.selection);
  const template = sel?.kind === 'template' ? templates.find((t) => t.id === sel.id) : null;
  const schema = useMemo(() => normalizeSchema(template?.paramSchema), [template]);

  const selectedBot = sel?.kind === 'strategy' ? bots.find((b) => String(b.id) === sel.id) : null;
  const isBot = !!selectedBot;
  // Un bot multi-subyacente se prueba con un subyacente a la vez, de los suyos.
  const botUnderlyings = selectedBot?.underlyings?.length > 1 ? selectedBot.underlyings : null;

  const set = (patch) => {
    const next = { ...form, ...patch };
    // Los bots no admiten la fuente «registrada».
    const nextSel = parseSelection(next.selection);
    if (next.source === 'recorded' && nextSel?.kind === 'strategy' && bots.some((b) => String(b.id) === nextSel.id)) {
      next.source = DVOL_UNDERLYINGS.includes(next.underlying) ? 'dvol' : 'realized';
    }
    // DVOL sólo existe para BTC/ETH: al cambiar a otro subyacente se pasa a
    // volatilidad realizada en vez de dejar una combinación imposible.
    if (!sourceAvailable(next.source, next.underlying)) next.source = 'realized';
    onChange(next);
  };

  const onSelection = (value) => {
    const parsed = parseSelection(value);
    const patch = { selection: value };
    if (parsed?.kind === 'strategy') {
      const s = [...strategies, ...bots].find((x) => String(x.id) === parsed.id);
      if (s?.underlying) patch.underlying = s.underlying;
      if (s?.underlyings?.length > 1 && !s.underlyings.includes(patch.underlying)) patch.underlying = s.underlyings[0];
      patch.params = {};
    } else if (parsed?.kind === 'template') {
      patch.params = initialParams(templates.find((t) => t.id === parsed.id));
    }
    set(patch);
  };

  const dvolDisabled = !DVOL_UNDERLYINGS.includes(form.underlying);

  return (
    <div className={styles.formFields}>
      <div className={styles.selectField}>
        <label htmlFor={selectId} className={styles.fieldLabel}>Estrategia</label>
        <select
          id={selectId}
          className={styles.select}
          value={form.selection}
          onChange={(e) => onSelection(e.target.value)}
          disabled={disabled}
          aria-invalid={errors.selection ? 'true' : undefined}
        >
          <option value="">Elige una estrategia…</option>
          {strategies.length > 0 && (
            <optgroup label="Mis estrategias">
              {strategies.map((s) => (
                <option key={s.id} value={`s:${s.id}`}>{s.name} · {s.underlying}</option>
              ))}
            </optgroup>
          )}
          {bots.length > 0 && (
            <optgroup label="Mis bots (por alertas)">
              {bots.map((b) => (
                <option key={b.id} value={`s:${b.id}`}>{b.name} · {b.underlying} · bot</option>
              ))}
            </optgroup>
          )}
          {templates.length > 0 && (
            <optgroup label="Plantilla con parámetros propios">
              {templates.map((t) => (
                <option key={t.id} value={`t:${t.id}`}>{t.label || templateLabel(templates, t.id)}</option>
              ))}
            </optgroup>
          )}
        </select>
        {errors.selection && <span className={styles.fieldError} role="alert">{errors.selection}</span>}
      </div>

      {template && (
        <FieldGroup title={`Parámetros · ${template.label || templateLabel(templates, template.id)}`}>
          <ParamFields
            schema={schema}
            values={form.params}
            errors={errors.params || {}}
            onChange={(params) => set({ params })}
            disabled={disabled}
          />
        </FieldGroup>
      )}

      <FieldGroup title="Mercado y periodo">
        <ChoiceField
          label="Subyacente"
          help={botUnderlyings ? 'Se prueba un subyacente a la vez; los límites se aplican solo a él' : undefined}
          options={(botUnderlyings || UNDERLYINGS).map((u) => ({ value: u, label: u }))}
          value={form.underlying}
          onChange={(u) => set({ underlying: u })}
          error={errors.underlying}
          columns={3}
          disabled={disabled}
        />
        <div className={styles.dateRow}>
          <TextField label="Desde" type="date" value={form.from} onChange={(from) => set({ from })} error={errors.from} disabled={disabled} />
          <TextField label="Hasta" type="date" value={form.to} onChange={(to) => set({ to })} error={errors.to} disabled={disabled} />
        </div>
        <NumberField
          label="Capital inicial"
          unit="USDT"
          value={form.capitalUsdt}
          min={0}
          step={500}
          error={errors.capitalUsdt}
          onChange={(capitalUsdt) => set({ capitalUsdt })}
          disabled={disabled}
        />
      </FieldGroup>

      <fieldset className={styles.sourceSet} disabled={disabled}>
        <legend className={styles.legend}>Fuente de precios de las opciones</legend>
        {SOURCES.map((src) => {
          const active = form.source === src.key;
          const unavailable = (src.key === 'dvol' && dvolDisabled) || (src.key === 'recorded' && isBot);
          return (
            <button
              key={src.key}
              type="button"
              className={`${styles.sourceCard} ${active ? styles.sourceCardOn : ''}`}
              aria-pressed={active}
              disabled={disabled || unavailable}
              onClick={() => set({ source: src.key })}
            >
              <span className={styles.sourceTitle}>{src.label}</span>
              <span className={styles.sourceHint}>{mobile ? src.hintShort : src.hint}</span>
              {src.key === 'recorded' && isBot && <span className={styles.sourceWarn}>{BOT_SOURCE_REASON}</span>}
              {src.key === 'dvol' && unavailable && (
                <span className={styles.sourceWarn}>No disponible para {form.underlying}: Deribit solo publica DVOL de BTC y ETH.</span>
              )}
            </button>
          );
        })}
        {errors.source && <span className={styles.fieldError} role="alert">{errors.source}</span>}
      </fieldset>

      <FieldGroup title="Costes simulados">
        <NumberField
          label="Spread simulado"
          help="Se aplica sobre la prima teórica"
          unit="%"
          value={form.spreadPct}
          min={0}
          max={50}
          step={0.5}
          error={errors.spreadPct}
          onChange={(spreadPct) => set({ spreadPct })}
          disabled={disabled}
        />
        <NumberField
          label="Comisión"
          unit="%"
          value={form.feePct}
          min={0}
          max={5}
          step={0.01}
          error={errors.feePct}
          onChange={(feePct) => set({ feePct })}
          disabled={disabled}
        />
        {form.source === 'realized' && (
          <NumberField
            label="Prima de volatilidad"
            help="Se suma a la volatilidad realizada a 30 días"
            unit="%"
            value={form.volPremiumPct}
            min={-50}
            max={200}
            step={1}
            error={errors.volPremiumPct}
            onChange={(volPremiumPct) => set({ volPremiumPct })}
            disabled={disabled}
          />
        )}
      </FieldGroup>
    </div>
  );
}
