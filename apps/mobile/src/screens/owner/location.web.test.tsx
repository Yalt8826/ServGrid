/**
 * O3 Location console tests (T4.10, docs/implementation/PHASE-4-OWNER.md
 * T4.10). The spec names four:
 *
 * 1. Roster sorts by severity: `permission_missing` above `stale`
 *    above `active` — NOT alphabetically; the person with a problem is
 *    at the top, and the fixture below is arranged so that alphabetical
 *    order and severity order disagree (Anitha is active and would be
 *    first alphabetically).
 * 2. The expired state renders the reason, and no spinner exists
 *    anywhere in the tree — walked for `ActivityIndicator`, for the
 *    Button loading bar, for anything claiming the screen is "loading":
 *    the whole point of persisting the request is to be able to say it
 *    is NOT coming.
 * 3. The live pulse stops when the screen blurs — the animation is
 *    cancelled on focus false (the `useIsFocused` question; the route
 *    derives it from expo-router's `useFocusEffect` and hands the
 *    screen `pulseActive`).
 * 4. Phone layout renders the roster and NO map component at all —
 *    through the same import the screen uses, which under vitest (and
 *    on native) resolves to the inert stub, so neither the test graph
 *    nor the APK ever pulls `maplibre-gl`.
 *
 * The seam is the house one: react-test-renderer against the string
 * host stubs, the real component logic, deps injected.
 */
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { Text, View } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
import { LocationConsoleScreen, type LocationConsoleDeps } from './location';
import { LocationMap } from './locationMap';
import { useLivePulse } from './livePulse';
import {
  requestViewOf,
  trailStops as labelTrailStops,
  whyNoAnswer,
  type LocateRequest,
  type RosterRow,
  type TrailPoint,
} from './locationModel';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';

const NOW = Date.UTC(2026, 8, 15, 10, 0, 0); // 2026-09-15T10:00:00Z — 15:30 IST

function row(partial: Partial<RosterRow> & { employeeId: string; employeeName: string }): RosterRow {
  return {
    role: 'technician',
    locationPermission: 'background',
    notificationsEnabled: true,
    health: 'active',
    lastPingAt: null,
    minutesSince: 6,
    position: { latitude: 12.97, longitude: 77.59, recordedAt: '2026-09-15T09:54:00.000Z', accuracyM: 12, batteryPct: 80, source: 'scheduled' },
    ...partial,
  };
}

/** §O3's anatomy, with alphabetical order deliberately contradicting
 * severity order: Anitha would sort first by name and is the healthiest. */
const ROSTER: RosterRow[] = [
  row({ employeeId: 'e-Active', employeeName: 'Anitha Prasad', health: 'active', minutesSince: 6 }),
  row({
    employeeId: 'e-Stale',
    employeeName: 'Suresh Naik',
    health: 'stale',
    minutesSince: 122,
    locationPermission: 'background',
  }),
  row({
    employeeId: 'e-NoPermit',
    employeeName: 'Ravi Kumar',
    health: 'permission_missing',
    minutesSince: null,
    lastPingAt: null,
    position: null,
    locationPermission: 'none',
  }),
];

function deps(partial: Partial<LocationConsoleDeps>): LocationConsoleDeps {
  return {
    now: NOW,
    desk: true,
    flagOn: true,
    rows: ROSTER,
    error: null,
    actionError: null,
    selectedEmployeeId: null,
    onSelectEmployee: () => {},
    trailStops: null,
    trailCount: 0,
    trailLoading: false,
    request: null,
    requestBusy: false,
    pulseActive: false,
    onLocateNow: () => {},
    onLive: () => {},
    onRetry: () => {},
    ...partial,
  };
}

async function mount(d: LocationConsoleDeps) {
  let renderer!: Awaited<ReturnType<typeof create>>;
  await act(async () => {
    renderer = await create(<LocationConsoleScreen {...d} />);
  });
  return renderer;
}

function rosterOrder(renderer: Awaited<ReturnType<typeof create>>): string[] {
  return findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('location-row-')).map(
    (n) => String(n.props.testID),
  );
}

function joinedText(renderer: Awaited<ReturnType<typeof create>>): string {
  return allText(toJson(renderer)).join('\n');
}

/* ─────────────────────────── 1. severity sort ─────────────────────────── */

