/**
 * Reachability, for every role (PLAN-FRONTEND.md §5). Online-only since
 * 2026-09-15: the no-connection gate and every screen's submit read this
 * one answer.
 *
 * `isInternetReachable !== false` fails open: an unknown answer (a cold
 * start before the first probe, a runtime without the listener) counts as
 * online, and a genuinely failed request raises its own error. Covering
 * the whole app on a guess would be worse than one failed fetch.
 */
import { useEffect, useState } from 'react';
import * as Network from 'expo-network';

export function useIsOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let alive = true;
    void Network.getNetworkStateAsync()
      .then((state) => {
        if (alive) setOnline(state.isInternetReachable !== false);
      })
      .catch(() => {});
    try {
      const subscription = Network.addNetworkStateListener((state) => {
        setOnline(state.isInternetReachable !== false);
      });
      return () => {
        alive = false;
        subscription.remove();
      };
    } catch {
      return () => {
        alive = false;
      };
    }
  }, []);
  return online;
}
