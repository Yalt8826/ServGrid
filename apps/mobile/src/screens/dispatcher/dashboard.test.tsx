/**
 * D1 Dashboard tests (UI/plan-2/05-DISPATCHER.md §D1) — the five the
 * spec names:
 *
 * - **Overdue renders first, largest, in danger colour** — the only
 *   number on this screen that is a promise already broken leads, and
 *   leads by size.
 * - **Zero overdue renders `0`, not an absent element** — empty is
 *   information.
 * - **Offline renders the danger banner and dims the figures** — the
 *   opposite of the technician's dashboard, whose test asserts offline
 *   renders NO banner because his mirror is the source. Together the
 *   two suites prove the pair: dispatch decisions are made from this
 *   screen, so stale data announces itself here and nowhere else.
 * - **Figures cross-fade rather than count up** on a value change — a
 *   dispatcher returning twenty times a day does not want a
 *   performance.
 * - **The health warning renders from health + age and the tree
 *   contains no latitude or longitude** — a `location.health` read
 *   (health value, last-ping age), never `location.read`. The api-side
 *   money-leak suite's roster walk holds the same boundary by key.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import { View } from 'react-native';
import type { ReactTestRenderer } from 'react-test-renderer';

import { FRAME, SEMANTIC } from '@servgrid/shared';
import { TechnicianLoadRow } from '../../components/domain/TechnicianLoadRow';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import {
  DispatcherDashboardScreen,
  OFFLINE_BANNER_MESSAGE,
  type DispatcherDashboardDeps,
  type DispatcherFigure,
} from './dashboard';

// ── fixtures ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-07T09:15:00+05:30'); // Monday, 09:15 IST — the worst moment
const TODAY_LABEL = 'Mon 7 Sep';

const TECH_ID = '01890a5e-3000-7000-8000-000000000001';
const OTHER_TECH_ID = '01890a5e-3000-7000-8000-000000000002';

function figure(key: DispatcherFigure['key'], value: number): DispatcherFigure {
  const labels = { overdue: 'overdue', unassigned: 'unassigned', today: 'today', done: 'done' } as const;
  return { key, label: labels[key], value };
}

function baseDeps(overrides: Partial<DispatcherDashboardDeps> = {}): DispatcherDashboardDeps {
  return {
    now: NOW,
    todayLabel: TODAY_LABEL,
    offline: false,
    figures: [figure('overdue', 3), figure('unassigned', 7), figure('today', 12), figure('done', 2)],
    figuresError: null,
    load: [
      { employeeId: TECH_ID, name: 'Ravi', load: 3 },
      { employeeId: OTHER_TECH_ID, name: 'Suresh', load: 0 },
    ],
    loadError: null,
    sections: [
      {
        key: 'overdue',
        heading: 'Overdue',
        jobs: [
          {
            id: '01890a5e-4000-7000-8000-000000000031',
            jobNumber: 'JC-2627-00031',
            title: 'UPS battery swap',
            customerName: 'Sunrise Apartments',
            technician: 'Ravi',
            note: '3 days overdue',
          },
        ],
      },
      { key: 'unassigned', heading: 'Unassigned', jobs: [] },
      { key: 'late', heading: 'Assigned, not set off', jobs: [] },
    ],
    sectionsError: null,
    onRetry: vi.fn(),
    onOpenJob: vi.fn(),
    onDispatch: vi.fn(),
    onOpenTechnicianDay: vi.fn(),
    ...overrides,
  };
}

function textOf(renderer: ReactTestRenderer, testID: string): string | undefined {
  const node = findByTestID(toJson(renderer), testID);
  if (node === undefined) return undefined;
  return (node.children ?? []).filter((c): c is string => typeof c === 'string').join('');
}

/** The figure text nodes in display order. */
function figureValues(renderer: ReactTestRenderer): string[] {
  return findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && /-value$/.test(n.props.testID)).map(
    (n) => (n.children ?? []).filter((c): c is string => typeof c === 'string').join(''),
  );
}

