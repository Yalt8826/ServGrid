/**
 * The native half of the tracking gate. This module is the ONLY way app
 * code reaches the background task: importing it registers the task at
 * module scope (the OS can revive the app into it), and its functions
 * are what the ladder and the root layout call.
 *
 * The web counterpart (`trackingGate.web.ts`) is a no-op stub for this
 * gate — the gate, not the background module, is what the shared graph
 * resolves on web. The background task itself (`task.native.ts`) has no
 * web counterpart file, and the web bundle never imports it.
 */
import { AppState } from 'react-native';

import { pingBuffer, startBackgroundLocationUpdates } from './task.native';

let armed = false;

/**
 * Registers the foreground-flush trigger. Idempotent, never throws, and
 * deliberately called from the root layout on every launch: the task is
 * defined at module scope on import, and from then on every return to
 * the foreground drains whatever the OS batched while the app was away.
 * No timer runs while the app is active — the OS's batching is not
 * something to fight (PLAN-FRONTEND.md §6).
 */
export function armLocationTracking(): void {
  if (armed) return;
  armed = true;
  try {
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void pingBuffer.flushAll().catch(() => {
        // A failed drain is retried on the next foreground; never crash
        // the app over an upload.
      });
    });
  } catch {
    // Headless environments (task revival straight into this module)
    // have no AppState to listen on — the task body flushes itself.
  }
}

/**
 * True when background tracking is running afterwards. Starts the task
 * only when the background permission is already granted — permission
 * state is the OS's truth, and the ladder is what walks the user there.
 */
export async function ensureTrackingStarted(): Promise<boolean> {
  return startBackgroundLocationUpdates();
}
