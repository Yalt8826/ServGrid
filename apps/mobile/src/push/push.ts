/**
 * The one gate for push registration — the exact seam T0.15 is trying to
 * prove. The device's FCM token must always reach the app (the notification
 * permission prompt belongs to the notifications module, a later task);
 * what varies is when the token is shipped to the API:
 *
 * - anonymous: hold the token locally; ship it on the next successful login.
 * - authenticated: ship immediately.
 *
 * In both cases the token also persists through `pendingToken`, so a token
 * that arrives before login is still there when the session exists.
 */
import { Platform } from 'react-native';
import { getDevicePushTokenAsync } from 'expo-notifications';
import { api } from '../lib/api';
import { loadPendingToken, savePendingToken } from './pendingToken';
import { useSessionStore } from '../state/sessionStore';

const REGISTRATION_PATH = '/v1/devices/push-token';

/** True on the Android app — the only surface with FCM. */
export function pushSupported(): boolean {
  return Platform.OS !== 'web';
}

/** True when the session store says someone is logged in. */
function isAuthenticated(): boolean {
  return useSessionStore.getState().status === 'authenticated';
}

/**
 * Read the device's FCM token and apply the gate. Returns the token, or
 * null when there is nothing to do — web, no Play services, or the API
 * unreachable (the token stays parked for the next attempt).
 *
 * Registration failing must never block start-up and never surface as an
 * error: push is a latency improvement over the sync triggers
 * (PLAN-BACKEND.md §12.1), so every failure here is silently retried on
 * the next launch or login.
 */
export async function acquirePushToken(): Promise<string | null> {
  if (!pushSupported()) return null;

  let token: string;
  try {
    const deviceToken = await getDevicePushTokenAsync();
    token = deviceToken.data;
  } catch {
    // No Play services (some OEM builds, emulators) — nothing to register.
    return null;
  }
  if (token.length === 0) return null;

  // Dev builds print the token so the T0.15 probe (apps/api/tools/
  // fcm-probe.mjs) can target this handset: `adb logcat -s ReactNativeJS`.
  if (__DEV__) console.log(`[push] FCM token: ${token}`);

  // Persist first: a token that arrives before login must still be there
  // when the session exists. A storage write failing must not fail
  // registration — the in-memory value still ships below.
  try {
    await savePendingToken(token);
  } catch {
    // Storage failure is not fatal to registration.
  }

  if (!isAuthenticated()) return null; // parked; shipped on the next login

  // `request` carries Authorization, X-Source and X-Device-Id, and runs
  // its refresh-on-401 path — a 401 after a completed refresh leaves the
  // session cleared and the token parked, which is exactly right.
  try {
    const res = await api.request('POST', REGISTRATION_PATH, {
      body: { token, platform: Platform.OS },
    });
    if (!res.ok) return null; // parked; retried on the next launch/login
  } catch {
    return null;
  }
  return token;
}

/**
 * Ship a token that was parked before login. Called from the authenticated
 * branch of the cold-start bootstrap and after `login`. Never throws.
 */
export async function registerPendingPushToken(): Promise<void> {
  if (!pushSupported() || !isAuthenticated()) return;
  let token: string | null;
  try {
    token = await loadPendingToken();
  } catch {
    return;
  }
  if (token === null) return;
  try {
    const res = await api.request('POST', REGISTRATION_PATH, {
      body: { token, platform: Platform.OS },
    });
    if (!res.ok) return; // stays parked for the next attempt
  } catch {
    return; // network failed — still parked, still retried later
  }
}
