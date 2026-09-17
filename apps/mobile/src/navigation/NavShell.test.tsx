/**
 * NavShell tests (T0.13). The platform branch is asserted by reading the
 * source: `Platform.OS` appears exactly once in NavShell.tsx and zero
 * times in the route tree under `app/` — the branch exists exactly once
 * in the codebase, and screens never ask what platform they are on
 * (PLAN-FRONTEND.md §3). Density resolution is asserted against the same
 * pure function NavShell calls: field for the field roles, console for
 * the dispatcher, desk for the owner's web desk (01-FOUNDATIONS §3.3).
 *
 * The tab bar itself renders under the react-test-renderer seam: one
 * role's group map per bar, the accent underline on the active tab,
 * taps routed through `onSelect`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { act } from 'react';

import { COLORS, type Role } from '@servgrid/shared';

import { densityForRole } from './navmap';
import { NavTabBar } from './NavTabBar';
import { allText, create, findByTestID, toJson, type Node } from '../components/ui/testing';

const NAV_DIR = fileURLToPath(new URL('./', import.meta.url).href);
const APP_DIR = fileURLToPath(new URL('../../app', import.meta.url).href);

function readTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTsFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(readFileSync(full, 'utf8'));
  }
  return out;
}

const NAV_SHELL_SOURCE = readFileSync(join(NAV_DIR, 'NavShell.tsx'), 'utf8');

describe('exactly one platform branch in the codebase', () => {
  it('NavShell.tsx contains a single Platform.OS occurrence', () => {
    expect(NAV_SHELL_SOURCE.match(/Platform\.OS/g)).toHaveLength(1);
  });

  it('that occurrence is the desk branch: web, 1024px, width-guarded', () => {
    expect(NAV_SHELL_SOURCE).toContain("Platform.OS === 'web'");
    expect(NAV_SHELL_SOURCE).toContain('DESK_MIN_WIDTH = 1024');
    expect(NAV_SHELL_SOURCE).toContain('width >= DESK_MIN_WIDTH');
  });

  it('no file in app/**/*.tsx asks what platform it is on', () => {
    const offenders = readTsFiles(APP_DIR).filter((source) => source.includes('Platform.OS'));
    expect(offenders).toEqual([]);
  });

  it('NavShell sets density exactly once — one DensityProvider mount', () => {
    expect(NAV_SHELL_SOURCE.match(/<DensityProvider/g)).toHaveLength(1);
  });
});

describe('density resolves from role and platform', () => {
  it('technician — field', () => {
    expect(densityForRole('technician', false)).toBe('field');
  });

  it('dispatcher — console (the one role where field would be wrong)', () => {
    expect(densityForRole('dispatcher', false)).toBe('console');
  });

  it('sales rep — field', () => {
    expect(densityForRole('sales_rep', false)).toBe('field');
  });

  it('owner — desk on web ≥1024, field on his Android app', () => {
    expect(densityForRole('owner', true)).toBe('desk');
    expect(densityForRole('owner', false)).toBe('field');
  });
});

describe('NavTabBar renders the role group map', () => {
  const LABELS: Record<string, string[]> = {
    technician: ['Dashboard', 'Jobs', 'Cash', 'Profile'],
    dispatcher: ['Dashboard', 'Operations', 'Calls', 'AMC', 'Profile'],
    sales_rep: ['Dashboard', 'Sales', 'Companies', 'Cash', 'Profile'],
    owner: ['Dashboard', 'Operations', 'Sales', 'People', 'Catalogue', 'Profile'],
  };

  for (const [role, labels] of Object.entries(LABELS)) {
    it(`${role}: ${labels.length} tabs — ${labels.join(' · ')}`, async () => {
      const renderer = await create(
        <NavTabBar role={role as Role} activeRoute="/dashboard" onSelect={() => {}} />,
      );
      expect(allText(toJson(renderer))).toEqual(labels);
      // The active-state underline: 2px, accent, exactly one.
      expect(findByTestID(toJson(renderer), 'nav-underline')).toBeTruthy();
    });
  }

  it('active tab follows the covering route, not an exact match', async () => {
    const renderer = await create(
      <NavTabBar role="technician" activeRoute="/jobs/123" onSelect={() => {}} />,
    );
    const tabs = findAllTabs(toJson(renderer));
    expect(tabs).toHaveLength(4);
    const selected = tabs.map((tab) => (tab.props.accessibilityState as { selected: boolean }).selected);
    expect(selected).toEqual([false, true, false, false]);
  });

  it('a tap on Cash routes to the handover, not the owner queue', async () => {
    let target = '';
    const renderer = await create(
      <NavTabBar role="technician" activeRoute="/dashboard" onSelect={(route) => (target = route)} />,
    );
    const cashTab = findAllTabs(toJson(renderer))[2]!;
    await act(async () => {
      (cashTab.props.onPress as () => void)();
    });
    expect(target).toBe('/cash/handover');
  });

  it('the underline carries the accent', async () => {
    const renderer = await create(
      <NavTabBar role="owner" activeRoute="/location" onSelect={() => {}} />,
    );
    const underline = findByTestID(toJson(renderer), 'nav-underline')!;
    const style = underline.props.style as { backgroundColor?: string }[];
    const flat = Object.assign({}, ...style);
    expect(flat.backgroundColor).toBe(COLORS.accent);
  });
});

function findAllTabs(root: Node | string | null): Node[] {
  const out: Node[] = [];
  const walk = (node: Node | string | null): void => {
    if (node === null || typeof node === 'string') return;
    if (node.props.accessibilityRole === 'tab') out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}
