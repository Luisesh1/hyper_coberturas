import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AccountAutocomplete } from '../shared/AccountAutocomplete';
import { formatAccountIdentity, formatUsd } from '../../utils/hyperliquidAccounts';
import { loadPct } from './constants';
import styles from './HedgePanel.module.css';

/**
 * HedgeForm -- left column of the hedge panel.
 * Contains: account selector, direction toggle, entry/exit fields,
 * size/leverage, label, summary, submit button, and auto-exit modal.
 */
export function HedgeForm({
  accounts,
  selectedAccountId,
  setSelectedAccountId,
  isLoadingAccounts,
  refreshAccountSummary,
  prices,
  asset,
  setAsset,
  isConnected,
  isPriceStale,
  createHedge,
}) {
  const { user } = useAuth();

  const [direction, setDirection]   = useState('short');
  const [entryPrice, setEntryPrice] = useState('');
  const [exitPrice, setExitPrice]   = useState('');
  const [size, setSize]             = useState('');
  const [denomination, setDenomination] = useState('USDC');
  const [leverage, setLeverage]     = useState(10);
  const [label, setLabel]           = useState('');
  const [autoExit, setAutoExit]     = useState(true);
  const [autoExitPct, setAutoExitPct] = useState(() => loadPct(user?.username));
  const [showPctModal, setShowPctModal] = useState(false);
  const [pctInput, setPctInput]     = useState('');
  const pctInputRef                 = useRef(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isLong = direction === 'long';

  // Reload pct from localStorage when user changes
  useEffect(() => {
    setAutoExitPct(loadPct(user?.username));
  }, [user?.username]);

  // Focus input when modal opens
  useEffect(() => {
    if (showPctModal) {
      setPctInput(autoExitPct.toString());
      setTimeout(() => pctInputRef.current?.select(), 50);
    }
  }, [showPctModal, autoExitPct]);

  // Cuando autoExit esta activo, recalcula exitPrice como +/-X% del entryPrice
  useEffect(() => {
    if (!autoExit) return;
    const entry = parseFloat(entryPrice);
    if (!entry || entry <= 0) return;
    const factor = autoExitPct / 100;
    const auto = isLong
      ? (entry * (1 - factor)).toFixed(2)
      : (entry * (1 + factor)).toFixed(2);
    setExitPrice(auto);
  }, [autoExit, entryPrice, isLong, autoExitPct]);

  const savePct = () => {
    const n = parseFloat(pctInput);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return;
    setAutoExitPct(n);
    localStorage.setItem(`hedge_autoexit_pct_${user?.username}`, n.toString());
    setShowPctModal(false);
  };

  const currentPrice = prices[asset] ? parseFloat(prices[asset]) : null;

  const entryNum    = parseFloat(entryPrice);
  const exitNum     = parseFloat(exitPrice);
  const refPrice    = entryNum > 0 ? entryNum : currentPrice;
  const sizeInAsset = size && refPrice
    ? denomination === 'USDC' ? parseFloat(size) / refPrice : parseFloat(size)
    : null;
  const notional  = sizeInAsset && entryNum ? sizeInAsset * entryNum : null;
  const margin    = notional ? notional / leverage : null;
  const priceValid = entryNum > 0 && exitNum > 0;

  // SHORT: exit > entry (SL arriba); LONG: exit < entry (SL abajo)
  const logicValid = isLong
    ? priceValid && exitNum < entryNum
    : priceValid && exitNum > entryNum;

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!selectedAccountId) return;
    setIsSubmitting(true);
    try {
      await createHedge({ accountId: selectedAccountId, asset, entryPrice, exitPrice, size: sizeInAsset, leverage, label, direction });
      await refreshAccountSummary(selectedAccountId, { force: true }).catch(() => {});
      setEntryPrice('');
      setExitPrice('');
      setSize('');
      setDenomination('USDC');
      setLabel('');
    } catch {
      // notificado por contexto
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedAccount = accounts.find((account) => Number(account.id) === Number(selectedAccountId)) || null;

  return (
    <div className={styles.formCol}>
      {/* Section header */}
      <div className={styles.colLabel}>Abrir Cobertura</div>

      <AccountAutocomplete
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onSelect={(selected) => {
          setSelectedAccountId(selected.id);
          refreshAccountSummary(selected.id, { force: true }).catch(() => {});
        }}
        label="Cuenta de cobertura"
        disabled={isLoadingAccounts || accounts.length === 0}
        placeholder="Selecciona una cuenta de Hyperliquid"
      />

      {selectedAccount && (
        <div className={styles.accountSummary}>
          <span className={styles.accountSummaryTitle}>{formatAccountIdentity(selectedAccount)}</span>
          <span className={styles.accountSummaryValue}>Balance {formatUsd(selectedAccount.balanceUsd)}</span>
        </div>
      )}

      {/* Direction selector */}
      <div className={styles.directionBar}>
        <button
          type="button"
          className={`${styles.dirBtn} ${isLong ? styles.dirBtnLongActive : styles.dirBtnInactive}`}
          onClick={() => { setDirection('long'); setExitPrice(''); }}
        >
          ▲ Long
        </button>
        <button
          type="button"
          className={`${styles.dirBtn} ${!isLong ? styles.dirBtnShortActive : styles.dirBtnInactive}`}
          onClick={() => { setDirection('short'); setExitPrice(''); }}
        >
          ▼ Short
        </button>
      </div>

      <form className={styles.form} onSubmit={handleCreate}>
        {/* Par y precio actual */}
        <div className={styles.row2}>
          <div className={styles.field}>
            <label className={styles.label}>Par de futuros</label>
            <input
              className={styles.input}
              type="text"
              placeholder="BTC"
              value={asset}
              onChange={(e) => setAsset(e.target.value.toUpperCase())}
              required
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Precio actual</label>
            <div className={styles.priceDisplay}>
              {currentPrice
                ? `$${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                : '—'}
            </div>
          </div>
        </div>

        {/* Separador: Condiciones de activacion */}
        <div className={isLong ? styles.sectionDividerLong : styles.sectionDivider}>
          <span>{isLong ? '▲' : '▼'}</span>
          <span className={styles.sectionTitle}>Condiciones de activacion</span>
        </div>

        {/* Entry + Exit en horizontal */}
        <div className={styles.row2}>
          {/* Entry */}
          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label className={styles.label}>Entrada</label>
              <span className={styles.hint}>{isLong ? 'precio ≥' : 'precio ≤'}</span>
            </div>
            <div className={styles.inputGroup}>
              <span className={styles.inputPrefix}>$</span>
              <input
                className={`${styles.input} ${styles.inputInner}`}
                type="number" step="0.01" min="0" placeholder="ej: 95000"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
                required
              />
              {currentPrice && (
                <button type="button" className={styles.priceBtn}
                  onClick={() => setEntryPrice(currentPrice.toFixed(2))}>Actual</button>
              )}
            </div>
            {currentPrice && entryNum > 0 && (
              <span className={styles.fieldHint}>
                {isLong
                  ? (entryNum > currentPrice
                      ? `+${((entryNum / currentPrice - 1) * 100).toFixed(2)}% del precio actual`
                      : '⚡ Activaria inmediatamente')
                  : (entryNum < currentPrice
                      ? `-${((1 - entryNum / currentPrice) * 100).toFixed(2)}% del precio actual`
                      : '⚡ Activaria inmediatamente')}
              </span>
            )}
          </div>

          {/* Exit / SL */}
          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label className={styles.label}>{isLong ? 'Salida SL' : 'Salida'}</label>
              <span className={styles.autoExitGroup}>
                <label className={styles.autoExitLabel}>
                  <input
                    type="checkbox"
                    checked={autoExit}
                    onChange={(e) => setAutoExit(e.target.checked)}
                    className={styles.autoExitCheck}
                  />
                  Auto {autoExitPct}%
                </label>
                <button
                  type="button"
                  className={styles.pctEditBtn}
                  onClick={() => setShowPctModal(true)}
                  title="Editar porcentaje"
                  aria-label="Editar porcentaje de auto-exit"
                >✎</button>
              </span>
            </div>
            <div className={styles.inputGroup}>
              <span className={styles.inputPrefix}>$</span>
              <input
                className={`${styles.input} ${styles.inputInner}`}
                type="number" step="0.01" min="0"
                placeholder={isLong ? 'ej: 90000' : 'ej: 100000'}
                value={exitPrice}
                onChange={(e) => { if (!autoExit) setExitPrice(e.target.value); }}
                disabled={autoExit}
                required
              />
              {currentPrice && !autoExit && (
                <button type="button" className={styles.priceBtn}
                  onClick={() => setExitPrice(currentPrice.toFixed(2))}>Actual</button>
              )}
            </div>
            {priceValid && !logicValid && (
              <span className={styles.fieldError}>
                {isLong ? 'SL debe ser < entrada' : 'Salida debe ser > entrada'}
              </span>
            )}
            {isLong && entryNum > 0 && exitNum > 0 && exitNum < entryNum && (
              <span className={styles.fieldHint}>
                SL a {((entryNum - exitNum) / entryNum * 100).toFixed(2)}% bajo entrada
              </span>
            )}
          </div>
        </div>

        {/* Tamano y apalancamiento */}
        <div className={styles.row2}>
          <div className={styles.field}>
            <label className={styles.label}>Cantidad ({denomination})</label>
            <div className={styles.segmented}>
              {['USDC', asset].map((d) => (
                <button key={d} type="button"
                  className={`${styles.segBtn} ${denomination === d ? styles.segActive : ''}`}
                  onClick={() => { setDenomination(d); setSize(''); }}>
                  {d}
                </button>
              ))}
            </div>
            <input
              className={styles.input}
              type="number"
              step={denomination === 'USDC' ? '0.01' : '0.0001'}
              min={denomination === 'USDC' ? '0.01' : '0.0001'}
              placeholder={denomination === 'USDC' ? 'ej: 500' : 'ej: 0.01'}
              value={size}
              onChange={(e) => setSize(e.target.value)}
              required
            />
            {denomination === 'USDC' && sizeInAsset > 0 && (
              <span className={styles.fieldHint}>≈ {sizeInAsset.toFixed(6)} {asset}</span>
            )}
          </div>

          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label className={styles.label}>Apalancamiento</label>
              <span className={isLong ? styles.leverageValLong : styles.leverageVal}>{leverage}x Isolated</span>
            </div>
            <input type="range" min="1" max="50" value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className={isLong ? styles.sliderLong : styles.slider} />
            <div className={styles.presets}>
              {[1, 2, 5, 10, 20, 50].map((v) => (
                <button key={v} type="button"
                  className={`${styles.preset} ${leverage === v ? (isLong ? styles.presetActiveLong : styles.presetActive) : ''}`}
                  onClick={() => setLeverage(v)}>{v}x</button>
              ))}
            </div>
          </div>
        </div>

        {/* Etiqueta opcional (inline con monto convertido) */}
        <div className={styles.field}>
          <label className={styles.label}>Etiqueta <span className={styles.hint}>(opcional)</span></label>
          <input className={styles.input} type="text"
            placeholder={`ej: Cobertura ${asset} ${isLong ? 'alcista' : 'bajista'} Q3`}
            value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>

        {/* Resumen */}
        {notional !== null && logicValid && (
          <div className={isLong ? styles.summaryLong : styles.summary}>
            <div className={styles.summaryTitle}>Resumen</div>
            <div className={styles.summaryGrid}>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Tipo</span>
                <span className={styles.summaryVal}>{isLong ? 'LONG' : 'SHORT'} Isolated {leverage}x</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Activa cuando</span>
                <span className={`${styles.summaryVal} ${isLong ? styles.triggerUp : styles.triggerDown}`}>
                  {isLong ? '≥' : '≤'} ${Number(entryPrice).toLocaleString()}
                </span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Cierra SL cuando</span>
                <span className={`${styles.summaryVal} ${isLong ? styles.triggerDown : styles.triggerUp}`}>
                  {isLong ? '≤' : '≥'} ${Number(exitPrice).toLocaleString()}
                </span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Nocional</span>
                <span className={styles.summaryVal}>${notional.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Margen</span>
                <span className={styles.summaryVal}>${margin.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Rango</span>
                <span className={styles.summaryVal}>
                  ${Number(isLong ? exitPrice : entryPrice).toLocaleString()} — ${Number(isLong ? entryPrice : exitPrice).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        <button
          type="submit"
          className={isLong ? styles.submitBtnLong : styles.submitBtn}
          disabled={isSubmitting || !selectedAccountId || !logicValid || !sizeInAsset || sizeInAsset <= 0}
        >
          {isSubmitting ? 'Creando...' : (isLong ? '▲ Activar cobertura LONG' : '▼ Activar cobertura SHORT')}
        </button>
        {!selectedAccountId && <span className={styles.fieldError}>Selecciona una cuenta para crear la cobertura.</span>}
      </form>

      {/* -- Modal editar porcentaje -- */}
      {showPctModal && (
        <div className={styles.modalOverlay} onClick={() => setShowPctModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Editar diferencial automatico">
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>Diferencial automatico</span>
              <button className={styles.modalClose} onClick={() => setShowPctModal(false)} aria-label="Cerrar">✕</button>
            </div>
            <p className={styles.modalDesc}>
              Porcentaje de separacion entre precio de entrada y SL automatico.
            </p>
            <div className={styles.modalField}>
              <label className={styles.modalLabel}>Porcentaje (%)</label>
              <div className={styles.modalInputGroup}>
                <input
                  ref={pctInputRef}
                  className={styles.modalInput}
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="100"
                  value={pctInput}
                  onChange={(e) => setPctInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePct(); if (e.key === 'Escape') setShowPctModal(false); }}
                />
                <span className={styles.modalInputSuffix}>%</span>
              </div>
              <span className={styles.modalHint}>
                Valor actual: {autoExitPct}% · {autoExitPct === 0.05 ? 'valor por defecto' : 'personalizado'}
              </span>
            </div>
            <div className={styles.modalActions}>
              <button className={styles.modalCancel} onClick={() => setShowPctModal(false)}>Cancelar</button>
              <button className={styles.modalSave} onClick={savePct}>Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
