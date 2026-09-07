/**
 * Web implementation of `TokenStore` — `localStorage` on the owner's
 * desktop browser. Metro loads this file only for web bundles; the native
 * one is never compiled into the web build. Web is a trusted machine with
 * a 15-minute access token and a rotating refresh token as mitigation
 * (PLAN-FRONTEND.md §4).
 */
import type { StoredSession, TokenStore } from './tokenStore';
import { parseStoredSession } from './tokenStore';
import { uuid } from './uuid';

const SESSION_KEY = 'servgrid.session.v1';
const INSTALL_ID_KEY = 'servgrid.installId.v1';

function localStorageRef(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null; // storage disabled
  }
}

export const impl: TokenStore = {
  async load(): Promise<StoredSession | null> {
    const storage = localStorageRef();
    if (storage === null) return null;
    try {
      const raw = storage.getItem(SESSION_KEY);
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null; // unwritable junk — treat as absent
      }
      return parseStoredSession(parsed);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  },

  async save(session: StoredSession): Promise<void> {
    const storage = localStorageRef();
    if (storage === null) {
      throw new Error('localStorage is unavailable; cannot store the session');
    }
    storage.setItem(SESSION_KEY, JSON.stringify(session));
  },

  async clear(): Promise<void> {
    const storage = localStorageRef();
    if (storage === null) {
      throw new Error('localStorage is unavailable; cannot clear the session');
    }
    storage.removeItem(SESSION_KEY);
  },

  async installId(): Promise<string> {
    const storage = localStorageRef();
    if (storage === null) {
      throw new Error('localStorage is unavailable; cannot persist the install id');
    }
    const existing = storage.getItem(INSTALL_ID_KEY);
    if (existing !== null && existing.length > 0) return existing;
    const id = await uuid();
    storage.setItem(INSTALL_ID_KEY, id);
    return id;
  },
};
