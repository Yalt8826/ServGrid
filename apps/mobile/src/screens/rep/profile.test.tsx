/**
 * S7 Profile — the rep's lens (UI/plan-2/06-SALES-REP.md §S7). The rep
 * shares the technician's `ProfileScreen` (the profile route already
 * splits per role); reps are tracked too, so the TrackingHealthChip, the
 * permission ladder and the gated logout are his as well. Asserted here
 * against rep-shaped deps, so a later role-specialisation cannot silently
 * break the rep:
 *
 * - name, role, `TrackingHealthChip`, permission ladder, pending count.
 * - **The logout gate**: blocked while anything is queued, with the
 *   count and *Retry now*; open at zero.
 * - **Not on this screen**: no commission, no targets, no comparison
 *   with the other rep.
 */
import { describe, expect, it, vi } from 'vitest';

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

function deps(overrides: { pendingSyncCount?: number } = {}) {
  return {
    username: 'anitha.r',
    role: 'Sales rep',
    appVersion: '1.2.0',
    deviceModel: 'Pixel 7',
    loadHealth: vi.fn(async () => health({})),
    loadLadderRows: vi.fn(async () => LADDER),
    pendingSyncCount: overrides.pendingSyncCount ?? 0,
    retrySync: vi.fn(),
    logout: vi.fn(),
    openLadder: vi.fn(),
    changePassword: vi.fn(),
    subscribeForeground: () => () => {},
  };
}

describe('RepProfile — §S7 via the shared screen', () => {
  it('renders name, Sales rep role, the tracking chip and the permission ladder', async () => {
    const r = await create(<ProfileScreen {...deps()} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'profile-name')).toBeDefined();
    expect(allText(findByTestID(tree, 'profile-name')!)).toContain(NAME);
    expect(allText(findByTestID(tree, 'profile-role')!).join(' | ')).toContain('Sales rep');
    // Reps are tracked too — the chip is present and prominent.
    expect(findByTestID(tree, 'profile-health-chip')).toBeDefined();
    expect(findByTestID(tree, 'tracking-chip')).toBeDefined();
    for (const step of [1, 2, 3, 4]) {
      expect(findByTestID(tree, `profile-ladder-row-${step}`)).toBeDefined();
    }
    expect(findByTestID(tree, 'profile-pending-sync')).toBeDefined();
  });

  it('the logout gate blocks while anything is queued, and opens at zero', async () => {
    const blocked = await create(<ProfileScreen {...deps({ pendingSyncCount: 2 })} />);
    let tree = toJson(blocked);
    expect(findByTestID(tree, 'profile-logout-gate')).toBeDefined();
    const logout = findAll(findByTestID(tree, 'profile-logout')!, (n) => n.type === 'Pressable')[0]!;
    expect(logout.props.accessibilityState).toMatchObject({ disabled: true });
    expect(findByTestID(tree, 'profile-retry-sync')).toBeDefined();
    expect(allText(tree)).toContain('2 items not yet synced');

    const clear = await create(<ProfileScreen {...deps({ pendingSyncCount: 0 })} />);
    tree = toJson(clear);
    expect(findByTestID(tree, 'profile-logout-gate')).toBeUndefined();
    const openLogout = findAll(findByTestID(tree, 'profile-logout')!, (n) => n.type === 'Pressable')[0]!;
    expect(openLogout.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('no commission, no targets, no comparison with the other rep — at any depth', async () => {
    const r = await create(<ProfileScreen {...deps({ pendingSyncCount: 1 })} />);
    const rendered = JSON.stringify(toJson(r)).toLowerCase();
    expect(rendered).not.toContain('commission');
    expect(rendered).not.toContain('target');
    expect(rendered).not.toContain('leaderboard');
    expect(rendered).not.toContain('ranking');
    expect(rendered).not.toContain('vs the other');
  });
});
