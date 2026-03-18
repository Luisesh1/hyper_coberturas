class HedgeNotifier {
  constructor(emitter, telegramService) {
    this.emitter = emitter;
    this.tg = telegramService;
  }

  updated(hedge) {
    this.emitter.emit('updated', hedge);
  }

  created(hedge) {
    this.emitter.emit('created', hedge);
    this.tg.notifyHedgeCreated(hedge);
  }

  opened(hedge) {
    this.emitter.emit('opened', hedge);
    this.tg.notifyHedgeOpened(hedge);
  }

  reconciled(hedge) {
    this.emitter.emit('reconciled', hedge);
  }

  protectionMissing(hedge) {
    this.emitter.emit('protection_missing', hedge);
  }

  cycleComplete(hedge, cycle) {
    this.tg.notifyHedgeClosed({
      ...hedge,
      direction: hedge.direction,
      openPrice: cycle.openPrice,
      closePrice: cycle.closePrice,
      size: cycle.size || hedge.positionSize || hedge.size,
      closedPnl: cycle.closedPnl ?? null,
      netPnl: cycle.netPnl ?? null,
    });
    this.emitter.emit('cycleComplete', hedge, cycle);
  }

  cancelled(hedge) {
    this.tg.notifyHedgeCancelled(hedge);
    this.emitter.emit('cancelled', hedge);
  }

  error(hedge, err) {
    this.tg.notifyHedgeError(hedge, err);
    this.emitter.emit('error', hedge, err);
  }
}

module.exports = HedgeNotifier;
