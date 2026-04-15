import { useState, useCallback } from 'react';
import { api, getToken } from '../lib/api';

export function useAuth() {
  const [loggedIn, setLoggedIn] = useState(() => !!getToken());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      await api.login(email, password);
      setLoggedIn(true);
    } catch (e: any) {
      setError(e.message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    api.logout();
    setLoggedIn(false);
  }, []);

  return { loggedIn, loading, error, login, logout };
}
