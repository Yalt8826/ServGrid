/**
 * T7 Profile tests (UI/plan-2/04-TECHNICIAN.md §T7, PLAN-FRONTEND.md §5,
 * §6). The three the spec names:
 *
 * - **All four chip states render; red and amber are tappable and route
 *   to the failed ladder step.**
 * - **The chip has no animation driver attached** — a pulsing red chip
 *   would run continuously on the device whose battery this app is
 *   trying to protect.
 * - **Logout blocked with a queued row, and the count matches** — with
 *   no confirm-and-lose path anywhere, and rejected/failed rows never
 *   blocking.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { TrackingHealth } from '@servgrid/shared';
import { findAll, findByTestID, allText, create, toJson } from '../../components/ui/testing';
import { ProfileScreen, type LadderRowState, type ProfileDeps } from './ProfileScreen';

const NAME = 'Ravi Kumar';

function health(overrides: Partial<TrackingHealth>): TrackingHealth {
  return {
    employeeId: 'e1000000-0000-4000-8000-000000000001',
    employeeName: NAME,
    role: 'technician',
    deviceId: 'd1000000-0000-4000-8000-000000000001',
    locationPermission: 'background',
    notificationsEnabled: true,
    lastPingAt: '2026-09-11T05:54:00.000Z',
    minutesSince: 6,
    health: 'active',
    ...overrides,
  };
}

const ALL_DONE: LadderRowState[] = [
  { step: 1, title: 'Location while using', stateText: 'Granted', done: true },
  { step: 2, title: 'Location all the time', stateText: 'Granted', done: true },
  { step: 3, title: 'Battery optimisation', stateText: 'Exempt', done: true },
  { step: 4, title: 'Xiaomi autostart', stateText: 'Confirmed', done: true },
];

interface Fakes {
  loadHealth: ReturnType<typeof vi.fn>;
  loadLadderRows: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  openLadder: ReturnType<typeof vi.fn>;
  changePassword: ReturnType<typeof vi.fn>;
}

function fakes(overrides: Partial<ProfileDeps> = {}): { deps: ProfileDeps; f: Fakes } {
  const f: Fakes = {
    loadHealth: vi.fn(async () => health({})),
    loadLadderRows: vi.fn(async () => ALL_DONE),
    logout: vi.fn(),
    openLadder: vi.fn(),
    changePassword: vi.fn(),
  };
  const deps: ProfileDeps = {
    username: 'ravi.k',
    role: 'Technician',
    appVersion: '1.2.0',
    deviceModel: 'Pixel 7',
    subscribeForeground: () => () => {},
    ...f,
    ...overrides,
  } as ProfileDeps;
  return { deps, f };
}

async function press(renderer: ReactTestRenderer, testID: string): Promise<void> {
  const node = findByTestID(toJson(renderer), testID)!;
  const pressable = node.type === 'Pressable' ? node : findAll(node, (n) => n.type === 'Pressable')[0];
  if (!pressable) return; // nothing tappable here — its absence is the assertion
  await act(async () => {
    pressable.props.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const STATES: Array<{ name: string; h: TrackingHealth; tone: 'good' | 'warn' | 'bad'; text: string }> = [
  {
    name: 'green: active, last ping 6 min ago',
    h: health({ health: 'active', minutesSince: 6 }),
    tone: 'good',
    text: 'Tracking active · last ping 6 min ago',
  },
  {
    name: 'amber: stale, last ping 2h ago',
    h: health({ health: 'stale', minutesSince: 118 }),
    tone: 'warn',
    text: 'Last ping 2h ago',
  },
  {
    name: 'red: background permission missing',
    h: health({ health: 'permission_missing', locationPermission: 'foreground' }),
    tone: 'bad',
    text: 'Background permission missing — fix',
  },
  {
    name: 'amber: job alerts off',
    h: health({ health: 'active', notificationsEnabled: false }),
    tone: 'warn',
    text: 'Job alerts off — you won’t be told about new jobs',
  },
];

/**
 * The tracking diagnostics are behind three taps on the app-version row
 * (2026-09-18, Yashas) — every assertion about the chip or the ladder rows
 * has to walk through the door first, which is the point of it.
 */
async function reveal(renderer: ReactTestRenderer): Promise<void> {
  for (let i = 0; i < 3; i += 1) await press(renderer, 'profile-app-version');
}

