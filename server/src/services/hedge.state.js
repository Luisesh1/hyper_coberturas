// Mapping functions moved to repositories/hedge.mapper.js
// Re-exported here for backward compatibility
const { normalizeStatus, rowToHedge } = require('../repositories/hedge.mapper');

function getTrackedPositionSize(hedge) {
  return hedge.positionSize && hedge.positionSize > 0
    ? hedge.positionSize
    : hedge.size;
}

module.exports = {
  normalizeStatus,
  rowToHedge,
  getTrackedPositionSize,
};
