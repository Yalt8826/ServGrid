/**
 * NavShell desk-branch render tests (T4.7, UI/plan-2/07-OWNER.md "The
 * desktop rail"). The source-level invariants — one Platform.OS, one
 * DensityProvider — live in `NavShell.test.tsx`; this file RENDERS the
 * shell the way Metro's web build runs it: `Platform.OS === 'web'` with
 * a controlled viewport, the owner session from the real session store.
 *
 * What is asserted (07-OWNER.md, verbatim requirements):
 * - at ≥1024px the rail renders the owner's five sections — expanded to
 *   their individual routes, in the phone's group order — and the phone
 *   tab bar is gone;
 * - below the breakpoint the SAME session gets the tab bar: one route
 *   tree, two presentations, and the branch is width-guarded;
 * - the active route shows the 2px accent bar — the tab underline's
 *   language — never a filled pill (no accent background anywhere in
 *   the rail, no radius on any item);
 * - the shell sets density `desk` on this branch and only here;
 * - the rail collapses and expands (owner, 2026-09-17) — the reversal of
 *   this file's original "no collapse control exists" guard, which
 *   encoded the FIRST phase's decision. The owner asked for the control
 *   for the reason that decision missed: his widest screens are tables,
 *   and a rail spending 168px on labels is a table's last column.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { act } from 'react';

import { COLORS, DESK, type Density } from '@servgrid/shared';

const DESK_RAIL_COLLAPSED_WIDTH = DESK.rail.collapsedWidth;

const viewport = vi.hoisted(() => ({ width: 1280 }));
const route = vi.hoisted(() => ({ pathname: '/dashboard', navigated: '' }));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../test-stubs/react-native')>();
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: 'web' as const },
    useWindowDimensions: () => ({ width: viewport.width, height: 800, scale: 2, fontScale: 1 }),
  };
});
vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: (path: string) => (route.navigated = path) }),
  usePathname: () => route.pathname,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { NavShell } from './NavShell';
import { useSessionStore } from '../state/sessionStore';
import { useDensity } from '../components/ui/DensityProvider';
import { findAll, findByTestID, allText, create, toJson, type Node } from '../components/ui/testing';

/** The owner's rail, top to bottom (07-OWNER.md): five sections matching
 * the phone's five groups exactly, expanded to individual routes. The
 * Dashboard section is a bare item — no heading repeated under itself —
 * and Operations names the dispatch form "Dispatch" and the AMC list
 * "AMC". Renewals is gone (decision 2026-09-15: ending-soon is a section
 * of the AMC screen). The probe renders nothing, so these are all the
 * texts there are. */
const OWNER_RAIL_TEXTS = [
  // The rail's head (OW.2, 2026-09-16): the product's name and who is
  // signed in. A console that opened on a bare list of links gave the eye
  // nowhere to land, and the rail read as content rather than as chrome.
  'ServGrid',
  'Owner',
  'Dashboard',
  'Operations', 'Jobs', 'Dispatch', 'Customers', 'AMC',
  'Sales', 'Sales', 'Payments', 'Companies',
  'People', 'Employees', 'Location', 'Cash queue',
  'Catalogue', 'Products', 'Services',
  // The Profile section head is skipped by design: a group whose single
  // route is named like the group renders the link alone (07-OWNER.md).
  'Profile',
];

let densitySeen: Density | null = null;

/** The shell's children, reading back the density it was served. */
function ScreenProbe(): null {
  densitySeen = useDensity();
  return null;
}

async function mountShell(): Promise<Awaited<ReturnType<typeof create>>> {
  let renderer!: Awaited<ReturnType<typeof create>>;
  await act(async () => {
    renderer = await create(
      <NavShell>
        <ScreenProbe />
      </NavShell>,
    );
  });
  return renderer;
}

/** The rail's route links, in render order. */
function railLinks(root: Node | null): Node[] {
  const rail = findByTestID(root, 'desk-rail');
  if (rail === undefined) return [];
  return findAll(rail, (n) => n.props.accessibilityRole === 'link');
}

