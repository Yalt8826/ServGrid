/**
 * The live window's state machine (T4.4, PLAN-BACKEND.md §8): a `live`
 * locate-now push raises tracking to ~10s intervals and REVERTS after
 * five minutes. Proven with fake timers, because the revert is the part
 * that must never be skipped — a device left at 10s intervals is a
 * battery complaint the next morning.
 *
 * The callbacks here are spies: the module owns only the state machine;
 * the real flips live in `task.native.ts` (native graph, expo-location).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLiveWindowController,
  LIVE_INTERVAL_MS,
  LIVE_WINDOW_MS,
  LOCATION_PUSH_TYPE,
  __resetLiveWindowForTests,
  configureLiveWindow,
  onLocationLivePush,
} from './live-window';

const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  __resetLiveWindowForTests();
  vi.useRealTimers();
});

describe('the live window — raise, then revert, always', () => {
  it('the constants are the §8 contract: ~10s cadence, five-minute window', () => {
    expect(LIVE_INTERVAL_MS).toBe(10_000);
    expect(LIVE_WINDOW_MS).toBe(5 * 60_000);
  });

  it('a live push raises immediately and reverts after exactly five minutes', () => {
    const raise = vi.fn();
    const revert = vi.fn();
    const window = createLiveWindowController({ raise, revert });

    window.onLivePush();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(window.isActive()).toBe(true);

    // 4:59 — still live, no revert.
    vi.advanceTimersByTime(LIVE_WINDOW_MS - 1_000);
    expect(revert).not.toHaveBeenCalled();
    expect(window.isActive()).toBe(true);

    // The last minute elapses: exactly one revert.
    vi.advanceTimersByTime(1_000);
    expect(revert).toHaveBeenCalledTimes(1);
    expect(window.isActive()).toBe(false);

    // Time keeps passing: no second revert, no further raises.
    vi.advanceTimersByTime(10 * MINUTE);
    expect(revert).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('a second push mid-window extends the full five minutes without re-raising', () => {
    const raise = vi.fn();
    const revert = vi.fn();
    const window = createLiveWindowController({ raise, revert });

    window.onLivePush();
    vi.advanceTimersByTime(4 * MINUTE);

    // The owner pressed live again: the cadence stays UP (no flip-flop),
    // and the clock restarts — five minutes from NOW, not from the ask.
    window.onLivePush();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(window.isActive()).toBe(true);

    vi.advanceTimersByTime(1 * MINUTE); // t=5:00 — the ORIGINAL window's edge
    expect(revert).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4 * MINUTE - 1_000); // t=8:59 into the extension
    expect(revert).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000); // t=9:00 — five minutes after the re-ask
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('stop() reverts immediately — logout and teardown never leave 10s running', () => {
    const raise = vi.fn();
    const revert = vi.fn();
    const window = createLiveWindowController({ raise, revert });

    window.onLivePush();
    vi.advanceTimersByTime(2 * MINUTE);
    window.stop();

    expect(revert).toHaveBeenCalledTimes(1);
    expect(window.isActive()).toBe(false);

    // The armed timer is disarmed: no second revert at the original edge.
    vi.advanceTimersByTime(10 * MINUTE);
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('stop() on a never-opened window does nothing, and reverts happen once', () => {
    const raise = vi.fn();
    const revert = vi.fn();
    const window = createLiveWindowController({ raise, revert });

    window.stop();
    expect(revert).not.toHaveBeenCalled();

    window.onLivePush();
    window.stop();
    window.stop();
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('a raise that throws still arms the revert — the flip-back is not conditional', () => {
    const raise = vi.fn(() => {
      throw new Error('expo-location refused');
    });
    const revert = vi.fn();
    const window = createLiveWindowController({ raise, revert });

    expect(() => window.onLivePush()).not.toThrow();
    vi.advanceTimersByTime(LIVE_WINDOW_MS);
    expect(revert).toHaveBeenCalledTimes(1);
  });
});

describe('onLocationLivePush — the push funnel entry', () => {
  it('opens the window for the API’s live locate-now payload and returns true', () => {
    const raise = vi.fn();
    const revert = vi.fn();
    configureLiveWindow({ raise, revert });

    // The wire payload of `locationRequestData()` (apps/api …/service.ts):
    // { type: 'location-request', requestId, mode: 'live' }.
    const handled = onLocationLivePush({ type: LOCATION_PUSH_TYPE, requestId: 'req-1', mode: 'live' });
    expect(handled).toBe(true);
    expect(raise).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LIVE_WINDOW_MS);
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('a fix-mode push is not a live window — it flows on to the plain wake', () => {
    const raise = vi.fn();
    configureLiveWindow({ raise, revert: vi.fn() });

    expect(onLocationLivePush({ type: LOCATION_PUSH_TYPE, requestId: 'req-2', mode: 'fix' })).toBe(false);
    expect(raise).not.toHaveBeenCalled();
  });

  it('job wakes (`type: "sync"`) and payload-less deliveries are answered false', () => {
    const raise = vi.fn();
    configureLiveWindow({ raise, revert: vi.fn() });

    expect(onLocationLivePush({ type: 'sync' })).toBe(false);
    expect(onLocationLivePush(undefined)).toBe(false);
    expect(raise).not.toHaveBeenCalled();
  });

  it('unconfigured — web, or no native graph — is an inert false', () => {
    expect(onLocationLivePush({ type: LOCATION_PUSH_TYPE, requestId: 'req-3', mode: 'live' })).toBe(false);
  });
});
