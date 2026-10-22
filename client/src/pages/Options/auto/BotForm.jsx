import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Sheet from '../strategies/common/Sheet';
import { ChoiceField, FieldGroup, MultiChoiceField, NumberField, TextField } from '../strategies/common/Fields';
import { UNDERLYINGS } from '../strategies/strategyView';
import { autoBotsApi } from '../autoTradingApi';
import DirectionChip from './DirectionChip';
import Mapping from './Mapping';
import {
  NAME_MAX, ON_OPPOSITE, STRUCTURES, STRUCTURE_INFO, ATR_BAND_INTERVALS, ATR_BAND_NOTE, ATR_BAND_SWITCH_WARNING, alertMeta, buildBotPayload,
  coveredList, initialBotForm, normalizeAlert, perSignalBudget, structureLabels, takeProfitModesFor, validateBotForm, withStructure, withTakeProfitMode,
} from './botView';
import { formatNumber } from '../strategies/common/format';
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
function AlertPicker({ underlyings, alerts, loading, error, selected, onToggle, onRetry, invalid }) {
  if (loading && !alerts.length) return <p className={ui.empty}>Cargando alertas de {underlyings.join(', ')}…</p>;
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
          No tienes alertas alcistas o bajistas de {underlyings.join(', ')}. Las neutrales no operan.
        </p>
        <Link to="/alertas" className={`${ui.btn} ${ui.btnSmall}`}>Crear o editar alertas</Link>
      </div>
    );
  }
  return (
    <ul className={`${styles.alertPick} ${invalid ? styles.alertPickInvalid : ''}`} aria-label={`Alertas de ${underlyings.join(', ')}`}>
      {alerts.map((a) => {
        const on = selected.includes(a.id);
        const covers = coveredList(a, underlyings);
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
                {underlyings.length > 1 && covers.length > 0 && (
                  <span className={styles.alertPickMeta}>Cubre {covers.join(', ')}</span>
                )}
              </span>
              <DirectionChip direction={a.direction} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Crear o editar un bot. Los subyacentes son de selección múltiple; quitar
// uno con posiciones abiertas lo rechaza el servidor (409) y se muestra aquí.
export default function BotForm({ open, bot = null, underlying = 'BTC', onCancel, onSubmit }) {
  const editing = !!bot;
  const [form, setForm] = useState(() => initialBotForm({ bot, underlying }));
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [eligible, setEligible] = useState({ loading: false, error: null, list: [], key: null });
  const reqId = useRef(0);
  const underlyingsKey = form.underlyings.join(',');

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
    setEligible((e) => ({ ...e, loading: true, error: null, key: u, list: e.key === u ? e.list : [] }));
    autoBotsApi.eligibleAlerts(u)
      .then((data) => {
        if (id !== reqId.current) return;
        setEligible({ loading: false, error: null, key: u, list: (Array.isArray(data) ? data : []).map(normalizeAlert) });
      })
      .catch((err) => {
        if (id === reqId.current) setEligible({ loading: false, error: err, key: u, list: [] });
      });
  };

  useEffect(() => {
    if (!open || !underlyingsKey) return;
    loadEligible(underlyingsKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, underlyingsKey]);

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

  const validate = (f) => validateBotForm(f, { alerts: alertOptions });

  const update = (patch) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (submitted) setErrors(validate(next));
  };

  const toggleUnderlying = (u) => {
    const on = form.underlyings.includes(u);
    if (on && form.underlyings.length === 1) return; // al menos uno
    const underlyings = on ? form.underlyings.filter((x) => x !== u) : [...form.underlyings, u];
    // Se sueltan las alertas marcadas que ya no cubren ninguno de los elegidos.
    const alertIds = on
      ? form.alertIds.filter((id) => {
        const a = alertOptions.find((x) => x.id === id);
        return !a || coveredList(a, underlyings).length > 0;
      })
      : form.alertIds;
    update({ underlyings, alertIds });
  };

  const toggleAlert = (id) => {
    const ids = form.alertIds.includes(id) ? form.alertIds.filter((x) => x !== id) : [...form.alertIds, id];
    update({ alertIds: ids });
  };

  const pickStructure = (s) => {
    if (s === form.structure) return;
    const next = withStructure(form, s, { editing });
    setForm(next);
    if (submitted) setErrors(validate(next));
  };

  const pickTakeProfitMode = (mode) => {
    const next = withTakeProfitMode(form, mode);
    setForm(next);
    if (submitted) setErrors(validate(next));
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    setSubmitted(true);
    const found = validate(form);
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
  const atrBand = form.takeProfitMode === 'atr_band';
  const perSignal = perSignalBudget(form);
  const hasBudget = form.budgetUsdt !== null && form.budgetUsdt !== undefined && form.budgetUsdt !== '';
  const hasOpenPositions = (bot?.positions || []).some((p) => p.closedAt == null);
  const switchingToAtr = editing && atrBand && bot?.params?.takeProfitMode !== 'atr_band' && hasOpenPositions;
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
        ? `${(bot.underlyings?.length ? bot.underlyings : [bot.underlying]).join(' · ')} · los cambios se aplican a la próxima señal.`
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
          <MultiChoiceField
            label="Subyacentes"
            help="Puedes elegir varios: el bot opera cada uno cuando la alerta lo incluye"
            options={UNDERLYINGS.map((u) => ({ value: u, label: u }))}
            value={form.underlyings}
            onToggle={toggleUnderlying}
            error={errors.underlyings}
            columns={3}
          />
        </FieldGroup>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>1 · Señales (alertas)</legend>
          <AlertPicker
            underlyings={form.underlyings}
            alerts={alertOptions}
            loading={eligible.loading}
            error={eligible.error}
            selected={form.alertIds}
            onToggle={toggleAlert}
            onRetry={() => loadEligible(underlyingsKey)}
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
            label="Vencimiento mínimo"
            help="Opcional. Vacío = sin límite"
            unit="días"
            placeholder="—"
            value={form.expiryMinDays}
            min={0}
            max={180}
            step={1}
            error={errors.expiryMinDays}
            onChange={(v) => update({ expiryMinDays: v })}
          />
          <NumberField
            label="Vencimiento máximo"
            help="Con rango, solo elige vencimientos dentro de él"
            unit="días"
            placeholder="—"
            value={form.expiryMaxDays}
            min={0}
            max={180}
            step={1}
            error={errors.expiryMaxDays}
            onChange={(v) => update({ expiryMaxDays: v })}
          />
          <NumberField
            label="Presupuesto total"
            help={perSignal !== null
              ? `Hasta ${formatNumber(perSignal, { decimals: 2, minDecimals: 0 })} USDT por señal`
              : 'Vacío = sin presupuesto total (usa el capital por entrada). Las órdenes pendientes también reservan.'}
            unit="USDT"
            value={form.budgetUsdt}
            min={0}
            step={10}
            error={errors.budgetUsdt}
            onChange={(v) => update({ budgetUsdt: v })}
          />
          {hasBudget && (
            <NumberField
              label="Fracciones"
              help="Cada señal usa como máximo una fracción; cambiarlo solo afecta a nuevas entradas"
              value={form.budgetFractions}
              min={1}
              max={20}
              step={1}
              integer
              error={errors.budgetFractions}
              onChange={(v) => update({ budgetFractions: v })}
            />
          )}
          {!hasBudget && (
            <NumberField
              label="Capital asignado"
              help="Se reparte por igual. En compras limita prima; en ventas limita margen estimado. Vacío = usa la cantidad configurada."
              unit="USDT"
              value={form.capitalUsdt}
              min={0}
              step={10}
              error={errors.capitalUsdt}
              onChange={(v) => update({ capitalUsdt: v })}
            />
          )}
          <NumberField
            label="Spread máx. (%)"
            help="Descarta contratos con (ask − bid) / mid mayor a esto. Vacío = sin filtro"
            unit="%"
            value={form.maxSpreadPct}
            min={0}
            max={200}
            step={1}
            error={errors.maxSpreadPct}
            onChange={(v) => update({ maxSpreadPct: v })}
          />
          {buy && (
            <NumberField
              label="Apalancamiento mín. (×)"
              help="Spot / ask del contrato. Vacío = sin filtro"
              unit="×"
              value={form.minLeverage}
              min={0}
              max={1000}
              step={1}
              error={errors.minLeverage}
              onChange={(v) => update({ minLeverage: v })}
            />
          )}
          <NumberField
            label="Cantidad máxima por contrato"
            unit={form.underlyings.join(' · ')}
            value={form.quantity}
            min={0.0001}
            step={0.01}
            error={errors.quantity}
            onChange={(v) => update({ quantity: v })}
          />
          {!atrBand && <ChoiceField
            label="Si llega la señal contraria"
            help={(ON_OPPOSITE.find((o) => o.value === form.onOpposite) || ON_OPPOSITE[0]).help}
            options={ON_OPPOSITE.map((o) => ({ value: o.value, label: o.label }))}
            value={form.onOpposite}
            onChange={(v) => update({ onOpposite: v })}
            columns={3}
          />}
        </FieldGroup>

        <FieldGroup title="3 · Salidas">
          <ChoiceField
            label="Tipo de Take Profit"
            options={takeProfitModesFor(form.structure).map((m) => ({ value: m.value, label: m.label }))}
            value={form.takeProfitMode}
            onChange={pickTakeProfitMode}
            error={errors.takeProfitMode}
            columns={buy ? 3 : 2}
          />
          {atrBand ? (
            <>
              <details className={styles.note}>
                <summary aria-label="Información sobre la banda ATR">ⓘ Cómo se calcula</summary>
                <p>Banda del indicador «ATR Bands»: último cierre ± multiplicador × ATR. Al llenarse la compra se fija el precio de venta = prima × (1 + distancia a la banda × apalancamiento), con el tope de ganancia, y queda como orden límite en reposo en Binance. No se recalcula.</p>
              </details>
              {switchingToAtr && <p className={`${ui.alert} ${ui.alertWarn}`} role="status">{ATR_BAND_SWITCH_WARNING}</p>}
              <ChoiceField
                label="Temporalidad de las velas"
                options={ATR_BAND_INTERVALS.map((i) => ({ value: i, label: i }))}
                value={form.atrBandInterval}
                onChange={(v) => update({ atrBandInterval: v })}
                error={errors.atrBandInterval}
                columns={5}
              />
              <NumberField
                label="Longitud del ATR"
                unit="velas"
                value={form.atrBandLength}
                min={2}
                max={100}
                integer
                error={errors.atrBandLength}
                onChange={(v) => update({ atrBandLength: v })}
              />
              <NumberField
                label="Multiplicador de la banda"
                value={form.atrBandMultiplier}
                min={0.25}
                max={10}
                step={0.25}
                error={errors.atrBandMultiplier}
                onChange={(v) => update({ atrBandMultiplier: v })}
              />
              <NumberField
                label="Tope de ganancia (%)"
                help="Máximo sobre la prima pagada"
                unit="%"
                value={form.tpMaxGainPct}
                min={10}
                max={2000}
                step={10}
                error={errors.tpMaxGainPct}
                onChange={(v) => update({ tpMaxGainPct: v })}
              />
              <p className={styles.note}>{ATR_BAND_NOTE}</p>
            </>
          ) : form.takeProfitMode === 'volatility' ? (
            <>
              <details className={styles.note}>
                <summary aria-label="Información sobre TP por volatilidad">ⓘ Cómo se calcula</summary>
                <p>ATR (velas 1 h) + volatilidad implícita, sobre prima confirmada. El TP se revisa cada 5 minutos; no queda una orden residente en Binance. Si faltan datos no se dispara ese TP. El stop y la salida por tiempo siguen activos. No garantiza ganancias.</p>
              </details>
              <NumberField
                label="Multiplicador ATR"
                value={form.tpAtrMultiplier}
                min={0.25}
                max={4}
                step={0.25}
                error={errors.tpAtrMultiplier}
                onChange={(v) => update({ tpAtrMultiplier: v })}
              />
              <NumberField
                label="Horizonte del movimiento"
                unit="h"
                value={form.tpHorizonHours}
                min={1}
                max={24}
                integer
                error={errors.tpHorizonHours}
                onChange={(v) => update({ tpHorizonHours: v })}
              />
            </>
          ) : (
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
          )}
          {!atrBand && <NumberField
            label={labels.stopLoss}
            help={labels.stopLossHelp}
            unit="%"
            value={form.stopLossPct}
            min={1}
            max={1000}
            step={buy ? 5 : 25}
            error={errors.stopLossPct}
            onChange={(v) => update({ stopLossPct: v })}
          />}
          {!atrBand && <NumberField
            label="Cerrar antes del venc."
            unit="h"
            value={form.exitHoursBeforeExpiry}
            min={0}
            max={168}
            integer
            error={errors.exitHoursBeforeExpiry}
            onChange={(v) => update({ exitHoursBeforeExpiry: v })}
          />}
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

        <FieldGroup title="5 · Avisos">
          <label className={styles.checkRow}>
            <input type="checkbox" checked={form.notifyTrades !== false} onChange={(e) => update({ notifyTrades: e.target.checked })} />
            <span>Avisar de operaciones por Telegram</span>
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" checked={form.notifyErrors !== false} onChange={(e) => update({ notifyErrors: e.target.checked })} />
            <span>Avisar de errores y órdenes bloqueadas</span>
          </label>
          <p className={styles.note}>Solo aplica en modo Real. Las alertas de incidentes del ejecutor siempre se envían.</p>
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