describe('roster sorts by health severity, not alphabetically', () => {
  it('permission_missing above stale above active, even when alphabetical order disagrees', async () => {
    const renderer = await mount(deps({ desk: true }));
    expect(rosterOrder(renderer)).toEqual(['location-row-e-NoPermit', 'location-row-e-Stale', 'location-row-e-Active']);
  });

  it('the phone roster reads the same order — the part that survives descoping', async () => {
    const renderer = await mount(deps({ desk: false }));
    expect(rosterOrder(renderer)).toEqual(['location-row-e-NoPermit', 'location-row-e-Stale', 'location-row-e-Active']);
  });

  it('within one severity, the longer-unseen row sorts first; the health word rides the colour', async () => {
    const two: RosterRow[] = [
      row({ employeeId: 'a', employeeName: 'Zoya', health: 'stale', minutesSince: 55 }),
      row({ employeeId: 'b', employeeName: 'Amit', health: 'stale', minutesSince: 300 }),
    ];
    const renderer = await mount(deps({ rows: two }));
    expect(rosterOrder(renderer)).toEqual(['location-row-b', 'location-row-a']);
    const text = joinedText(renderer);
    expect(text).toContain('Stale');
    expect(text).toContain('5h ago'); // Amit — 300 minutes, the worse wait, first
    expect(text).toContain('55 min ago');
  });

  it('the header sorts are real: name sorts alphabetically, and back to severity', async () => {
    const renderer = await mount(deps({ desk: true }));
    const press = async (testID: string): Promise<void> => {
      const node = findByTestID(toJson(renderer), testID);
      await act(async () => {
        (node?.props.onPress as () => void)();
      });
    };
    await press('roster-sort-name');
    expect(rosterOrder(renderer)).toEqual(['location-row-e-Active', 'location-row-e-NoPermit', 'location-row-e-Stale']);
    await press('roster-sort-name'); // toggle desc
    expect(rosterOrder(renderer)).toEqual(['location-row-e-Stale', 'location-row-e-NoPermit', 'location-row-e-Active']);
    await press('roster-sort-health'); // severity again, worst first
    expect(rosterOrder(renderer)).toEqual(['location-row-e-NoPermit', 'location-row-e-Stale', 'location-row-e-Active']);
  });
});

/* ──────────────── 2. expired renders the reason; no spinner ───────────── */

function openRequest(partial: Partial<LocateRequest>): LocateRequest {
  return {
    id: 'req-1',
    targetEmployeeId: 'e-Stale',
    mode: 'fix',
    status: 'pushed',
    requestedAt: new Date(NOW - 42_000).toISOString(),
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    failureReason: null,
    fulfilledAt: null,
    ...partial,
  };
}

/** No spinner means none, under any name this product could give one. */
function assertNoSpinner(renderer: Awaited<ReturnType<typeof create>>): void {
  const tree = toJson(renderer);
  expect(findAll(tree, (n) => n.type === 'ActivityIndicator')).toEqual([]);
  expect(findAll(tree, (n) => typeof n.props.testID === 'string' && n.props.testID.includes('loading'))).toEqual([]);
  const busy = findAll(tree, (n) => {
    const state = n.props.accessibilityState as { busy?: boolean } | undefined;
    return state?.busy === true;
  });
  expect(busy).toEqual([]);
}

describe('the expired state renders the reason, and no spinner exists anywhere in the tree', () => {
  const expired: LocateRequest = {
    id: 'req-x',
    targetEmployeeId: 'e-Stale',
    mode: 'fix',
    status: 'expired',
    requestedAt: new Date(NOW - 2 * 60_000).toISOString(),
    expiresAt: new Date(NOW - 30_000).toISOString(),
    failureReason: null,
    fulfilledAt: null,
  };

  it('renders "Requested 2 min ago — device has not answered" with the why beside it', async () => {
    const renderer = await mount(deps({ selectedEmployeeId: 'e-Stale', request: expired }));
    const text = joinedText(renderer);
    expect(text).toContain('Requested 2 min ago — device has not answered');
    // The why: Suresh HAS background permission but his ping is 2h old —
    // so the reason is the stale ping, not the permission.
    const why = findByTestID(toJson(renderer), 'locate-why');
    expect(why).toBeTruthy();
    expect(allText(why ?? null).join(' ')).toContain('No recent ping');
  });

  it('picks permission missing when the permission is actually gone', () => {
    const ravi = ROSTER.find((r) => r.employeeId === 'e-NoPermit') ?? null;
    expect(
      whyNoAnswer(ravi, { ...expired, targetEmployeeId: 'e-NoPermit' }),
    ).toBe('permission missing');
    // And a recorded push failure is stated as one, ahead of guesses.
    expect(whyNoAnswer(ravi, { ...expired, failureReason: 'no_pushable_device' })).toBe('push failed');
  });

  it('no spinner exists in the tree — expired, on desk and on phone alike', async () => {
    assertNoSpinner(await mount(deps({ selectedEmployeeId: 'e-Stale', request: expired })));
    assertNoSpinner(await mount(deps({ desk: false, selectedEmployeeId: 'e-Stale', request: expired })));
    assertNoSpinner(await mount(deps({ desk: false })));
  });

  it('the open window counts seconds in words and still shows no spinner', async () => {
    const renderer = await mount(
      deps({ selectedEmployeeId: 'e-Stale', request: openRequest({ status: 'pushed' }) }),
    );
    expect(joinedText(renderer)).toContain('Requested — waiting for the device · 42s');
    assertNoSpinner(renderer);
    // Waiting does not disable thinking: buttons hold, reason shown.
    const now42: LocateRequest = openRequest({ status: 'requested' });
    const view = requestViewOf(now42, ROSTER[1] ?? null, NOW);
    expect(view).toEqual({ kind: 'sent', seconds: 42 });
  });

  it('a new second moves the count — derived from the injected clock, never a timer of its own', () => {
    const req = openRequest({ status: 'pushed' });
    expect(requestViewOf(req, null, NOW)).toMatchObject({ kind: 'sent', seconds: 42 });
    expect(requestViewOf(req, null, NOW + 4_000)).toMatchObject({ kind: 'sent', seconds: 46 });
    // The instant the deadline passes the read says so — no waiting for
    // a sweep to write it first.
    expect(requestViewOf(req, null, NOW + 6 * 60_000)).toMatchObject({ kind: 'closed' });
  });
});

