/**
 * Ladder tests (T1.16, UI/plan-2/08-SHARED-SCREENS.md §X4). The three
 * §-marked rules are the spec's:
 *
 * - the ladder RESUMES at the failed step, judged by OS truth, not from
 *   the start;
 * - step 2 polls on foreground return and advances WITHOUT user action
 *   (Android 11+ cannot be asked in-flow; the app checks by itself);
 * - each completed step posts to `/v1/devices` immediately.
 *
 * Everything renders through the pure `LadderScreen` with faked seams —
 * the same component the route wires to the real OS.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import { allText, create, findByTestID, firstDescendantOfType, toJson, type Node } from '../components/ui/testing';
import { LadderScreen, stepTitleOf, type LadderDeps, type LadderDiagnostics } from './ladder';

// ── harness ─────────────────────────────────────────────────────────────────

interface ProbeState {
  foreground: boolean;
  background: boolean;
  battery: boolean;
  autostart: boolean;
  notifications: boolean;
}

interface Harness {
  deps: LadderDeps;
  state: ProbeState;
  posts: LadderDiagnostics[];
  calls: { openSettings: number; openAutostart: number; confirmAutostart: number };
  fireForegroundReturn: () => void;
}

function makeDeps(overrides: {
  state?: Partial<ProbeState>;
  requestForeground?: () => Promise<boolean>;
  requestBatteryExemption?: () => Promise<boolean>;
  requestNotifications?: () => Promise<boolean>;
  postOk?: boolean;
  onDone?: () => void;
} = {}): Harness {
  const state: ProbeState = {
    foreground: false,
    background: false,
    battery: false,
    autostart: false,
    notifications: false,
    ...overrides.state,
  };
  const posts: LadderDiagnostics[] = [];
  const calls = { openSettings: 0, openAutostart: 0, confirmAutostart: 0 };
  let listener: (() => void) | null = null;
  const deps: LadderDeps = {
    probe: {
      foregroundLocation: async () => state.foreground,
      backgroundLocation: async () => state.background,
      batteryExempt: async () => state.battery,
      autostartConfirmed: async () => state.autostart,
      notifications: async () => state.notifications,
    },
    actions: {
      requestForeground: overrides.requestForeground ?? (async () => {
        state.foreground = true;
        return true;
      }),
      openSettings: async () => {
        calls.openSettings += 1;
      },
      requestBatteryExemption:
        overrides.requestBatteryExemption ??
        (async () => {
          state.battery = true;
          return true;
        }),
      openAutostart: async () => {
        calls.openAutostart += 1;
      },
      confirmAutostart: async () => {
        calls.confirmAutostart += 1;
        state.autostart = true;
        return true;
      },
      requestNotifications:
        overrides.requestNotifications ??
        (async () => {
          state.notifications = true;
          return true;
        }),
    },
    postDiagnostics: async (partial) => {
      posts.push(partial);
      return overrides.postOk ?? true;
    },
    subscribeForeground: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    vendor: null,
    onDone: overrides.onDone ?? (() => {}),
  };
  return {
    deps,
    state,
    posts,
    calls,
    fireForegroundReturn: () => {
      listener?.();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flush microtasks + effects until `testID` exists (resume is async). */
async function waitFor(r: ReactTestRenderer, testID: string): Promise<Node> {
  for (let i = 0; i < 100; i += 1) {
    const hit = findByTestID(toJson(r), testID);
    if (hit !== undefined) return hit;
    await act(async () => {
      await sleep(5);
    });
  }
  throw new Error(`waitFor: ${testID} never appeared`);
}

async function press(r: ReactTestRenderer, testID: string): Promise<void> {
  const holder = findByTestID(toJson(r), testID);
  expect(holder, `missing pressable ${testID}`).toBeDefined();
  const button = firstDescendantOfType(holder!, 'Pressable')!;
  await act(async () => {
    button.props.onPress?.();
    await sleep(10);
  });
}

function titleOf(r: ReactTestRenderer): string {
  return allText(findByTestID(toJson(r), 'ladder-step-title') ?? null).join(' ').trim();
}

// ── the spec's rules ────────────────────────────────────────────────────────

