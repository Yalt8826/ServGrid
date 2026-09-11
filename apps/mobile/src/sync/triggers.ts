/**
 * Default counterpart of `triggers.native.ts` (T1.15). Metro resolves the
 * `.native.ts` file on the handset, where the drain's real triggers live
 * (reconnect, app foreground, the active-gated 60-second timer); this
 * file is what the web bundle and every vitest run resolve instead.
 *
 * It is a genuine no-op rather than a crash on purpose: nothing outside
 * an offline role's session ever calls `start`, and dispatchers and owners
 * — the only roles that reach here, since they are the web build's roles —
 * have no mirror and no outbox (PLAN-FRONTEND.md §4). The subscription
 * functions return their own unsubscribe and never invoke `notify`, so a
 * provider that wires them simply never fires.
 */
import type { DrainTriggers } from './drain';

function subscribeNever(notify: () => void): () => void {
  void notify;
  return () => {};
}

/** The trigger set `DrainManager.start` expects — inert off the handset. */
export const systemTriggers: DrainTriggers = {
  onReconnect: subscribeNever,
  onForeground: subscribeNever,
  isActive: () => false,
};
