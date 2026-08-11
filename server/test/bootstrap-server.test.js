const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createRequestTracker } = require('../src/bootstrap/server');

test('request tracker decrementa una sola vez aunque response emita finish y close', () => {
  const tracker = createRequestTracker();
  const firstResponse = new EventEmitter();
  const secondResponse = new EventEmitter();

  tracker.track({}, firstResponse);
  tracker.track({}, secondResponse);
  assert.equal(tracker.inFlight(), 2);

  firstResponse.emit('finish');
  firstResponse.emit('close');
  assert.equal(tracker.inFlight(), 1);

  secondResponse.emit('close');
  assert.equal(tracker.inFlight(), 0);
});
