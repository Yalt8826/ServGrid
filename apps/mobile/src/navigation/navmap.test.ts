/**
 * The nav × permission cross-check (T0.13) — the CI merge gate. Neither
 * direction of this failure raises at runtime, which is why it is a
 * build gate:
 *
 * - **map → matrix**: every route in a role's group map is permitted by
 *   `permit()`. A tab to a forbidden route is a 403 the user tapped.
 * - **matrix → map**: every route `permit()` allows *as a tab
 *   destination* has a tab that reaches it. A permitted route with no
 *   tab is unreachable — the stranded-screen failure that is silent by
 *   construction (PLAN.md §8: filtering one owner-shaped map strands the
 *   technician's handover and the rep's contract list).
 *
 * The route universe is walked from the actual `app/(app)` tree, so a
 * screen file added later without a guard — or without a tab — fails
 * here rather than in front of a user. Detail routes (dynamic segments
 * and their subtrees) are out of the tab universe by design: they are
 * reached through their section (`/jobs/[id]` through `/jobs`), and the
 * runtime gate walks them up to their nearest guarded ancestor.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { ROLES, type Role } from '@servgrid/shared';

import {
  ROUTE_GUARDS,
  activeRailRoute,
  flattenedRoutes,
  guardAllows,
  guardLands,
  groupMapFor,
  isRoutePermitted,
  routeIsCovered,
} from './navmap';

/** Static hrefs from the route tree: no `_`-prefixed files, no dynamic
 * segments or their subtrees (detail routes hang off their section). */
function staticRoutesFromTree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('[')) continue;
    const segment = entry.name.replace(/\.tsx$/, '');
    const path = `${prefix}/${segment}`;
    if (entry.isDirectory()) {
      out.push(...staticRoutesFromTree(join(dir, entry.name), path));
    } else {
      out.push(path.endsWith('/index') ? path.replace(/\/index$/, '') || '/' : path);
    }
  }
  return out;
}

const TREE = staticRoutesFromTree(fileURLToPath(new URL('../../app/(app)', import.meta.url).href));

describe('route tree ↔ guard table — one of each, no orphans', () => {
  it('the route tree yields static routes', () => {
    expect(TREE.length).toBeGreaterThan(15);
    expect(TREE).toContain('/dashboard');
    expect(TREE).toContain('/cash/handover');
    expect(TREE).not.toContain('/contracts/renewals');
  });

  it('every static route has exactly one guard entry', () => {
    const unguarded = TREE.filter((route) => !(route in ROUTE_GUARDS));
    expect(unguarded).toEqual([]);
  });

  it('every guard entry names a route that exists in the tree', () => {
    const dead = Object.keys(ROUTE_GUARDS).filter((route) => !TREE.includes(route));
    expect(dead).toEqual([]);
  });
});

describe('cross-check, direction A — every tab leads somewhere permitted', () => {
  for (const role of ROLES) {
    it(`${role}: every route in the group map is permitted`, () => {
      const forbidden = flattenedRoutes(role).filter((route) => !guardAllows(ROUTE_GUARDS[route]!, role));
      expect(forbidden).toEqual([]);
    });
  }

  it('technician map contains /cash/handover', () => {
    expect(flattenedRoutes('technician')).toContain('/cash/handover');
  });

  it('sales rep map has no AMC routes — reps have no part in AMCs (decision 2026-09-15)', () => {
    const routes = flattenedRoutes('sales_rep');
    expect(routes).not.toContain('/contracts');
    expect(routes).not.toContain('/contracts/renewals');
    expect(isRoutePermitted('sales_rep', '/contracts')).toBe(false);
  });

  it('the dispatcher reaches /contracts from the AMC tab', () => {
    const amc = groupMapFor('dispatcher').find((g) => g.key === 'amc');
    expect(amc?.routes).toContain('/contracts');
  });
});

describe('cross-check, direction B — every permitted destination has a tab', () => {
  for (const role of ROLES) {
    it(`${role}: every tab-routable route is reached by a tab`, () => {
      const stranded = TREE.filter((route) => {
        if (!guardLands(ROUTE_GUARDS[route]!, role)) return false;
        return !flattenedRoutes(role).some((mapRoute) => routeIsCovered(mapRoute, route));
      });
      expect(stranded).toEqual([]);
    });
  }
});

