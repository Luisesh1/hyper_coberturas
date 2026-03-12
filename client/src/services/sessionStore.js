const TOKEN_KEY = 'hl_token';
const USER_KEY = 'hl_user';
const listeners = new Set();

export function readSession() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    return { token, user };
  } catch {
    return { token: null, user: null };
  }
}

function notify() {
  const snapshot = readSession();
  listeners.forEach((listener) => listener(snapshot));
}

export function setSession({ token, user }) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  notify();
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  notify();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToken() {
  return readSession().token || '';
}
