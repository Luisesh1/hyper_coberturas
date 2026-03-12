/**
 * AuthContext.jsx
 *
 * Estado global de autenticación. Almacena el JWT en localStorage.
 * Expone: user, token, isAuthenticated, isSuperuser, login, logout
 */

import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { readSession, setSession, clearSession, subscribe } from '../services/sessionStore';

const AuthContext = createContext(null);
function readStorage() {
  return readSession();
}

export function AuthProvider({ children }) {
  const [state, setState] = useState(() => readStorage());

  useEffect(() => subscribe(setState), []);

  const login = useCallback(async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Error al iniciar sesión');
    }
    const { token, user } = json.data;
    setSession({ token, user });
    return user;
  }, []);

  const logout = useCallback(() => {
    clearSession();
  }, []);

  const value = {
    token:           state.token,
    user:            state.user,
    isAuthenticated: !!state.token && !!state.user,
    isSuperuser:     state.user?.role === 'superuser',
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
