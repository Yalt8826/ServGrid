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
 * - no collapse control exists — 15 route links, nothing else
 *   pressable, and no collapse notion in the source.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { act } from 'react';

import { COLORS, type Density } from '@servgrid/shared';

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
vi.mock('../sync/MirrorProvider', () => ({
  useMirrorSession: () => null,
}));

import { NavShell } from './NavShell';
import { useSessionStore } from '../state/sessionStore';
import { useDensity } from '../components/ui/DensityProvider';
import { findAll, findByTestID, allText, create, toJson, type Node } from '../components/ui/testing';

const NAV_SHELL_SOURCE = readFileSync(join(fileURLToPath(new URL('./', import.meta.url).href), 'NavShell.tsx'), 'utf8');

/** The owner's rail, top to bottom (07-OWNER.md): five sections matching
 * the phone's five groups exactly, expanded to individual routes. The
 * Dashboard section is a bare item — no heading repeated under itself —
 * and Operations names the dispatch form "Dispatch". The probe renders
 * nothing, so these are all the texts there are. */
const OWNER_RAIL_TEXTS = [
  'Dashboard',
  'Operations', 'Jobs', 'Dispatch', 'Customers', 'Contracts',
  'Sales', 'Sales', 'Payments', 'Companies', 'Renewals',
  'People', 'Employees', 'Location', 'Cash queue',
  'Profile', 'Profile', 'Products', 'Services',
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
  it('renders the owner’s five sections in order, expanded to routes', async () => {
    const renderer = await mountShell();
    const tree = toJson(renderer);
    expect(findByTestID(tree, 'desk-rail')).toBeTruthy();
    expect(allText(tree)).toEqual(OWNER_RAIL_TEXTS);
    // 15 individual routes: 1 + 4 + 4 + 3 + 3.
    expect(railLinks(tree)).toHaveLength(15);
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
    expect(allText(tree)).toEqual(['Dashboard', 'Operations', 'Sales', 'People', 'Profile']);
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
    const contracts = railLinks(toJson(renderer)).find((n) => n.props.accessibilityLabel === 'Contracts');
    expect(contracts).toBeTruthy();
    void act(() => {
      (contracts?.props.onPress as () => void)();
    });
    expect(route.navigated).toBe('/contracts');
  });
});

describe('no collapse control exists', () => {
  // The spec's own words ("The rail does not collapse") live in the doc
  // comment; the CODE must never act on the idea. Strip comments, then
  // read what remains.
  const NAV_SHELL_CODE = NAV_SHELL_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the code never speaks of collapsing', () => {
    expect(/collaps/i.test(NAV_SHELL_CODE)).toBe(false);
  });

  it('the rail is 15 route links and nothing else pressable', async () => {
    const renderer = await mountShell();
    const rail = findByTestID(toJson(renderer), 'desk-rail');
    const pressables = findAll(rail ?? null, (n) => n.type === 'Pressable');
    expect(pressables).toHaveLength(15);
    expect(pressables.every((n) => n.props.accessibilityRole === 'link')).toBe(true);
  });
});
