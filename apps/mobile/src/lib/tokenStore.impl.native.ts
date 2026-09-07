/**
 * Native implementation of `TokenStore` — Keychain on iOS, Keystore on
 * Android, through `expo-secure-store`. Metro loads this file for every
 * non-web bundle; it is never compiled into the web build.
 */
import * as SecureStore from 'expo-secure-store';
import type { StoredSession, TokenStore } from './tokenStore';
import { parseStoredSession } from './tokenStore';
import { uuid } from './uuid';

const SESSION_KEY = 'servgrid.session.v1';
const INSTALL_ID_KEY = 'servgrid.installId.v1';
const SECURE_STORE_OPTIONS = {
  // The refresh token outlives any single unlock window by design
  // (60 days, PLAN-BACKEND.md §4); it must survive a locked device.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} as const;

async function readRaw(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS);
}

async function writeRaw(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, SECURE_STORE_OPTIONS);
}

export const impl: TokenStore = {
  async load(): Promise<StoredSession | null> {
    try {
      const raw = await readRaw(SESSION_KEY);
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null; // unwritable junk — treat as absent
      }
      return parseStoredSession(parsed);
    } catch (err) {
      // A keystore read failure is surfaced, not swallowed: callers
      // distinguish "no session" from "cannot reach the keystore".
      throw err instanceof Error ? err : new Error(String(err));
    }
  },

  async save(session: StoredSession): Promise<void> {
    await writeRaw(SESSION_KEY, JSON.stringify(session));
  },

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(SESSION_KEY, SECURE_STORE_OPTIONS);
  },

  async installId(): Promise<string> {
    const existing = await readRaw(INSTALL_ID_KEY);
    if (existing !== null && existing.length > 0) return existing;
    const id = await uuid();
    await writeRaw(INSTALL_ID_KEY, id);
    return id;
  },
};
