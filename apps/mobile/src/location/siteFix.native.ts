/**
 * The on-site fix — one foreground position, asked for exactly once, at
 * the moment a technician files the completion (owner, 2026-09-17).
 *
 * Why it belongs here: `src/location/` is the only directory allowed to
 * import `expo-location` (`live-window.ts` states the doctrine — one
 * place knows how this app asks the device for a position), and this is
 * a location question, so it sits beside the background task rather than
 * inventing a second home.
 *
 * Why it is NOT the background tracker. `task.native.ts` records a trail
 * on a 15-minute cadence and is gated by `tech.location`; that flag is
 * the *tracking* rollout's rollback, and a technician who has it off is
 * still expected to be able to complete a job and pin where it was. The
 * two are different promises: tracking is about watching a person over a
 * day, this is about remembering a place. So the capture honours the OS
 * permission and nothing else, and a refusal degrades to "no fix".
 *
 * `Accuracy.High` is the deliberate opposite of the task's `Balanced`:
 * this fix is taken once, standing still, and its whole purpose is that
 * the NEXT visit lands on the right gate. It is given a short deadline —
 * a completion is a person waiting to close a job, not a survey — and
 * **nothing in this module ever throws**. Every failure (no permission,
 * location services off, no lock indoors, a timeout) returns null, which
 * the caller treats as an ordinary absence and files the completion
 * without.
 */
import * as Location from 'expo-location';

import type { SiteFix } from './siteFix';

/** How long one fix may take before the completion stops waiting for it. */
const FIX_TIMEOUT_MS = 8_000;

/** The last-known position is instantly available and often good enough standing on site. */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60 * 1000;

export async function captureSiteFix(): Promise<SiteFix | null> {
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) {
      // Not an error, and not an escalation: the technician may have
      // refused deliberately. The completion proceeds without a fix.
      return null;
    }

    // A fresh fix inside the deadline, else the recent cached one: the
    // first choice is the accurate answer, the second is the fast one,
    // and standing at the gate both agree.
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FIX_TIMEOUT_MS)),
    ]);
    const fix =
      fresh ??
      (await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }));

    if (fix === null || fix === undefined) return null;
    return { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
  } catch {
    return null;
  }
}
