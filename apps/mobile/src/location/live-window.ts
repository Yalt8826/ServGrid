/**
 * The live window — the device half of locate-now `live` mode (T4.4,
 * PLAN-BACKEND.md §8: "`live` … instructs the device to switch to ~10s
 * intervals then revert"). A `live` push flips tracking to ~10-second
 * fixes for five minutes, then reverts to the scheduled cadence. THE
 * REVERT IS NOT OPTIONAL: a device left at 10s intervals is a battery
 * complaint the next morning, so the revert is armed the moment the
 * window opens, fires exactly once, and `stop()` (logout, shutdown)
 * reverts immediately rather than leaving the expensive cadence running
 * unowned.
 *
 * Pure on purpose: this module owns only the STATE MACHINE — when the
 * cadence went up, when it must come down, what a second push mid-window
 * means (extend — the owner pressed live again, not twice as fast). The
 * actual flip is injected (`raise`/`revert`), because only the native
 * graph may touch expo-location: `task.native.ts` configures the
 * singleton with real restarts, and every other surface — web, tests,
 * the universal push graph — gets an inert controller that simply never
 * engages. A push arriving with no configured controller is answered
 * `false`, and the request's own expiry does the honest thing server-side.
 *
 * Plain `.ts`, not `.native.ts`: the push funnel (`push/backgroundTask`)
 * is a universal file and imports this module by bare specifier, so it
 * must resolve on every platform — on web it resolves to this same file,
 * where `onLocationLivePush` is a no-op returning false.
 */

/** The live cadence: ~10s fixes (§8). */
export const LIVE_INTERVAL_MS = 10_000;

/** The window length: five minutes, then revert (§8). */
export const LIVE_WINDOW_MS = 5 * 60_000;

/**
 * The `type` value of a locate-now push — the wire contract with
 * `locationRequestData()` in `apps/api/src/modules/location/service.ts`
 * (named here too because packages/shared is deliberately untouched by
 * this stage; keep the two strings identical).
 */
export const LOCATION_PUSH_TYPE = 'location-request';

/** One live window's callbacks. Both may be async; rejections are
 * contained — a failed flip must never crash the push path, and the
 * revert is re-armable by the next push or the next `stop()`. */
export interface LiveWindowCallbacks {
  /** Switch tracking to the live cadence (~10s, high accuracy). */
  raise: () => void;
  /** Restore the scheduled cadence (15 min, balanced). */
  revert: () => void;
}

export interface LiveWindowController {
  /** A `live` push arrived. First push raises immediately and arms the
   * five-minute revert; a push while already live keeps the cadence up
   * and re-arms a FULL window from now — the owner asked for five more
   * minutes of live, not a staircase of stacked timers. */
  onLivePush(): void;
  /** Leave the window without waiting out the timer — logout, task
   * teardown. Reverts immediately iff live; never reverts twice. */
  stop(): void;
  isActive(): boolean;
}

function invoke(callback: () => void): void {
  try {
    // Sync call, contained rejection: the callback runs now (fake
    // timers and spies observe it synchronously), only its result is
    // promised away.
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // Contained — the state machine is correct even if the flip failed.
  }
}

export function createLiveWindowController(callbacks: LiveWindowCallbacks): LiveWindowController {
  let revertTimer: ReturnType<typeof setTimeout> | null = null;
  let live = false;

  const disarm = (): void => {
    if (revertTimer !== null) {
      clearTimeout(revertTimer);
      revertTimer = null;
    }
  };

  const revertNow = (): void => {
    if (!live) return;
    live = false;
    disarm();
    invoke(callbacks.revert);
  };

  return {
    onLivePush(): void {
      disarm();
      if (!live) {
        live = true;
        invoke(callbacks.raise);
      }
      revertTimer = setTimeout(() => {
        revertTimer = null;
        revertNow();
      }, LIVE_WINDOW_MS);
    },
    stop(): void {
      revertNow();
    },
    isActive(): boolean {
      return live;
    },
  };
}

// ── the process singleton ────────────────────────────────────────────────────

let controller: LiveWindowController | null = null;

/**
 * Native start-up wires the real flips (`task.native.ts`, the only
 * caller). Reconfiguring stops any open window first, so a re-init can
 * never strand the live cadence without an armed revert.
 */
export function configureLiveWindow(callbacks: LiveWindowCallbacks): void {
  controller?.stop();
  controller = createLiveWindowController(callbacks);
}

/**
 * The push funnel's entry. True iff this data message IS a live
 * locate-now push AND the window is configured — every other data
 * payload (`type: "sync"` job wakes, a `fix` request, garbage) is
 * answered false and flows on to whatever handles it.
 */
export function onLocationLivePush(data: Record<string, unknown> | undefined): boolean {
  if (controller === null) return false;
  if (data?.['type'] !== LOCATION_PUSH_TYPE || data?.['mode'] !== 'live') return false;
  controller.onLivePush();
  return true;
}

/** Logout / teardown: close an open window now instead of at the timer. */
export function stopLiveWindow(): void {
  controller?.stop();
}

/** Test helper: forget the configured controller. */
export function __resetLiveWindowForTests(): void {
  controller?.stop();
  controller = null;
}
