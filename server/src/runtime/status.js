const state = {
  bootstrapped: false,
  lastBootstrapAt: null,
  lastBootstrapError: null,
};

function markBootstrapped() {
  state.bootstrapped = true;
  state.lastBootstrapAt = Date.now();
  state.lastBootstrapError = null;
}

function markBootstrapError(error) {
  state.bootstrapped = false;
  state.lastBootstrapError = error ? error.message : 'bootstrap_failed';
}

function snapshot() {
  return { ...state };
}

module.exports = {
  markBootstrapped,
  markBootstrapError,
  snapshot,
};
