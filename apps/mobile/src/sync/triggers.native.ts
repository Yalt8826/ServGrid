/**
 * Native wiring of the drain triggers (T1.14, PLAN-FRONTEND.md §5):
 * reconnect via `expo-network`, app foreground via `AppState`, and the
 * 60-second timer, gated on the app being active. `DrainManager.start`
 * consumes these as plain subscribe/gate functions, so this file stays the
 * only one that knows the platform APIs — the manager itself, and every
 * test of it, run platform-free.
 *
 * `.native.ts` only: the technician's Android build is the sole surface
 * with an outbox (dispatchers and owners are online-only, PLAN-FRONTEND.md
 * §4), and nothing in platform-neutral code imports this module, so the
 * web bundle never resolves it either.
 */
import { AppState } from 'react-native';
import * as Network from 'expo-network';

import type { DrainTriggers } from './drain';

/** True once the network has become reachable after being unreachable (or
 * on the first observation, which the app may have missed while dead). */
function wireReconnect(notify: () => void): () => void {
  let wasReachable: boolean | undefined = undefined;
  const subscription = Network.addNetworkStateListener((state) => {
    const reachable = state.isInternetReachable === true;
    const previous = wasReachable;
    wasReachable = reachable;
    if (reachable && previous !== true) notify();
  });
  return () => subscription.remove();
}

function wireForeground(notify: () => void): () => void {
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') notify();
  });
  return () => subscription.remove();
}

function isAppActive(): boolean {
  return AppState.currentState === 'active';
}

/** The trigger set `DrainManager.start` expects, wired to the real OS. */
export const systemTriggers: DrainTriggers = {
  onReconnect: wireReconnect,
  onForeground: wireForeground,
  isActive: isAppActive,
};