/* ────────────────────── 3. the pulse stops on blur ────────────────────── */

/** Exposes the hook's `running` — the honest answer to "is the dot
 * pulsing right now" — as a node the test can find. */
function PulseProbe({ enabled }: { enabled: boolean }): React.ReactNode {
  const pulse = useLivePulse(enabled);
  return (
    <View>
      <Text testID={pulse.running ? 'pulse-running' : 'pulse-stopped'}>{pulse.running ? 'running' : 'stopped'}</Text>
    </View>
  );
}

describe('the live pulse stops when the screen blurs', () => {
  it('the hook cancels on enabled false — armed on focus, disarmed on blur', async () => {
    let renderer!: Awaited<ReturnType<typeof create>>;
    await act(async () => {
      renderer = await create(<PulseProbe enabled />);
    });
    expect(findByTestID(toJson(renderer), 'pulse-running')).toBeTruthy();
    expect(findByTestID(toJson(renderer), 'pulse-stopped')).toBeUndefined();

    await act(async () => {
      renderer.update(<PulseProbe enabled={false} />);
    });
    expect(findByTestID(toJson(renderer), 'pulse-stopped')).toBeTruthy();
    expect(findByTestID(toJson(renderer), 'pulse-running')).toBeUndefined();
  });

  it('the selected dot carries the pulse only while focused, and drops it on blur', async () => {
    const renderer = await mount(deps({ selectedEmployeeId: 'e-Stale', pulseActive: true }));
    expect(findByTestID(toJson(renderer), 'location-dot-pulse')).toBeTruthy();
    // Only the SELECTED row pulses — one dot, the bounded exception.
    expect(findAll(toJson(renderer), (n) => n.props.testID === 'location-dot-pulse')).toHaveLength(1);

    await act(async () => {
      renderer.update(<LocationConsoleScreen {...deps({ selectedEmployeeId: 'e-Stale', pulseActive: false })} />);
    });
    expect(findByTestID(toJson(renderer), 'location-dot-pulse')).toBeUndefined();
  });

  it('an unselected roster carries no pulse at all', async () => {
    const renderer = await mount(deps({ pulseActive: true }));
    expect(findByTestID(toJson(renderer), 'location-dot-pulse')).toBeUndefined();
  });
});

/* ─────────── 4. phone layout: roster only, no map component at all ─────────── */

describe('phone layout renders the roster and no map component at all', () => {
  it('roster rows render; no map testID exists in the tree; the actions survive', async () => {
    const renderer = await mount(
      deps({
        desk: false,
        selectedEmployeeId: 'e-Stale',
        request: expiredRequest(),
        trailStops: labelTrailStops(trailFixture()),
        pulseActive: true,
      }),
    );
    const tree = toJson(renderer);
    expect(joinedText(renderer)).toContain('Anitha Prasad');
    expect(rosterOrder(renderer)).toHaveLength(3);
    expect(findByTestID(tree, 'location-map')).toBeUndefined();
    expect(findByTestID(tree, 'map-pane')).toBeUndefined();
    expect(findByTestID(tree, 'location-map-unconfigured')).toBeUndefined();
    expect(findByTestID(tree, 'locate-now')).toBeTruthy();
    // No sort chrome on phone — the roster is already worst-first.
    expect(findByTestID(tree, 'roster-sort-header')).toBeUndefined();
  });

  it('the map module the screen imports is the inert stub on this platform', async () => {
    // `./locationMap` resolves HERE (and on native) to the stub; the
    // stub renders null, so neither the test graph nor the APK can
    // reach maplibre-gl through it.
    let stub!: Awaited<ReturnType<typeof create>>;
    await act(async () => {
      stub = await create(
        <LocationMap rows={ROSTER} selectedEmployeeId="e-Stale" trailStops={labelTrailStops(trailFixture())} pulseActive />,
      );
    });
    expect(toJson(stub)).toBeNull();
  });
});

