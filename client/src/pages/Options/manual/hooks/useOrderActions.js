import { useCallback, useState } from 'react';
import { optionsApi } from '../../../../services/api';
import { useConfirmAction } from '../../../../hooks/useConfirmAction';
import { useTradingContext } from '../../../../context/TradingContext';
import { fmtNum, fmtPrice } from '../../format';

const SIDE_LABEL = { BUY: 'Comprar', SELL: 'Vender' };

export function isLongPosition(position) {
  const side = String(position?.side || '').toUpperCase();
  if (side === 'SHORT' || side === 'SELL') return false;
  if (side === 'LONG' || side === 'BUY') return true;
  return Number(position?.quantity) >= 0;
}

/**
 * Acciones que envían órdenes reales: siempre piden confirmación antes de
 * llamar a la API y dejan el error visible (además de notificarlo).
 * `onDone` se llama tras cada acción con éxito para refrescar la cuenta.
 */
export function useOrderActions({ onDone, quoteForSymbol }) {
  const { addNotification } = useTradingContext();
  const { dialog, confirm } = useConfirmAction();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (fn, successMsg) => {
    setPending(true);
    setError(null);
    try {
      const result = await fn();
      addNotification?.('success', successMsg);
      onDone?.();
      return result ?? true;
    } catch (err) {
      const msg = err?.message || 'Error desconocido';
      setError(msg);
      addNotification?.('error', msg);
      return null;
    } finally {
      setPending(false);
    }
  }, [addNotification, onDone]);

  const submitOrder = useCallback(async (order) => {
    const ok = await confirm({
      title: `${SIDE_LABEL[order.side]} ${order.symbol}`,
      message: `Orden límite de ${fmtNum(order.quantity, 2)} contratos a ${fmtPrice(order.price)} USDT`
        + `${order.postOnly ? ' · post-only' : ''}${order.reduceOnly ? ' · solo reducir' : ''}.`
        + ' Se envía a Binance con dinero real.',
      confirmLabel: 'Enviar orden',
      variant: order.side === 'SELL' ? 'danger' : 'info',
    });
    if (!ok) return null;
    return run(() => optionsApi.placeOrder(order), 'Orden enviada');
  }, [confirm, run]);

  const cancelOrder = useCallback(async (order) => {
    const ok = await confirm({
      title: 'Cancelar orden',
      message: `¿Cancelar la orden ${order.side === 'BUY' ? 'de compra' : 'de venta'} de ${order.symbol} a ${fmtPrice(order.price)} USDT?`,
      confirmLabel: 'Cancelar orden',
    });
    if (!ok) return null;
    return run(() => optionsApi.cancelOrder(order.symbol, order.orderId), 'Orden cancelada');
  }, [confirm, run]);

  // Cierre: orden límite reduce-only del lado contrario, al mejor precio del
  // libro si el contrato está en la cadena visible o al mark si no.
  const closePosition = useCallback(async (position) => {
    const side = isLongPosition(position) ? 'SELL' : 'BUY';
    const quantity = Math.abs(Number(position.quantity));
    const price = quoteForSymbol?.(position.symbol, side) ?? Number(position.markPrice);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
      const msg = 'No hay precio para cerrar esta posición';
      setError(msg);
      addNotification?.('error', msg);
      return null;
    }
    const ok = await confirm({
      title: 'Cerrar posición',
      message: `${SIDE_LABEL[side]} ${fmtNum(quantity, 2)} ${position.symbol} con una orden límite solo-reducir a ${fmtPrice(price)} USDT.`,
      confirmLabel: 'Cerrar posición',
    });
    if (!ok) return null;
    return run(
      () => optionsApi.placeOrder({ symbol: position.symbol, side, quantity, price, reduceOnly: true }),
      'Orden de cierre enviada',
    );
  }, [addNotification, confirm, quoteForSymbol, run]);

  return { dialog, pending, error, clearError: () => setError(null), submitOrder, cancelOrder, closePosition };
}