function flatStyle(node: Node): Record<string, unknown> {
  return Object.assign({}, ...(Array.isArray(node.props.style) ? node.props.style : [node.props.style]).filter(Boolean));
}

beforeEach(() => {
  viewport.width = 1280;
  route.pathname = '/dashboard';
  route.navigated = '';
  densitySeen = null;
  useSessionStore.setState({
    status: 'authenticated',
    actor: { id: 'e-owner', role: 'owner', username: 'owner' },
  });
});

describe('NavShell desk branch — the 240px rail at ≥1024px', () => {
  it('renders the owner’s six sections in order, expanded to routes', async () => {
    const renderer = await mountShell();
    const tree = toJson(renderer);
    expect(findByTestID(tree, 'desk-rail')).toBeTruthy();
    expect(allText(tree)).toEqual(OWNER_RAIL_TEXTS);
    // 14 individual routes: 1 + 4 + 3 + 3 + 2 + 1. The catalogue is its
    // own section — under PROFILE the lists read as profile settings.
    expect(railLinks(tree)).toHaveLength(14);
    // The phone presentation is gone on this branch.
    expect(findByTestID(tree, 'nav-underline')).toBeUndefined();
    expect(findAll(tree, (n) => n.props.accessibilityRole === 'tab')).toEqual([]);
  });

  it('holds the rail at 240px on the slate.900 ground', async () => {
    const renderer = await mountShell();
    const rail = findByTestID(toJson(renderer), 'desk-rail');
    const style = flatStyle(rail!);
    expect(style.flexBasis).toBe(240);
    expect(style.width).toBe(240);
    // slate.900 ground (SEMANTIC.bg.dark), right border to the content.
    expect(style.backgroundColor).toBe('#16202B');
    expect(style.borderRightWidth).toBe(1);
  });

  it('sets density desk on this branch, through the one seam', async () => {
    await mountShell();
    expect(densitySeen).toBe('desk');
  });
});

describe('NavShell below the breakpoint — tabs render', () => {
  it('the same owner session at 800px gets the phone tab bar, not the rail', async () => {
    viewport.width = 800;
    const renderer = await mountShell();
    const tree = toJson(renderer);
    expect(findByTestID(tree, 'desk-rail')).toBeUndefined();
    expect(findByTestID(tree, 'nav-underline')).toBeTruthy();
    expect(findAll(tree, (n) => n.props.accessibilityRole === 'tablist')).toHaveLength(1);
    expect(allText(tree)).toEqual(['Dashboard', 'Operations', 'Sales', 'People', 'Catalogue', 'Profile']);
    expect(densitySeen).toBe('field');
  });
});

describe('NavShell active state — the 2px accent bar, never a filled pill', () => {
  it('exactly the active route carries the 2px accent bar', async () => {
    route.pathname = '/jobs'; // /jobs/123 resolves to the same route
    const renderer = await mountShell();
    const links = railLinks(toJson(renderer));
    const selected = links.filter((n) => (n.props.accessibilityState as { selected?: boolean } | undefined)?.selected === true);
    expect(selected).toHaveLength(1);
    const style = flatStyle(selected[0]!);
    expect(style.borderLeftWidth).toBe(2);
    expect(style.borderLeftColor).toBe(COLORS.accent);
    // Every other route's bar is transparent — the bar exists only on
    // the active route.
    for (const link of links.filter((n) => n !== selected[0])) {
      expect(flatStyle(link).borderLeftColor).toBe('transparent');
    }
  });

  it('nothing in the rail is filled or rounded — no pill, no accent background', async () => {
    route.pathname = '/cash';
    const renderer = await mountShell();
    const rail = findByTestID(toJson(renderer), 'desk-rail');
    expect(rail).toBeTruthy();
    const filled = findAll(rail ?? null, (n) => flatStyle(n).backgroundColor === COLORS.accent);
    expect(filled).toEqual([]);
    const rounded = findAll(rail ?? null, (n) => typeof flatStyle(n).borderRadius === 'number' && (flatStyle(n).borderRadius as number) > 0);
    expect(rounded).toEqual([]);
  });

  it('a rail press navigates to its route', async () => {
    const renderer = await mountShell();
    const amc = railLinks(toJson(renderer)).find((n) => n.props.accessibilityLabel === 'AMC');
    expect(amc).toBeTruthy();
    void act(() => {
      (amc?.props.onPress as () => void)();
    });
    expect(route.navigated).toBe('/contracts');
  });
});