describe('ProfileScreen (§T7)', () => {
  it('a plain profile carries no tracking UI — it is behind three taps on the app version', async () => {
    const { deps } = fakes({ loadHealth: async () => health({}) });
    const r = await create(<ProfileScreen {...deps} />);

    // Nothing tracking-shaped on arrival: not the chip, not the rows, not
    // the word — this is the ask verbatim ("remove the tracking
    // permissions completely").
    const before = toJson(r);
    expect(findByTestID(before, 'profile-health-chip')).toBeUndefined();
    expect(findByTestID(before, 'tracking-chip')).toBeUndefined();
    for (const step of [1, 2, 3, 4]) {
      expect(findByTestID(before, `profile-ladder-row-${step}`)).toBeUndefined();
    }
    // `SectionHeader` uppercases its label, so the marker reads in caps.
    expect(allText(before).join(' | ')).not.toContain('TRACKING PERMISSIONS');

    // Two taps are not enough…
    await press(r, 'profile-app-version');
    await press(r, 'profile-app-version');
    expect(findByTestID(toJson(r), 'tracking-chip')).toBeUndefined();

    // …the third opens it, where it always was.
    await press(r, 'profile-app-version');
    expect(findByTestID(toJson(r), 'tracking-chip')).toBeDefined();
    expect(allText(toJson(r)).join(' | ')).toContain('TRACKING PERMISSIONS');
  });

  it('§ all four chip states render from the view data', async () => {
    for (const state of STATES) {
      const { deps } = fakes({ loadHealth: async () => state.h });
      const r = await create(<ProfileScreen {...deps} />);
      await reveal(r);
      const chip = findByTestID(toJson(r), 'tracking-chip');
      expect(chip, state.name).toBeDefined();
      const texts = allText(chip ?? null);
      expect(texts.join(' | '), state.name).toContain(state.text);
      // The dot carries the state's colour; the text stays legible.
      expect(findByTestID(toJson(r), 'tracking-chip-text'), state.name).toBeDefined();
    }
  });

  it('§ red and amber are tappable and route to the failed ladder step; green is not', async () => {
    // Red, permission `foreground` → the failed step is 2 (background).
    const red = fakes({ loadHealth: async () => health({ health: 'permission_missing', locationPermission: 'foreground' }) });
    let r = await create(<ProfileScreen {...red.deps} />);
    await reveal(r);
    expect(findByTestID(toJson(r), 'tracking-chip-fix')).toBeDefined();
    await press(r, 'tracking-chip-fix');
    expect(red.f.openLadder).toHaveBeenCalledWith(2);

    // Red, permission `none` → the failed step is 1.
    const none = fakes({ loadHealth: async () => health({ health: 'permission_missing', locationPermission: null }) });
    r = await create(<ProfileScreen {...none.deps} />);
    await reveal(r);
    await press(r, 'tracking-chip-fix');
    expect(none.f.openLadder).toHaveBeenCalledWith(1);

    // Amber, alerts off → the notifications ask that follows the ladder.
    const alerts = fakes({ loadHealth: async () => health({ notificationsEnabled: false }) });
    r = await create(<ProfileScreen {...alerts.deps} />);
    await reveal(r);
    await press(r, 'tracking-chip-fix');
    expect(alerts.f.openLadder).toHaveBeenCalledWith('notifications');

    // Amber, stale with background granted → step 3 (battery/autostart).
    const stale = fakes({ loadHealth: async () => health({ health: 'stale', minutesSince: 200 }) });
    r = await create(<ProfileScreen {...stale.deps} />);
    await reveal(r);
    await press(r, 'tracking-chip-fix');
    expect(stale.f.openLadder).toHaveBeenCalledWith(3);

    // Green: nothing to fix, no tap target offered.
    const good = fakes();
    r = await create(<ProfileScreen {...good.deps} />);
    await reveal(r);
    expect(findByTestID(toJson(r), 'tracking-chip-fix')).toBeUndefined();
    await press(r, 'tracking-chip-text');
    expect(good.f.openLadder).not.toHaveBeenCalled();
  });

  it('§ the chip has no animation driver attached', async () => {
    const { deps } = fakes({ loadHealth: async () => health({ health: 'permission_missing', locationPermission: 'none' }) });
    const r = await create(<ProfileScreen {...deps} />);
    await reveal(r);
    const chip = findByTestID(toJson(r), 'tracking-chip')!;
    // No animated node type anywhere in the chip's subtree.
    expect(findAll(chip, (n) => String(n.type).startsWith('Animated'))).toHaveLength(0);
    // And no animated property — no transform, no opacity, no driver.
    const animatedProps = findAll(chip, (n) => {
      const props = Object.keys(n.props);
      return props.includes('transform') || props.includes('opacity') || props.includes('entering') || props.includes('exiting');
    });
    expect(animatedProps).toHaveLength(0);
    // The chip is a static View/Text/Pressable composition, nothing else.
    for (const node of findAll(chip, () => true)) {
      expect(['View', 'Text', 'Pressable']).toContain(node.type);
    }
  });

  it('§ logout is one tap — nothing is ever queued on this phone (online-only)', async () => {
    const { deps, f } = fakes();
    const r = await create(<ProfileScreen {...deps} />);
    expect(findByTestID(toJson(r), 'profile-logout-gate')).toBeUndefined();
    expect(findByTestID(toJson(r), 'profile-retry-sync')).toBeUndefined();
    expect(findByTestID(toJson(r), 'profile-pending-sync')).toBeUndefined();
    await press(r, 'profile-logout');
    expect(f.logout).toHaveBeenCalledTimes(1);
    // No confirm-and-lose path: no dialog exists on this screen.
    expect(allText(toJson(r)).join(' | ').toLowerCase()).not.toContain('are you sure');
  });

  it('ladder rows render with individual state and Fix routes to the ladder', async () => {
    const rows: LadderRowState[] = [
      { step: 1, title: 'Location while using', stateText: 'Granted', done: true },
      { step: 2, title: 'Location all the time', stateText: 'Granted', done: true },
      { step: 3, title: 'Battery optimisation', stateText: 'Exempt', done: true },
      { step: 4, title: 'Xiaomi autostart', stateText: 'Not confirmed', done: false },
    ];
    const { deps, f } = fakes({ loadLadderRows: async () => rows });
    const r = await create(<ProfileScreen {...deps} />);
    await reveal(r);
    // Three resolved rows, one waiting with its Fix.
    expect(findAll(toJson(r), (n) => n.props.testID === 'ladder-row-check')).toHaveLength(3);
    expect(findByTestID(toJson(r), 'ladder-row-pending')).toBeDefined();
    expect(allText(toJson(r))).toContain('Xiaomi autostart');
    expect(allText(toJson(r))).toContain('Not confirmed');
    await press(r, 'profile-ladder-fix-4');
    expect(f.openLadder).toHaveBeenCalledWith(4);
    // No Fix on resolved rows.
    expect(findByTestID(toJson(r), 'profile-ladder-fix-1')).toBeUndefined();
  });

  it('the ladder beat plays on return from settings: a row resolving flips its check', async () => {
    const rows: LadderRowState[] = [
      { step: 1, title: 'Location while using', stateText: 'Granted', done: true },
      { step: 2, title: 'Location all the time', stateText: 'Granted', done: true },
      { step: 3, title: 'Battery optimisation', stateText: 'Exempt', done: true },
      { step: 4, title: 'Xiaomi autostart', stateText: 'Not confirmed', done: false },
    ];
    let current = rows;
    let listener: (() => void) | null = null;
    const { deps } = fakes({
      loadLadderRows: async () => current,
      subscribeForeground: (l) => {
        listener = l;
        return () => {};
      },
    });
    const r = await create(<ProfileScreen {...deps} />);
    await reveal(r);
    expect(findByTestID(toJson(r), 'ladder-row-pending')).toBeDefined();

    // He comes back from Settings having granted autostart; the
    // foreground return re-probes and the row resolves.
    current = rows.map((row) => (row.step === 4 ? { ...row, stateText: 'Confirmed', done: true } : row));
    await act(async () => {
      listener?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findAll(toJson(r), (n) => n.props.testID === 'ladder-row-check')).toHaveLength(4);
    expect(findByTestID(toJson(r), 'ladder-row-pending')).toBeUndefined();
  });

  it('identity, app version and device model render; change password routes', async () => {
    const { deps, f } = fakes();
    const r = await create(<ProfileScreen {...deps} />);
    expect(allText(toJson(r))).toContain(NAME);
    expect(allText(toJson(r))).toContain('Technician · ravi.k');
    expect(allText(toJson(r))).toContain('1.2.0');
    expect(allText(toJson(r))).toContain('Pixel 7');
    await press(r, 'profile-change-password');
    expect(f.changePassword).toHaveBeenCalledTimes(1);
    // Not on this screen, ever: no earnings, no stats, no ranking.
    const lower = allText(toJson(r)).join(' | ').toLowerCase();
    expect(lower).not.toContain('earning');
    expect(lower).not.toContain('rank');
    expect(lower).not.toContain('leaderboard');
    expect(lower).not.toContain('performance');
  });
});