describe('tab counts — technician 4 · dispatcher 4 · sales rep 5 · owner 6', () => {
  const EXPECTED: Record<Role, number> = {
    technician: 4,
    dispatcher: 4,
    sales_rep: 5,
    owner: 6,
  };
  for (const role of ROLES) {
    it(`${role} has ${EXPECTED[role]} tabs`, () => {
      expect(groupMapFor(role)).toHaveLength(EXPECTED[role]);
    });
  }

  it('every group carries at least one route', () => {
    for (const role of ROLES) {
      for (const group of groupMapFor(role)) {
        expect(group.routes.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('runtime gate behaviour the RoleGate relies on', () => {
  it('technician deep-linked to /companies is forbidden → redirects', () => {
    expect(isRoutePermitted('technician', '/companies')).toBe(false);
  });

  it('technician deep-linked to /companies/:id is forbidden too (walks up)', () => {
    expect(isRoutePermitted('technician', '/companies/42')).toBe(false);
  });

  it('technician /cash (the owner queue) is forbidden; /cash/handover is his', () => {
    expect(isRoutePermitted('technician', '/cash')).toBe(false);
    expect(isRoutePermitted('technician', '/cash/handover')).toBe(true);
  });

  it('dispatcher has no companies, sales or location console', () => {
    expect(isRoutePermitted('dispatcher', '/companies')).toBe(false);
    expect(isRoutePermitted('dispatcher', '/sales')).toBe(false);
    expect(isRoutePermitted('dispatcher', '/location')).toBe(false);
  });

  it('sales rep has no jobs; rep deep-linked to a job redirects', () => {
    expect(isRoutePermitted('sales_rep', '/jobs')).toBe(false);
    expect(isRoutePermitted('sales_rep', '/jobs/123')).toBe(false);
  });

  it('owner reaches everything, including the catalog and the cash queue', () => {
    for (const route of TREE) {
      expect(isRoutePermitted('owner', route), route).toBe(true);
    }
  });

  it('detail routes inherit their section: technician reaches an assigned job', () => {
    expect(isRoutePermitted('technician', '/jobs/123/complete')).toBe(true);
  });

  it('an unknown path is forbidden, so the gate redirects instead of erroring', () => {
    expect(isRoutePermitted('owner', '/nope')).toBe(false);
  });

  it('assigned scope opens a route without making it a tab destination', () => {
    // The technician reads a customer through his job (server-scoped),
    // but /customers is never his landing route.
    expect(isRoutePermitted('technician', '/customers/42')).toBe(true);
    expect(guardLands(ROUTE_GUARDS['/customers']!, 'technician')).toBe(false);
  });
});

describe('activeRailRoute — the ONE entry the rail lights', () => {
  /**
   * `routeIsCovered` is a prefix rule and the map nests sections inside
   * each other, so "does this route cover the path" is true for a parent
   * AND its child. The rail needs the single most specific answer, or
   * pressing Dispatch leaves Jobs lit as well (owner, 2026-09-17).
   */
  it('a nested route wins over the section that contains it', () => {
    expect(activeRailRoute('owner', '/jobs/new')).toBe('/jobs/new');
    expect(activeRailRoute('dispatcher', '/jobs/new')).toBe('/jobs/new');
    // `/contracts/new` is the DISPATCHER's AMC entry; the owner's
    // Operations group lists only `/contracts`, so there the parent is
    // the most specific entry there is.
    expect(activeRailRoute('dispatcher', '/contracts/new')).toBe('/contracts/new');
    expect(activeRailRoute('owner', '/contracts/new')).toBe('/contracts');
  });

  it('the section itself wins when a detail page hangs beneath it', () => {
    expect(activeRailRoute('owner', '/jobs')).toBe('/jobs');
    expect(activeRailRoute('owner', '/jobs/2627-00086')).toBe('/jobs');
    expect(activeRailRoute('owner', '/customers/abc')).toBe('/customers');
    expect(activeRailRoute('owner', '/contracts/abc')).toBe('/contracts');
  });

  it('a sibling is never lit by a path it does not prefix', () => {
    // `/jobs/new` must not light `/jobs` … and `/jobs` must not light
    // `/jobs/new`'s neighbour `/customers`.
    for (const role of ROLES) {
      for (const group of groupMapFor(role)) {
        for (const route of group.routes) {
          expect(activeRailRoute(role, route), `${role} ${route}`).toBe(route);
        }
      }
    }
  });

  it('nothing lights for a route the role has no entry for', () => {
    expect(activeRailRoute('technician', '/location')).toBeNull();
    expect(activeRailRoute('technician', '/sales')).toBeNull();
  });

  it('every rail entry still matches itself through routeIsCovered — the fix narrowed nothing', () => {
    for (const role of ROLES) {
      for (const group of groupMapFor(role)) {
        for (const route of group.routes) {
          expect(routeIsCovered(route, route)).toBe(true);
        }
      }
    }
  });
});