describe('the rail collapses and expands (owner, 2026-09-17)', () => {
  it('opens expanded at the full 240, with the control the only non-link pressable', async () => {
    const renderer = await mountShell();
    const rail = findByTestID(toJson(renderer), 'desk-rail');
    const pressables = findAll(rail ?? null, (n) => n.type === 'Pressable');
    // 14 route links plus the collapse control — and the control is a
    // button, never a link: it navigates nowhere.
    expect(pressables).toHaveLength(15);
    const links = pressables.filter((n) => n.props.accessibilityRole === 'link');
    expect(links).toHaveLength(14);
    const control = pressables.filter((n) => n.props.accessibilityRole === 'button');
    expect(control).toHaveLength(1);
    expect(control[0]!.props.testID).toBe('desk-rail-collapse');
    expect(flatStyle(control[0]!).backgroundColor).not.toBe(COLORS.accent);
  });

  it('collapsing narrows the rail to the token width and drops the labels, never the marks', async () => {
    const renderer = await mountShell();
    const control = () => findByTestID(toJson(renderer), 'desk-rail-collapse')!;
    const rail = () => flatStyle(findByTestID(toJson(renderer), 'desk-rail')!);

    expect(rail().flexBasis).toBe(240);
    await act(async () => {
      (control().props.onPress as () => void)();
    });
    expect(rail().flexBasis).toBe(DESK_RAIL_COLLAPSED_WIDTH);
    expect(rail().width).toBe(DESK_RAIL_COLLAPSED_WIDTH);

    // The labels are gone; the marks — the whole interface at this width
    // — are all still there, one per route.
    const texts = allText(toJson(renderer));
    expect(texts).not.toContain('Jobs');
    expect(texts).not.toContain('Customers');
    const marks = findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('rail-mark-'));
    // 14 route marks + the 5 section marks' 4 headings (Dashboard is bare).
    expect(marks.length).toBeGreaterThanOrEqual(14);

    // …and it comes back.
    await act(async () => {
      (control().props.onPress as () => void)();
    });
    expect(rail().flexBasis).toBe(240);
    expect(allText(toJson(renderer))).toContain('Jobs');
  });

  it('the control is never navigation — pressing it does not route', async () => {
    const renderer = await mountShell();
    route.navigated = '';
    const control = findByTestID(toJson(renderer), 'desk-rail-collapse')!;
    await act(async () => {
      (control.props.onPress as () => void)();
    });
    expect(route.navigated).toBe('');
  });
});

describe('the rail lights exactly ONE route — the most specific match', () => {
  it('Dispatch (/jobs/new) lights Dispatch alone, never Jobs', async () => {
    // The reported bug (owner, 2026-09-17): `/jobs/new` is inside `/jobs`
    // by prefix, so testing each item on its own lit both entries.
    route.pathname = '/jobs/new';
    const renderer = await mountShell();
    const links = railLinks(toJson(renderer));
    const selected = links.filter(
      (n) => (n.props.accessibilityState as { selected?: boolean } | undefined)?.selected === true,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.props.accessibilityLabel).toBe('Dispatch');
  });

  it('Jobs lights Jobs alone — the parent is not shadowed by its child', async () => {
    route.pathname = '/jobs';
    const renderer = await mountShell();
    const links = railLinks(toJson(renderer));
    const selected = links.filter(
      (n) => (n.props.accessibilityState as { selected?: boolean } | undefined)?.selected === true,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.props.accessibilityLabel).toBe('Jobs');
  });

  it('a job detail page lights its own section, not the create form', async () => {
    route.pathname = '/jobs/2627-00086';
    const renderer = await mountShell();
    const links = railLinks(toJson(renderer));
    const selected = links.filter(
      (n) => (n.props.accessibilityState as { selected?: boolean } | undefined)?.selected === true,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.props.accessibilityLabel).toBe('Jobs');
  });
});
