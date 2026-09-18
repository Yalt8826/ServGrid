/**
 * S7 Profile — the rep's lens (UI/plan-2/06-SALES-REP.md §S7). The rep
 * shares the technician's `ProfileScreen` (the profile route already
 * splits per role); reps are tracked too, so the TrackingHealthChip, the
 * permission ladder and the logout are his as well. Asserted here
 * against rep-shaped deps, so a later role-specialisation cannot silently
 * break the rep:
 *
 * - name, role, and — **behind three taps on the app version** — the
 *   `TrackingHealthChip` and the permission ladder (2026-09-18, Yashas:
 *   "remove the tracking permissions completely and show it when i click
 *   on the app version thrice instead").
 * - **Logout is immediate** — the app is online-only; nothing is queued.
 * - **Not on this screen**: no commission, no targets, no comparison
 *   with the other rep.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';

import type { TrackingHealth } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { ProfileScreen, type LadderRowState } from '../technician/ProfileScreen';

const NAME = 'Anitha Raman';

function health(overrides: Partial<TrackingHealth>): TrackingHealth {
  return {
    employeeId: 'e1000000-0000-4000-8000-000000000002',
    employeeName: NAME,
    role: 'sales_rep',
    deviceId: 'd1000000-0000-4000-8000-000000000001',
    locationPermission: 'background',
    notificationsEnabled: true,
    lastPingAt: '2026-09-11T05:54:00.000Z',
    minutesSince: 6,
    health: 'active',
    ...overrides,
  };
}

const LADDER: LadderRowState[] = [
  { step: 1, title: 'Location while using', stateText: 'Granted', done: true },
  { step: 2, title: 'Location all the time', stateText: 'Granted', done: true },
  { step: 3, title: 'Battery optimisation', stateText: 'Exempt', done: true },
  { step: 4, title: 'Xiaomi autostart', stateText: 'Confirmed', done: true },
];

function deps() {
  return {
    username: 'anitha.r',
    role: 'Sales rep',
    appVersion: '1.2.0',
    deviceModel: 'Pixel 7',
    loadHealth: vi.fn(async () => health({})),
    loadLadderRows: vi.fn(async () => LADDER),
    logout: vi.fn(),
    openLadder: vi.fn(),
    changePassword: vi.fn(),
    subscribeForeground: () => () => {},
  };
}

describe('RepProfile — §S7 via the shared screen', () => {
  it('the rep is tracked too — and the diagnostics are behind three taps on the app version', async () => {
    const r = await create(<ProfileScreen {...deps()} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'profile-name')).toBeDefined();
    expect(allText(findByTestID(tree, 'profile-name')!)).toContain(NAME);
    expect(allText(findByTestID(tree, 'profile-role')!).join(' | ')).toContain('Sales rep');
    // On arrival: identity and this phone, no tracking UI at all.
    expect(findByTestID(tree, 'profile-health-chip')).toBeUndefined();
    expect(findByTestID(tree, 'tracking-chip')).toBeUndefined();
    for (const step of [1, 2, 3, 4]) {
      expect(findByTestID(tree, `profile-ladder-row-${step}`)).toBeUndefined();
    }
    expect(findByTestID(tree, 'profile-pending-sync')).toBeUndefined(); // online-only: nothing waits

    // Three taps on the app version, and the ladder is his as well.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        findAll(findByTestID(toJson(r), 'profile-app-version')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
      });
    }
    const revealed = toJson(r);
    expect(findByTestID(revealed, 'profile-health-chip')).toBeDefined();
    expect(findByTestID(revealed, 'tracking-chip')).toBeDefined();
    for (const step of [1, 2, 3, 4]) {
      expect(findByTestID(revealed, `profile-ladder-row-${step}`)).toBeDefined();
    }
  });

  it('logout is immediate — there is no gate, because nothing is ever queued', async () => {
    const tree = toJson(await create(<ProfileScreen {...deps()} />));
    expect(findByTestID(tree, 'profile-logout-gate')).toBeUndefined();
    const logout = findAll(findByTestID(tree, 'profile-logout')!, (n) => n.type === 'Pressable')[0]!;
    expect(logout.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('no commission, no targets, no comparison with the other rep — at any depth', async () => {
    const r = await create(<ProfileScreen {...deps()} />);
    const rendered = JSON.stringify(toJson(r)).toLowerCase();
    expect(rendered).not.toContain('commission');
    expect(rendered).not.toContain('target');
    expect(rendered).not.toContain('leaderboard');
    expect(rendered).not.toContain('ranking');
    expect(rendered).not.toContain('vs the other');
  });
});
