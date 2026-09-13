/**
 * D6 Profile tests (T2.10, UI/plan-2/05-DISPATCHER.md §D6) — the two
 * the spec names:
 *
 * - **No `PendingBadge`, no `TrackingHealthChip` in the tree** — the
 *   dispatcher holds no device state and is not tracked; a sync or
 *   tracking element would imply an offline capability he does not
 *   have. Proven three ways: the component types appear nowhere in the
 *   rendered instances, the words appear nowhere in the text, and the
 *   screen's module imports neither (the import list is the first
 *   gate).
 * - **Logout requires no confirmation and clears the session
 *   immediately** — one tap, the handler fires in the same beat, no
 *   dialog exists on this screen. There is nothing queued to lose.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { act } from 'react';
import { fileURLToPath } from 'node:url';
import type { ReactTestRenderer } from 'react-test-renderer';

import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { PendingBadge } from '../../components/domain/PendingBadge';
import { TrackingHealthChip } from '../../components/domain/TrackingHealthChip';
import { DispatcherProfileScreen, type DispatcherProfileDeps } from './profile';
import { useSessionStore } from '../../state/sessionStore';

// ── fixtures ─────────────────────────────────────────────────────────────

function baseDeps(overrides: Partial<DispatcherProfileDeps> = {}): DispatcherProfileDeps {
  return {
    fullName: 'Priya Nair',
    username: 'priya.n',
    appVersion: '1.2.0',
    changePassword: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

function textOf(renderer: ReactTestRenderer, testID: string): string {
  const node = findByTestID(toJson(renderer), testID);
  expect(node).toBeDefined();
  return allText(node!).join(' ');
}

// ── the tests ────────────────────────────────────────────────────────────

describe('DispatcherProfileScreen (§D6)', () => {
  it('no PendingBadge and no TrackingHealthChip in the tree — no sync state, no tracking UI', async () => {
    const renderer = await create(<DispatcherProfileScreen {...baseDeps()} />);
    const tree = toJson(renderer);

    // The component types appear nowhere among the rendered instances —
    // react-test-renderer keeps composite components in the instance tree
    // even though the host stubs render them to plain Views.
    const offenders = renderer.root.findAll(
      (instance) => instance.type === PendingBadge || instance.type === TrackingHealthChip,
    );
    expect(offenders).toHaveLength(0);

    // Nor their words in any form: no pending count, no sync state, no
    // tracking health — the capability the dispatcher does not have must
    // not even be implied.
    const text = allText(tree).join(' | ').toLowerCase();
    expect(text).not.toContain('pending');
    expect(text).not.toContain('sync');
    expect(text).not.toContain('tracking');
    expect(findByTestID(tree, 'profile-health-chip')).toBeUndefined();
    expect(findByTestID(tree, 'profile-pending-sync')).toBeUndefined();

    // And the module itself never imports them — the strongest form of
    // the absence: `profile.tsx` has no import edge to `PendingBadge` or
    // `TrackingHealthChip`, so no future refactor can quietly put them
    // back on this screen. (The doc comment naming them is the SPEC, and
    // stays; only the import list is the gate.)
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(fileURLToPath(new URL('./profile.tsx', import.meta.url).href), 'utf8'),
    );
    const importLines = source.split('\n').filter((line) => line.trimStart().startsWith('import '));
    expect(importLines.length).toBeGreaterThan(0);
    expect(importLines.join('\n')).not.toContain('PendingBadge');
    expect(importLines.join('\n')).not.toContain('TrackingHealthChip');
  });

  it('renders self only: name, username, app version, change password', async () => {
    const deps = baseDeps();
    const renderer = await create(<DispatcherProfileScreen {...deps} />);

    expect(textOf(renderer, 'dispatcher-profile-name')).toBe('Priya Nair');
    expect(textOf(renderer, 'dispatcher-profile-username')).toBe('Dispatcher · priya.n');
    expect(textOf(renderer, 'dispatcher-profile-app-version')).toContain('1.2.0');

    await act(async () => {
      const button = findByTestID(toJson(renderer), 'dispatcher-profile-change-password')!;
      const pressable =
        typeof button.props.onPress === 'function' ? button : findAll(button, (n) => typeof n.props.onPress === 'function')[0]!;
      pressable.props.onPress?.();
    });
    expect(deps.changePassword).toHaveBeenCalledTimes(1);
  });

  it('logout requires no confirmation and clears the session immediately', async () => {
    // The route's actual session end, behind the seam: the same
    // setAnonymous call the technician's route makes after its gate —
    // here with no gate in front of it.
    useSessionStore.getState().setAuthenticated({
      id: '01890a5e-9000-7000-8000-00000000d001',
      role: 'dispatcher',
      username: 'priya.n',
    });
    expect(useSessionStore.getState().status).toBe('authenticated');

    const logout = vi.fn(() => {
      useSessionStore.getState().setAnonymous();
    });
    const renderer = await create(<DispatcherProfileScreen {...baseDeps({ logout })} />);

    // No confirm-and-lose path exists to even decline: no dialog, no
    // confirmation sentence, nothing between the tap and the end.
    const tree = toJson(renderer);
    const text = allText(tree).join(' | ').toLowerCase();
    expect(text).not.toContain('are you sure');
    expect(text).not.toContain('confirm');
    expect(text).not.toContain('discard');

    // One tap. The handler fires in the same beat as the press — no
    // intermediate state, nothing queued to lose — and the session is
    // already anonymous when the handler returns.
    await act(async () => {
      const button = findByTestID(toJson(renderer), 'dispatcher-profile-logout')!;
      const pressable =
        typeof button.props.onPress === 'function' ? button : findAll(button, (n) => typeof n.props.onPress === 'function')[0]!;
      pressable.props.onPress?.();
    });
    expect(logout).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(useSessionStore.getState().actor).toBeNull();
  });

  it('no logout gate exists to open — the deps carry no pending count', async () => {
    // Type-level proof, asserted at runtime: the seam has no
    // pendingSyncCount, no retrySync — the gate the technician's profile
    // needs is not merely open here, it does not exist.
    const deps = baseDeps();
    expect('pendingSyncCount' in deps).toBe(false);
    expect('retrySync' in deps).toBe(false);
    const renderer = await create(<DispatcherProfileScreen {...deps} />);
    expect(findByTestID(toJson(renderer), 'profile-logout-gate')).toBeUndefined();
    expect(findByTestID(toJson(renderer), 'profile-retry-sync')).toBeUndefined();
  });
});

// The session store is module-global; leave it as each test found it.
let snapshot: ReturnType<typeof useSessionStore.getState> | undefined;
beforeEach(() => {
  snapshot = useSessionStore.getState();
});
afterEach(() => {
  useSessionStore.setState(snapshot!, true);
});
