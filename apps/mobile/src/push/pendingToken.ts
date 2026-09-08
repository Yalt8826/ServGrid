/**
 * Persistence for the FCM token between the moment the device hands it
 * over and the moment a session exists to ship it with. AsyncStorage —
 * not the token store, whose payload is the session and whose seam is
 * the `tokenStore.impl` platform split: the push token is device
 * identity, not session state, so it survives `clear()` and logout by
 * design (same rule as `installId`, tokenStore.ts). The API's device
 * row is what logout invalidates server-side; keeping the token here
 * only means the next login re-registers without a second FCM round
 * trip. AsyncStorage carries a web implementation, so the owner's
 * desktop bundle compiles this module fine — it just never runs there
 * (`pushSupported()` gates the caller).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const PENDING_TOKEN_KEY = 'servgrid.pushToken.v1';

/** The parked token, or null when none was ever parked. */
export async function loadPendingToken(): Promise<string | null> {
  const value = await AsyncStorage.getItem(PENDING_TOKEN_KEY);
  return value !== null && value.length > 0 ? value : null;
}

/** Park or replace the token. Idempotent. */
export async function savePendingToken(token: string): Promise<void> {
  await AsyncStorage.setItem(PENDING_TOKEN_KEY, token);
}

/** Drop the parked token — used by tests; logout deliberately keeps it. */
export async function clearPendingToken(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_TOKEN_KEY);
}
