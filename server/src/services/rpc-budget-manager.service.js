const config = require('../config');

class RpcBudgetManagerService {
  constructor(deps = {}) {
    this.hourlyBudget = deps.hourlyBudget || config.deltaNeutral.rpcBudgetHourly;
    this.dailyBudget = deps.dailyBudget || config.deltaNeutral.rpcBudgetDaily;
    this.events = [];
  }

  _prune(now = Date.now()) {
    const dayAgo = now - (24 * 60 * 60_000);
    while (this.events.length && this.events[0].timestamp < dayAgo) {
      this.events.shift();
    }
  }

  record(event = {}) {
    const now = event.timestamp || Date.now();
    this._prune(now);
    this.events.push({
      timestamp: now,
      weight: Number(event.weight || 1),
      kind: event.kind || 'generic',
      protectionId: event.protectionId != null ? Number(event.protectionId) : null,
      urgent: event.urgent === true,
    });
  }

  getSnapshot(now = Date.now()) {
    this._prune(now);
    const hourAgo = now - (60 * 60_000);
    let hourlyUsed = 0;
    let dailyUsed = 0;
    for (const event of this.events) {
      dailyUsed += event.weight;
      if (event.timestamp >= hourAgo) hourlyUsed += event.weight;
    }
    return {
      hourlyBudget: this.hourlyBudget,
      dailyBudget: this.dailyBudget,
      hourlyUsed,
      dailyUsed,
      hourlyRemaining: Math.max(this.hourlyBudget - hourlyUsed, 0),
      dailyRemaining: Math.max(this.dailyBudget - dailyUsed, 0),
      exceededHourly: hourlyUsed >= this.hourlyBudget,
      exceededDaily: dailyUsed >= this.dailyBudget,
    };
  }

  canSpend({ weight = 1, urgent = false } = {}) {
    if (urgent) return { allowed: true, reason: null, snapshot: this.getSnapshot() };
    const snapshot = this.getSnapshot();
    if (snapshot.hourlyUsed + weight > this.hourlyBudget) {
      return { allowed: false, reason: 'hourly_budget_exceeded', snapshot };
    }
    if (snapshot.dailyUsed + weight > this.dailyBudget) {
      return { allowed: false, reason: 'daily_budget_exceeded', snapshot };
    }
    return { allowed: true, reason: null, snapshot };
  }
}

module.exports = new RpcBudgetManagerService();
module.exports.RpcBudgetManagerService = RpcBudgetManagerService;
