const { ACTIONS } = require('./uniswap/constants');
const {
  buildModifyRangeRedeployPlan,
  buildRebalanceSwap,
  computeOptimalWeightToken0Pct,
} = require('../domains/uniswap/pools/domain/position-action-math');
const { resolveCloseTargetStable } = require('./uniswap/actions/helpers');

module.exports = {
  ACTIONS: [...ACTIONS],
  ...require('./uniswap/actions/finalize'),
  __test: {
    buildModifyRangeRedeployPlan,
    buildRebalanceSwap,
    computeOptimalWeightToken0Pct,
    resolveCloseTargetStable,
  },
};
