/**
 * The FCM token between the moment the device hands it over and the
 * moment a session exists to ship it with — held in MEMORY for the life
 * of the app process (online-only, decision 2026-09-15: nothing is stored
 * on the phone except the login token and the GPS buffer).
 *
 * Nothing is lost by not persisting it: `acquirePushToken` asks FCM again
 * on every launch, and FCM hands back the same token, so a token that
 * arrived before login on an earlier launch simply arrives again on this
 * one. The API's device row is what logout invalidates server-side.
 */

let parked: string | null = null;

/** The parked token, or null when none has arrived this launch. */
export async function loadPendingToken(): Promise<string | null> {
  return parked !== null && parked.length > 0 ? parked : null;
}

/** Park or replace the token. Idempotent. */
export async function savePendingToken(token: string): Promise<void> {
  parked = token;
}

/** Drop the parked token — used by tests; logout deliberately keeps it. */
export async function clearPendingToken(): Promise<void> {
  parked = null;
}