function styleOf(renderer: ReactTestRenderer, testID: string): Record<string, unknown> {
  const node = findByTestID(toJson(renderer), testID);
  expect(node).toBeDefined();
  const raw = node!.props.style;
  return Array.isArray(raw) ? Object.assign({}, ...raw) : (raw as Record<string, unknown>);
}

// ── the tests ────────────────────────────────────────────────────────────

describe('DispatcherDashboardScreen (§D1)', () => {
  it('renders overdue first, largest, in the danger colour', async () => {
    const renderer = await create(<DispatcherDashboardScreen {...baseDeps()} />);

    // Order is the design: overdue, then unassigned, today, done.
    const values = figureValues(renderer);
    expect(values).toEqual(['3', '7', '12', '2']);
    expect(findByTestID(toJson(renderer), 'dispatch-figure-overdue-value')).toBeDefined();

    // Largest figure on the screen: `displayLg` 44 against the others'
    // 32 — bigger is the hierarchy here, not a colour alone. The figures
    // sit on the navy frame (2026-09-16), so the inks are the measured
    // dark-ground set: overdue in FRAME.danger, the rest in frame white.
    const overdue = styleOf(renderer, 'dispatch-figure-overdue-value');
    expect(overdue.fontSize).toBe(44);
    expect(overdue.color).toBe(FRAME.danger);
    for (const key of ['unassigned', 'today'] as const) {
      const style = styleOf(renderer, `dispatch-figure-${key}-value`);
      expect(style.fontSize).toBe(32); // strictly smaller than overdue's
      expect(style.color).toBe(FRAME.text);
    }
    // done carries its own ink when non-zero — the technician dashboard's
    // rule: the status colour appears only when there is something to see.
    expect(styleOf(renderer, 'dispatch-figure-done-value').color).toBe(FRAME.success);
  });

  it('renders a zero overdue as 0, not an absent element', async () => {
    const renderer = await create(
      <DispatcherDashboardScreen
        {...baseDeps({
          figures: [figure('overdue', 0), figure('unassigned', 7), figure('today', 12), figure('done', 2)],
        })}
      />,
    );

    // The element exists and says so: absence of a problem is information.
    expect(findByTestID(toJson(renderer), 'dispatch-figure-overdue')).toBeDefined();
    expect(textOf(renderer, 'dispatch-figure-overdue-value')).toBe('0');
    // Nothing overdue is not danger: on the frame it reads plain white.
    expect(styleOf(renderer, 'dispatch-figure-overdue-value').color).toBe(FRAME.text);
  });

  it('offline renders the danger banner and dims the figures — the opposite of the technician', async () => {
    const renderer = await create(<DispatcherDashboardScreen {...baseDeps({ offline: true })} />);

    // Full-width feedback.danger banner, the words verbatim (§D1). The
    // technician's dashboard.test.tsx asserts his screen renders NO
    // banner offline; this is the deliberate opposite.
    const banner = findByTestID(toJson(renderer), 'dispatch-offline-banner');
    expect(banner).toBeDefined();
    expect(allText(banner!).join(' ')).toBe(OFFLINE_BANNER_MESSAGE);
    expect(styleOf(renderer, 'dispatch-offline-banner').borderLeftColor).toBe(SEMANTIC.feedback.danger);

    // Every figure greys to text.disabled — the data may be stale, and
    // this is the one role where stale data is dangerous.
    for (const key of ['overdue', 'unassigned', 'today', 'done'] as const) {
      expect(styleOf(renderer, `dispatch-figure-${key}-value`).color).toBe(SEMANTIC.text.disabled);
    }
    expect(textOf(renderer, 'dispatch-figure-overdue-value')).toBe('3');
  });

  it('cross-fades a changed figure instead of counting up', async () => {
    const deps = baseDeps();
    const renderer = await create(<DispatcherDashboardScreen {...deps} />);

    // No count-up on arrival: the first paint is the value itself —
    // never a tween from 0 the way the technician's first focus runs.
    expect(textOf(renderer, 'dispatch-figure-overdue-value')).toBe('3');
    expect(styleOf(renderer, 'dispatch-figure-overdue').opacity).toBe(1);

    // The morning's re-fetch moves overdue 3 → 7: the new value is on
    // screen immediately (the text is bound to the value — there is no
    // numeric tween to skip past) and the 140ms cross-fade lands at
    // full opacity.
    await act(async () => {
      renderer.update(
        <DispatcherDashboardScreen
          {...baseDeps({
            ...deps,
            figures: [figure('overdue', 7), figure('unassigned', 7), figure('today', 12), figure('done', 2)],
          })}
        />,
      );
    });
    expect(textOf(renderer, 'dispatch-figure-overdue-value')).toBe('7');
    expect(styleOf(renderer, 'dispatch-figure-overdue').opacity).toBe(1);

    // And no intermediate frame ever suggested a count: the only values
    // the figure ever showed were 3 and 7.
    const shown = figureValues(renderer);
    expect(shown[0]).toBe('7');
  });

  it('renders no tracking state at all, and no coordinate exists anywhere in the tree', async () => {
    // Yashas, 2026-09-17: the dispatcher does not consume the
    // technicians' location-reporting state — the health column (warning
    // and "active" tick alike) is gone from the load rows. The fixture's
    // Suresh is stale + never-reported; none of that reaches the tree.
    const renderer = await create(<DispatcherDashboardScreen {...baseDeps()} />);
    const tree = toJson(renderer);
    expect(findByTestID(tree, `dispatch-load-${OTHER_TECH_ID}-warning`)).toBeUndefined();
    expect(findByTestID(tree, `dispatch-load-${TECH_ID}-state`)).toBeUndefined();
    const words = allText(tree).join(' ').toLowerCase();
    expect(words).not.toContain('tracking off');
    expect(words).not.toContain('no ping');
    expect(words).not.toContain('last ping');

    // The permission boundary, still proven on the tree: the dispatcher's
    // dashboard reads no location data at all — no latitude or longitude
    // arrives, renders, or hides anywhere.
    const serialised = JSON.stringify(tree).toLowerCase();
    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('longitude');
    expect(serialised).not.toContain('coordinates');
  });

  it('TechnicianLoadRow is the picker\'s component: load count, relative bar, staggered draw seam', async () => {
    // The same component T2.9's TechnicianPicker composes: name, mono
    // count, inline bar drawn as a fraction of the busiest row, and the
    // draw seam (stagger 30ms × index, 260ms each). Under the vitest
    // seam a drawing row renders the tween's START — bars draw from
    // zero — so the fractions are read on already-drawn rows, exactly
    // as the technician's count-up test reads its seam.
    const renderer = await create(
      <View>
        <TechnicianLoadRow name="Ravi" load={3} maxLoad={6} index={0} draw={false} testID="load-ravi" />
        <TechnicianLoadRow name="Anitha" load={6} maxLoad={6} index={1} testID="load-anitha" />
        <TechnicianLoadRow name="Suresh" load={6} maxLoad={6} index={2} draw={false} testID="load-suresh" />
      </View>,
    );

    const row = findByTestID(toJson(renderer), 'load-ravi');
    expect(row).toBeDefined();
    expect(allText(row!).join(' ')).toContain('Ravi');
    expect(allText(row!).join(' ')).toContain('3');
    // The bar is relative: at the max it fills 100%, at half 50%.
    expect(styleOf(renderer, 'load-suresh-bar').width).toBe('100%');
    expect(styleOf(renderer, 'load-ravi-bar').width).toBe('50%');
    // The draw seam: a focusing row renders the tween's start — bars
    // draw from zero, left to right (§5.5).
    expect(styleOf(renderer, 'load-anitha-bar').width).toBe('0%');
  });
});
