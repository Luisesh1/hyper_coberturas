/**
 * AuthContext.jsx
 *
 * Estado global de autenticación. Almacena el JWT en localStorage.
 * Expone: user, token, isAuthenticated, isSuperuser, login, logout
 */

import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { readSession, setSession, clearSession, subscribe } from '../services/sessionStore';
import { authApi } from '../services/api';

const AuthContext = createContext(null);
function readStorage() {
  return readSession();
}

export function AuthProvider({ children }) {
  const [state, setState] = useState(() => readStorage());

  useEffect(() => subscribe(setState), []);

  const login = useCallback(async (username, password) => {
    const { token, user } = await authApi.login({ username, password });
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