/* ────────────────── the trail: labels at direction changes ────────────────── */

function trailFixture(): TrailPoint[] {
  return [
    { recordedAt: '2026-09-15T04:00:00.000Z', latitude: 12.97, longitude: 77.59, source: 'scheduled' },
    { recordedAt: '2026-09-15T05:00:00.000Z', latitude: 12.98, longitude: 77.59, source: 'scheduled' }, // straight on
    { recordedAt: '2026-09-15T06:00:00.000Z', latitude: 12.99, longitude: 77.59, source: 'scheduled' },
    { recordedAt: '2026-09-15T07:00:00.000Z', latitude: 12.99, longitude: 77.6, source: 'scheduled' }, // the turn
    { recordedAt: '2026-09-15T08:00:00.000Z', latitude: 12.99, longitude: 77.61, source: 'scheduled' },
  ];
}

describe('the day trail labels direction changes, not every point', () => {
  it('a straight corridor labels only its ends; the turn gets its label; IST clock', () => {
    const stops = labelTrailStops(trailFixture());
    expect(stops).toHaveLength(3); // start · the corner (06:00Z = 11:30 IST) · end
    expect(stops.map((s) => s.label)).toEqual(['09:30', '11:30', '13:30']);
  });

  it('an empty trail yields no stops; a single fix labels itself once', () => {
    expect(labelTrailStops([])).toEqual([]);
    expect(labelTrailStops(trailFixture().slice(0, 1))).toHaveLength(1);
  });
});

/* ──────────────────── the actions: disabled states say why ─────────────────── */

function expiredRequest(): LocateRequest {
  return {
    id: 'req-x',
    targetEmployeeId: 'e-Stale',
    mode: 'fix',
    status: 'expired',
    requestedAt: new Date(NOW - 2 * 60_000).toISOString(),
    expiresAt: new Date(NOW - 30_000).toISOString(),
    failureReason: null,
    fulfilledAt: null,
  };
}

describe('the locate-now actions', () => {
  /** Button's testID rides the outer View; the Pressable inside carries
   * the accessibilityState the assertions read. */
  function disabledOf(tree: ReturnType<typeof toJson>, testID: string): boolean | undefined {
    const button = findByTestID(tree, testID);
    const pressable = button !== undefined ? findAll(button, (n) => n.props.accessibilityState !== undefined)[0] : undefined;
    return (pressable?.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled;
  }

  it('are disabled until a technician is selected, with the why as a caption', async () => {
    const renderer = await mount(deps({}));
    expect(disabledOf(toJson(renderer), 'locate-now')).toBe(true);
    expect(joinedText(renderer)).toContain('Select a technician first.');
  });

  it('hold while a request is open, so requests do not stack', async () => {
    const renderer = await mount(
      deps({ selectedEmployeeId: 'e-Stale', request: openRequest({ status: 'pushed' }) }),
    );
    expect(disabledOf(toJson(renderer), 'locate-now')).toBe(true);
    expect(joinedText(renderer)).toContain('A request is already open');
  });

  it('reopen after a terminal state — an expired request is not a locked screen', async () => {
    const renderer = await mount(deps({ selectedEmployeeId: 'e-Stale', request: expiredRequest() }));
    expect(disabledOf(toJson(renderer), 'locate-now')).toBe(false);
  });

  it('fulfilment is stated as success in the feedback colour', async () => {
    const renderer = await mount(
      deps({
        selectedEmployeeId: 'e-Stale',
        request: openRequest({ status: 'fulfilled', fulfilledAt: new Date(NOW - 1_000).toISOString() }),
      }),
    );
    expect(joinedText(renderer)).toContain('Located — the device answered.');
    const status = findByTestID(toJson(renderer), 'locate-status');
    const text = (status !== undefined ? findAll(status, (n) => n.type === 'Text')[0] : undefined) ?? null;
    expect(text).toBeTruthy();
    const style = text?.props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
    expect((flat as Record<string, string>).color).toBe(SEMANTIC.feedback.success);
  });
});
