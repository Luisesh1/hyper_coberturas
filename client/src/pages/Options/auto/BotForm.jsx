import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Sheet from '../strategies/common/Sheet';
import { ChoiceField, FieldGroup, NumberField, TextField } from '../strategies/common/Fields';
import { UNDERLYINGS } from '../strategies/strategyView';
import { autoBotsApi } from '../autoTradingApi';
import DirectionChip from './DirectionChip';
import Mapping from './Mapping';
import {
  NAME_MAX, ON_OPPOSITE, STRUCTURES, STRUCTURE_INFO, alertMeta, buildBotPayload,
  initialBotForm, normalizeAlert, structureLabels, validateBotForm, withStructure,
} from './botView';
import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

// Alertas elegibles (no neutrales y del subyacente) como casillas grandes.
function AlertPicker({ underlying, alerts, loading, error, selected, onToggle, onRetry, invalid }) {
  if (loading && !alerts.length) return <p className={ui.empty}>Cargando alertas de {underlying}…</p>;
  if (error && !alerts.length) {
    return (
      <div className={`${ui.alert} ${ui.alertError}`} role="alert">
        <span>No se pudieron cargar las alertas: {error.message}</span>
        <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={onRetry}>Reintentar</button>
      </div>
    );
  }
  if (!alerts.length) {
    return (
      <div className={styles.alertEmpty}>
        <p>
          No tienes alertas alcistas o bajistas de {underlying}. Las neutrales no operan.
        </p>
        <Link to="/alertas" className={`${ui.btn} ${ui.btnSmall}`}>Crear o editar alertas</Link>
      </div>
    );
  }
  return (
    <ul className={`${styles.alertPick} ${invalid ? styles.alertPickInvalid : ''}`} aria-label={`Alertas de ${underlying}`}>
      {alerts.map((a) => {
        const on = selected.includes(a.id);
        return (
          <li key={a.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              className={`${styles.alertPickRow} ${on ? styles.alertPickRowOn : ''}`}
              onClick={() => onToggle(a.id)}
            >
              <span className={`${styles.checkBox} ${on ? styles.checkBoxOn : ''}`} aria-hidden="true">{on && <CheckGlyph />}</span>
              <span className={styles.alertPickText}>
                <span className={styles.alertPickName}>{a.name}</span>
                {alertMeta(a) && <span className={styles.alertPickMeta}>{alertMeta(a)}</span>}
              </span>
              <DirectionChip direction={a.direction} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Crear o editar un bot. Al crear se elige el subyacente; al editar no
// (PUT /options/auto-bots/:id no lo admite).
export default function BotForm({ open, bot = null, underlying = 'BTC', onCancel, onSubmit }) {
  const editing = !!bot;
  const [form, setForm] = useState(() => initialBotForm({ bot, underlying }));
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [eligible, setEligible] = useState({ loading: false, error: null, list: [], underlying: null });
  const reqId = useRef(0);

  useEffect(() => {
    if (!open) return;
    setForm(initialBotForm({ bot, underlying: UNDERLYINGS.includes(underlying) ? underlying : 'BTC' }));
    setErrors({});
    setSubmitted(false);
    setServerError(null);
    setSaving(false);
    // Sólo al abrir (o al cambiar de bot): no pisar lo que se está escribiendo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot?.id]);

  const loadEligible = (u) => {
    const id = ++reqId.current;
    setEligible((e) => ({ ...e, loading: true, error: null, underlying: u, list: e.underlying === u ? e.list : [] }));
    autoBotsApi.eligibleAlerts(u)
      .then((data) => {
        if (id !== reqId.current) return;
        setEligible({ loading: false, error: null, underlying: u, list: (Array.isArray(data) ? data : []).map(normalizeAlert) });
      })
      .catch((err) => {
        if (id === reqId.current) setEligible({ loading: false, error: err, underlying: u, list: [] });
      });
  };

  useEffect(() => {
    if (!open || !form.underlying) return;
    loadEligible(form.underlying);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.underlying]);

  // Al editar se muestran también las alertas ya vinculadas aunque hayan
  // dejado de ser elegibles (para poder desvincularlas).
  const alertOptions = (() => {
    const list = [...eligible.list];
    if (editing) {
      for (const a of bot.alerts || []) {
        if (form.alertIds.includes(a.id) && !list.some((x) => x.id === a.id)) list.push(a);
      }
    }
    return list;
  })();

  const update = (patch) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (submitted) setErrors(validateBotForm(next));
  };

  const pickUnderlying = (u) => {
    if (u === form.underlying) return;
    // Las alertas son de un activo concreto: al cambiar de subyacente se vacían.
    update({ underlying: u, alertIds: [] });
  };

  const toggleAlert = (id) => {
    const ids = form.alertIds.includes(id) ? form.alertIds.filter((x) => x !== id) : [...form.alertIds, id];
    update({ alertIds: ids });
  };

  const pickStructure = (s) => {
    if (s === form.structure) return;
    const next = withStructure(form, s);
    setForm(next);
    if (submitted) setErrors(validateBotForm(next));
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    setSubmitted(true);
    const found = validateBotForm(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    setServerError(null);
    try {
      await onSubmit(buildBotPayload(form, { editing, baseLimits: bot?.limits }));
    } catch (err) {
      setServerError(err?.message || 'No se pudo guardar el bot');
      setSaving(false);
    }
  };

  const labels = structureLabels(form.structure);
  const buy = form.structure === 'buy_with';
  const errorCount = Object.keys(errors).length;
  const onStructureKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    pickStructure(STRUCTURES[(STRUCTURES.indexOf(form.structure) + 1) % STRUCTURES.length]);
  };

  return (
    <Sheet
      open={open}
      title={editing ? 'Editar bot' : 'Nuevo bot'}
      description={editing
        ? `${bot.underlying} · los cambios se aplican a la próxima señal.`
        : 'Se crea en modo sombra: opera con llenados simulados hasta que lo pases a Real.'}
      onClose={onCancel}
      closeDisabled={saving}
      size="md"
      footer={(
        <>
          <button type="button" className={ui.btn} onClick={onCancel} disabled={saving}>Cancelar</button>
          <button type="submit" form="options-auto-bot-form" className={`${ui.btn} ${ui.btnPrimary}`} disabled={saving}>
            {saving ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear bot'}
          </button>
        </>
      )}
    >
      <form id="options-auto-bot-form" className={styles.form} onSubmit={submit} noValidate>
        <FieldGroup title="General">
          <TextField
            label="Nombre"
            value={form.name}
            onChange={(name) => update({ name })}
            error={errors.name}
            placeholder="p. ej. Momentum BTC (MACD 15m)"
            maxLength={NAME_MAX + 20}
          />
          {editing ? (
            <div className={styles.staticRow}>
              <span>Subyacente</span>
              <span className={ui.mono}>{form.underlying}</span>
            </div>
          ) : (
            <ChoiceField
              label="Subyacente"
              options={UNDERLYINGS.map((u) => ({ value: u, label: u }))}
              value={form.underlying}
              onChange={pickUnderlying}
              error={errors.underlying}
              columns={3}
            />
          )}
        </FieldGroup>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>1 · Señales (alertas)</legend>
          <AlertPicker
            underlying={form.underlying}
            alerts={alertOptions}
            loading={eligible.loading}
            error={eligible.error}
            selected={form.alertIds}
            onToggle={toggleAlert}
            onRetry={() => loadEligible(form.underlying)}
            invalid={!!errors.alertIds}
          />
          {errors.alertIds && <span className={styles.fieldError} role="alert">{errors.alertIds}</span>}
          <p className={styles.note}>
            Solo se listan alertas alcistas o bajistas cuyo activo tiene opciones en Binance. Las neutrales no operan.
          </p>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>2 · Qué hacer con la señal</legend>
          <div role="radiogroup" aria-label="Estructura" className={styles.structureGrid} onKeyDown={onStructureKey}>
            {STRUCTURES.map((s) => {
              const on = s === form.structure;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  className={`${styles.structureCard} ${on ? styles.structureCardOn : ''}`}
                  onClick={() => pickStructure(s)}
                >
                  <span className={styles.structureTitle}>{STRUCTURE_INFO[s].label}</span>
                  <span className={styles.structureHint}>{STRUCTURE_INFO[s].hint}</span>
                </button>
              );
            })}
          </div>
          <Mapping structure={form.structure} targetDelta={form.targetDelta} expiryDays={form.expiryDays} />
        </fieldset>

        <FieldGroup title="Entrada">
          <NumberField
            label="Delta objetivo"
            help={buy ? 'Valor absoluto: call +Δ, put −Δ' : 'Valor absoluto de la pata vendida'}
            value={form.targetDelta}
            min={0.05}
            max={0.95}
            step={0.05}
            error={errors.targetDelta}
            onChange={(v) => update({ targetDelta: v })}
          />
          <NumberField
            label="Vencimiento"
            help="El más cercano a estos días"
            unit="días"
            value={form.expiryDays}
            min={1}
            max={90}
            integer
            error={errors.expiryDays}
            onChange={(v) => update({ expiryDays: v })}
          />
          <NumberField
            label="Cantidad"
            unit={form.underlying}
            value={form.quantity}
            min={0.0001}
            step={0.01}
            error={errors.quantity}
            onChange={(v) => update({ quantity: v })}
          />
          <ChoiceField
            label="Si llega la señal contraria"
            help={(ON_OPPOSITE.find((o) => o.value === form.onOpposite) || ON_OPPOSITE[0]).help}
            options={ON_OPPOSITE.map((o) => ({ value: o.value, label: o.label }))}
            value={form.onOpposite}
            onChange={(v) => update({ onOpposite: v })}
            columns={3}
          />
        </FieldGroup>

        <FieldGroup title="3 · Salidas">
          <NumberField
            label={labels.takeProfit}
            help={labels.takeProfitHelp}
            unit="%"
            value={form.takeProfitPct}
            min={1}
            max={1000}
            step={5}
            error={errors.takeProfitPct}
            onChange={(v) => update({ takeProfitPct: v })}
          />
          <NumberField
            label={labels.stopLoss}
            help={labels.stopLossHelp}
            unit="%"
            value={form.stopLossPct}
            min={1}
            max={1000}
            step={buy ? 5 : 25}
            error={errors.stopLossPct}
            onChange={(v) => update({ stopLossPct: v })}
          />
          <NumberField
            label="Cerrar antes del venc."
            unit="h"
            value={form.exitHoursBeforeExpiry}
            min={0}
            max={168}
            integer
            error={errors.exitHoursBeforeExpiry}
            onChange={(v) => update({ exitHoursBeforeExpiry: v })}
          />
        </FieldGroup>

        <FieldGroup title="4 · Riesgo">
          <NumberField
            label="Posiciones abiertas máx."
            value={form.maxOpenPositions}
            min={1}
            max={20}
            integer
            error={errors.maxOpenPositions}
            onChange={(v) => update({ maxOpenPositions: v })}
          />
          <NumberField
            label="Operaciones por día"
            value={form.maxTradesPerDay}
            min={1}
            max={100}
            integer
            error={errors.maxTradesPerDay}
            onChange={(v) => update({ maxTradesPerDay: v })}
          />
          {buy ? (
            <NumberField
              label={labels.risk}
              help="0 o vacío: sin límite propio"
              unit="USDT"
              value={form.maxPremiumUsdt}
              min={0}
              step={10}
              error={errors.maxPremiumUsdt}
              onChange={(v) => update({ maxPremiumUsdt: v })}
            />
          ) : (
            <NumberField
              label={labels.risk}
              help="0 o vacío: sólo aplica el límite global"
              unit="USDT"
              value={form.maxMarginUsdt}
              min={0}
              step={100}
              error={errors.maxMarginUsdt}
              onChange={(v) => update({ maxMarginUsdt: v })}
            />
          )}
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
