const { parentPort } = require('node:worker_threads');
const {
  runBacktest,
  runIndicatorValidation,
  runValidation,
} = require('./strategy-engine.core');

parentPort.on('message', async (payload) => {
  try {
    let result;
    switch (payload.type) {
      case 'validate':
        result = await runValidation(payload);
        break;
      case 'backtest':
        result = await runBacktest(payload);
        break;
      case 'indicator':
        result = await runIndicatorValidation(payload);
        break;
      default:
        throw new Error(`Tipo de trabajo no soportado: ${payload.type}`);
    }
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: error.message,
        stack: error.stack,
      },
    });
  }
});
