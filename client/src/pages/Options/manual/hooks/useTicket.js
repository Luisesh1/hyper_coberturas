import { useCallback, useMemo, useState } from 'react';
import { parseNumberInput, stepNumber } from '../../../TradingView/components/stepperMath';
import {
  computeTicket, hasTick, parseSymbol, priceStep, qtyStep, quoteFor, snapToTick, stepOnTick, tickError, QTY_MIN,
} from '../ticketMath';

const EMPTY = {
  symbol: null,
  type: 'C',
  strike: null,
  side: 'BUY',
  priceText: '',
  qtyText: '0.1',
  postOnly: false,
  reduceOnly: false,
};

function trimNumber(n) {
  return String(Number(n.toPrecision(10)));
}

// Busca la pata por símbolo en la cadena viva (el mark y las griegas se
// actualizan con cada sondeo; el precio del ticket no).
export function findLeg(chain, symbol) {
  if (!chain?.rows || !symbol) return null;
  for (const row of chain.rows) {
    if (row.call?.symbol === symbol) return { row, leg: row.call, type: 'C' };
    if (row.put?.symbol === symbol) return { row, leg: row.put, type: 'P' };
  }
  return null;
}

// Precio inicial del ticket: bid/ask ya están en la rejilla; el mark de
// respaldo no siempre, así que se ajusta al tick del contrato.
function initialPrice(leg, side) {
  const quote = quoteFor(leg, side);
  return quote != null ? snapToTick(quote, leg) : null;
}

export function useTicket(chain) {
  const [t, setT] = useState(EMPTY);

  const found = useMemo(() => findLeg(chain, t.symbol), [chain, t.symbol]);
  const leg = found?.leg || null;

  const pick = useCallback(({ leg: pickedLeg, strike, type, side }) => {
    const price = initialPrice(pickedLeg, side);
    setT((prev) => ({
      ...prev,
      symbol: pickedLeg.symbol,
      strike,
      type,
      side,
      priceText: price != null ? trimNumber(price) : '',
    }));
  }, []);

  // Cambiar de lado vuelve a poner el precio del lado contrario del libro.
  const setSide = useCallback((side) => {
    setT((prev) => {
      if (prev.side === side) return prev;
      const price = initialPrice(leg, side);
      return { ...prev, side, priceText: price != null ? trimNumber(price) : prev.priceText };
    });
  }, [leg]);

  const setPriceText = useCallback((priceText) => setT((p) => ({ ...p, priceText })), []);
  const setQtyText = useCallback((qtyText) => setT((p) => ({ ...p, qtyText })), []);
  const setFlag = useCallback((name, value) => setT((p) => ({ ...p, [name]: value })), []);

  const price = parseNumberInput(t.priceText);
  const qty = parseNumberInput(t.qtyText);

  const stepPrice = useCallback((direction) => {
    setT((p) => {
      const current = parseNumberInput(p.priceText) ?? 0;
      if (hasTick(leg)) {
        const from = current || initialPrice(leg, p.side) || 0;
        return { ...p, priceText: trimNumber(stepOnTick(from, leg, direction)) };
      }
      const step = priceStep(current || quoteFor(leg, p.side) || 1);
      const next = stepNumber(current, direction, { step, min: step });
      return { ...p, priceText: trimNumber(next) };
    });
  }, [leg]);

  const stepQty = useCallback((direction) => {
    setT((p) => {
      const current = parseNumberInput(p.qtyText) ?? QTY_MIN;
      const step = qtyStep(current, direction);
      const next = stepNumber(current, direction, { step, min: QTY_MIN });
      return { ...p, qtyText: trimNumber(next) };
    });
  }, []);

  const parsed = parseSymbol(t.symbol);
  const strike = t.strike ?? parsed?.strike ?? null;
  const type = found?.type || t.type;
  const summary = computeTicket({
    side: t.side,
    type,
    strike,
    price,
    qty,
    spot: chain?.spot,
    leg: leg || {},
  });

  const priceError = summary.valid ? tickError(price, leg) : null;

  const order = t.symbol && summary.valid && !priceError
    ? {
        symbol: t.symbol,
        side: t.side,
        quantity: qty,
        price,
        postOnly: t.postOnly,
        reduceOnly: t.reduceOnly,
      }
    : null;

  return {
    ...t,
    type,
    strike,
    leg,
    price,
    qty,
    summary,
    priceError,
    order,
    pick,
    setSide,
    setPriceText,
    setQtyText,
    setFlag,
    stepPrice,
    stepQty,
  };
}