describe('LadderScreen (§X4)', () => {
  it('§ resumes at the failed step, not from the start', async () => {
    // Steps 1 is done; step 2 is where this handset stands.
    const h = makeDeps({ state: { foreground: true } });
    const r = await create(<LadderScreen {...h.deps} />);

    await waitFor(r, 'ladder-step-title');

    expect(titleOf(r)).toBe(stepTitleOf(2));
    expect(titleOf(r)).toBe('Step 2 of 4');
    expect(allText(toJson(r)).join(' ')).toContain('Location all the time');
    // The verbatim Android wording, bold segments included.
    expect(allText(toJson(r)).join(' ').replace(/\s+/g, ' ')).toContain(
      'Tap Permissions → Location → Allow all the time',
    );
    // Not from the start: no step-1 action anywhere in the tree.
    expect(allText(toJson(r)).join(' ')).not.toContain('Allow location');
    expect(h.posts).toEqual([]); // resume posts nothing — nothing completed
  });

  it('§ step 2 polls on foreground and advances without user action', async () => {
    const h = makeDeps({ state: { foreground: true } });
    const onDone = vi.fn();
    h.deps.onDone = onDone;
    const r = await create(<LadderScreen {...h.deps} />);

    await waitFor(r, 'ladder-step-title');
    expect(titleOf(r)).toBe('Step 2 of 4');

    // The user grants "Allow all the time" in Settings and comes back.
    // Nobody presses anything in the app.
    h.state.background = true;
    await act(async () => {
      h.fireForegroundReturn();
      await sleep(10);
    });

    expect(titleOf(r)).toBe('Step 3 of 4');
    expect(h.calls.openSettings).toBe(0); // no user action in the app
    expect(h.posts).toEqual([{ locationPermission: 'background' }]);
  });

  it('§ each step posts to /v1/devices on completion', async () => {
    const h = makeDeps({});
    const onDone = vi.fn();
    h.deps.onDone = onDone;
    const r = await create(<LadderScreen {...h.deps} />);

    // Step 1 — the in-flow prompt grants foreground.
    await waitFor(r, 'ladder-step-title');
    expect(titleOf(r)).toBe('Step 1 of 4');
    await press(r, 'ladder-step-action');
    expect(h.posts[0]).toEqual({ locationPermission: 'foreground' });

    // Step 2 — granted in Settings; the foreground return advances.
    await waitFor(r, 'ladder-step-title');
    expect(titleOf(r)).toBe('Step 2 of 4');
    h.state.background = true;
    await act(async () => {
      h.fireForegroundReturn();
      await sleep(10);
    });
    expect(h.posts[1]).toEqual({ locationPermission: 'background' });

    // Step 3 — the battery intent resolves Success.
    await waitFor(r, 'ladder-step-title');
    expect(titleOf(r)).toBe('Step 3 of 4');
    await press(r, 'ladder-step-action');
    expect(h.posts[2]).toEqual({ batteryOptExempt: true });

    // Step 4 — "I've done this" (there is no API to verify it).
    await waitFor(r, 'ladder-step-title');
    expect(titleOf(r)).toBe('Step 4 of 4');
    await press(r, 'ladder-autostart-confirm');
    expect(h.calls.confirmAutostart).toBe(1);
    expect(h.posts[3]).toEqual({ autostartConfirmed: true });

    // After the ladder, not inside it: the notification ask is its own
    // screen, and granting it reports `notifications_enabled`.
    await waitFor(r, 'ladder-notifications-allow');
    expect(titleOf(r)).toBe('Job alerts');
    await press(r, 'ladder-notifications-allow');
    expect(h.posts[4]).toEqual({ notificationsEnabled: true });
    expect(onDone).toHaveBeenCalledTimes(1);

    expect(h.posts).toEqual([
      { locationPermission: 'foreground' },
      { locationPermission: 'background' },
      { batteryOptExempt: true },
      { autostartConfirmed: true },
      { notificationsEnabled: true },
    ]);
  });

  it('a notification refusal is not fatal: posts false, completes the flow', async () => {
    // Every ladder step already granted — the ladder opens (and ends) at
    // the notification ask.
    const h = makeDeps({
      state: { foreground: true, background: true, battery: true, autostart: true },
      requestNotifications: async () => false, // Android 13+ prompt refused
    });
    const onDone = vi.fn();
    h.deps.onDone = onDone;
    const r = await create(<LadderScreen {...h.deps} />);

    await waitFor(r, 'ladder-notifications-allow');
    await press(r, 'ladder-notifications-allow');

    expect(h.posts).toEqual([{ notificationsEnabled: false }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('"Not now" strands nobody: the flow closes without posting a guess', async () => {
    const h = makeDeps({
      state: { foreground: true, background: true, battery: true, autostart: true },
    });
    const onDone = vi.fn();
    h.deps.onDone = onDone;
    const r = await create(<LadderScreen {...h.deps} />);

    await waitFor(r, 'ladder-notifications-allow');
    await press(r, 'ladder-notifications-decline');

    expect(h.posts).toEqual([]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a step that could not reach the server still advances, with the honest banner', async () => {
    const h = makeDeps({ postOk: false });
    const r = await create(<LadderScreen {...h.deps} />);

    await waitFor(r, 'ladder-step-title');
    await press(r, 'ladder-step-action');

    expect(h.posts).toEqual([{ locationPermission: 'foreground' }]);
    await waitFor(r, 'ladder-banner');
    expect(allText(findByTestID(toJson(r), 'ladder-banner') ?? null).join(' ')).toContain('could not be reached');
    expect(titleOf(r)).toBe('Step 2 of 4');
  });

  it('an unrostered vendor gets the generic walkthrough, rostered get theirs', async () => {
    const h = makeDeps({ state: { foreground: true, background: true, battery: true } });
    const r = await create(<LadderScreen {...h.deps} />);
    await waitFor(r, 'ladder-step-title');
    expect(titleOf(r)).toBe('Step 4 of 4');
    // vendor: null in this harness → generic copy.
    expect(allText(toJson(r)).join(' ')).toContain('Autostart');
    await press(r, 'ladder-autostart-open');
    expect(h.calls.openAutostart).toBe(1);
  });
});
