import { onAuthStateChanged, signInWithPopup, signOut, type User as FirebaseUser } from 'firebase/auth';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { auth, googleProvider } from '../firebase.ts';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  isBackendUnreachableError,
  setTokens,
} from '../services/api.ts';
import { authService } from '../services/domainServices.ts';
import { firestoreStore } from '../services/firestoreStore.ts';
import type { User } from '../types/autopatch.ts';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isCloudSynced: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (fullName: string, email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isCloudSynced, setIsCloudSynced] = useState(false);
  const syncInFlightRef = useRef<Map<string, Promise<User>>>(new Map());

  const syncFirebaseSession = useCallback((fbUser: FirebaseUser): Promise<User> => {
    const existing = syncInFlightRef.current.get(fbUser.uid);
    if (existing) return existing;

    const promise = (async (): Promise<User> => {
      // Ensure Firebase Auth ID token & verified claims are ready before Firestore reads/writes
      const idToken = await fbUser.getIdToken();

      const cloudUser = await firestoreStore.ensureUserProfile({
        uid: fbUser.uid,
        email: fbUser.email,
        displayName: fbUser.displayName,
        photoURL: fbUser.photoURL,
      });
      setIsCloudSynced(true);

      try {
        const backendRes = await authService.firebaseLogin(idToken);
        setTokens(backendRes.access_token, backendRes.refresh_token);
        return {
          ...cloudUser,
          ...backendRes.user,
        };
      } catch (err) {
        clearTokens();
        if (!isBackendUnreachableError(err)) {
          // Still allow Cloud Firestore session if backend rejected or isn't synced
        }
        return cloudUser;
      }
    })();

    syncInFlightRef.current.set(fbUser.uid, promise);
    void promise.finally(() => {
      if (syncInFlightRef.current.get(fbUser.uid) === promise) {
        syncInFlightRef.current.delete(fbUser.uid);
      }
    });
    return promise;
  }, []);

  const refreshUser = useCallback(async () => {
    const currentFb = auth.currentUser;
    if (currentFb && currentFb.emailVerified) {
      try {
        const synced = await syncFirebaseSession(currentFb);
        setUser(synced);
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
      return;
    }

    const token = getAccessToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const { user: fetched } = await authService.me();
      setUser(fetched);
    } catch {
      clearTokens();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [syncFirebaseSession]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser && fbUser.emailVerified) {
        try {
          const synced = await syncFirebaseSession(fbUser);
          setUser(synced);
        } catch {
          // If Firestore profile setup fails, login UI or ErrorBoundary handles it
          setUser(null);
        } finally {
          setLoading(false);
        }
      } else {
        setIsCloudSynced(false);
        const token = getAccessToken();
        if (!token) {
          setUser(null);
          setLoading(false);
          return;
        }
        try {
          const { user: fetched } = await authService.me();
          setUser(fetched);
        } catch {
          clearTokens();
          setUser(null);
        } finally {
          setLoading(false);
        }
      }
    });

    return () => unsubscribe();
  }, [syncFirebaseSession]);

  const login = async (email: string, password: string) => {
    const res = await authService.login({ email, password });
    setTokens(res.access_token, res.refresh_token);
    setIsCloudSynced(false);
    if (auth.currentUser) {
      try {
        await signOut(auth);
      } catch {
        // Ignore Firebase sign-out errors
      }
    }
    setUser(res.user);
  };

  const register = async (fullName: string, email: string, password: string) => {
    const res = await authService.register({ full_name: fullName, email, password });
    setTokens(res.access_token, res.refresh_token);
    setIsCloudSynced(false);
    if (auth.currentUser) {
      try {
        await signOut(auth);
      } catch {
        // Ignore Firebase sign-out errors
      }
    }
    setUser(res.user);
  };

  const loginWithGoogle = async () => {
    clearTokens();
    const credential = await signInWithPopup(auth, googleProvider);
    const fbUser = credential.user;
    if (!fbUser.emailVerified) {
      await signOut(auth);
      throw new Error('A verified Google email address is required to sign in.');
    }
    const synced = await syncFirebaseSession(fbUser);
    setUser(synced);
  };

  const logout = async () => {
    try {
      await authService.logout(getRefreshToken());
    } catch {
      // Ignore network errors on logout
    }
    try {
      await signOut(auth);
    } catch {
      // Ignore Firebase sign-out errors
    }
    clearTokens();
    setIsCloudSynced(false);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isCloudSynced,
        login,
        register,
        loginWithGoogle,
        logout,
        refreshUser,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
