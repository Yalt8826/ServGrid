/**
 * The navigation source of truth (T0.13): the per-role group map
 * (PLAN-FRONTEND.md §3), the route guard table RoleGate reads, and the
 * density seam (UI/plan-2/01-FOUNDATIONS.md §3.3). Pure data and pure
 * functions — no react-native, no expo-router — so the cross-check in
 * `navmap.test.ts` (the CI merge gate) runs on exactly what the app runs.
 *
 * Two questions live here and must never be conflated:
 *
 * - **Permission** (`guardAllows`, RoleGate's runtime check) — may this
 *   role open this route at all? Answered by `permit() !== 'none'`; row
 *   scoping (`own` / `assigned`) is applied server-side.
 * - **Tab reachability** (`guardLands`) — is this route a destination a
 *   tab leads to? An `assigned` scope never lands: those rows are
 *   reached through their parent entity (the technician reads a customer
 *   through his job, not a customer list).
 *
 * The group map is **per role, not the owner's map filtered by
 * permission** (PLAN.md §8): filtering one owner-shaped map strands the
 * technician's cash handover and the rep's contract list — both
 * permitted, both routed, neither reachable, and neither failure raises
 * anything. `navmap.test.ts` walks map × matrix in both directions so
 * drift fails the build instead of stranding a screen.
 */
import {
  permit,
  type Action,
  type Density,
  type Resource,
  type Role,
  type Scope,
} from '@servgrid/shared';

/** Group keys across all four role maps (PLAN.md §8, PLAN-FRONTEND.md §3). */
export type NavGroupKey =
  | 'dashboard'
  | 'jobs'
  | 'operations'
  | 'amc'
  | 'sales'
  | 'companies'
  | 'cash'
  | 'people'
  | 'catalogue'
  | 'profile';

export interface NavGroup {
  key: NavGroupKey;
  label: string;
  /** Section routes the tab leads to; detail routes hang off these. */
  routes: string[];
}

/**
 * The map per role — one literal per role, transcribed from
 * PLAN-FRONTEND.md §3. Tab counts: technician 4 · dispatcher 4 ·
 * sales rep 5 · owner 6. `/cash` moves by role rather than being hidden:
 * the owner's reconciliation queue under People, the field roles' own
 * handover as its own tab. `/contracts` is the dispatcher's own AMC tab
 * and an Operations entry for the owner; reps have none (decision
 * 2026-09-15).
 */
export const NAV_GROUPS: Record<Role, NavGroup[]> = {
  technician: [
    { key: 'dashboard', label: 'Dashboard', routes: ['/dashboard'] },
    { key: 'jobs', label: 'Jobs', routes: ['/jobs'] },
    { key: 'cash', label: 'Cash', routes: ['/cash/handover'] },
    { key: 'profile', label: 'Profile', routes: ['/profile'] },
  ],
  dispatcher: [
    { key: 'dashboard', label: 'Dashboard', routes: ['/dashboard'] },
    { key: 'operations', label: 'Operations', routes: ['/jobs', '/jobs/new', '/customers'] },
    { key: 'amc', label: 'AMC', routes: ['/contracts', '/contracts/new'] },
    { key: 'profile', label: 'Profile', routes: ['/profile'] },
  ],
  sales_rep: [
    { key: 'dashboard', label: 'Dashboard', routes: ['/dashboard'] },
    {
      key: 'sales',
      label: 'Sales',
      routes: ['/sales', '/payments'],
    },
    {
      key: 'companies',
      label: 'Companies',
      routes: ['/companies', '/companies/new'],
    },
    { key: 'cash', label: 'Cash', routes: ['/cash/handover'] },
    { key: 'profile', label: 'Profile', routes: ['/profile'] },
  ],
  owner: [
    { key: 'dashboard', label: 'Dashboard', routes: ['/dashboard'] },
    { key: 'operations', label: 'Operations', routes: ['/jobs', '/jobs/new', '/customers', '/contracts'] },
    { key: 'sales', label: 'Sales', routes: ['/sales', '/payments', '/companies'] },
    { key: 'people', label: 'People', routes: ['/employees', '/location', '/cash'] },
    // The catalogue is its own section: under PROFILE it read as if the
    // product and service lists were profile settings (2026-09-16 walk).
    { key: 'catalogue', label: 'Catalogue', routes: ['/products', '/services'] },
    { key: 'profile', label: 'Profile', routes: ['/profile'] },
  ],
};

export function groupMapFor(role: Role): NavGroup[] {
  return NAV_GROUPS[role];
}

/** Every section route the role's map contains, in tab order. */
export function flattenedRoutes(role: Role): string[] {
  return NAV_GROUPS[role].flatMap((group) => group.routes);
}

/**
 * What each section route requires. One table, read by RoleGate at
 * runtime and walked against `permit()` by the merge-gate test — a route
 * guard is a view onto the matrix, never a second matrix.
 *
 * - `open` — role-aware content; every role lands here.
 * - `ownerOnly` — no matrix resource exists for the catalog by design
 *   (PLAN-BACKEND.md §6: products/services read by all for pickers,
 *   written by the owner). These screens are the *management* surface —
 *   the write side — so they are owner-only; role screens read the
 *   catalog inside their own pickers and never navigate here.
 * - `matrix` — decided by `permit()`. `landing` names the scopes that
 *   make the route a TAB destination for the cross-check's second
 *   direction; runtime permission is always the coarser `!== 'none'`.
 */
export type RouteGuard =
  | { kind: 'open' }
  | { kind: 'ownerOnly' }
  | { kind: 'matrix'; resource: Resource; action: Action; landing: readonly Scope[] };

export const ROUTE_GUARDS: Record<string, RouteGuard> = {
  '/dashboard': { kind: 'open' },

  '/jobs': { kind: 'matrix', resource: 'job', action: 'read', landing: ['all', 'own'] },
  '/jobs/new': { kind: 'matrix', resource: 'job', action: 'create', landing: ['all'] },
  // T2.8 — the dispatcher's Job Logs (§D2). Same permission as the list
  // it filters; a landing route only for `all`-scoped roles, reached
  // through the jobs tab (and dark without `dispatch.console`).
  '/jobs/logs': { kind: 'matrix', resource: 'job', action: 'read', landing: ['all'] },

  '/customers': { kind: 'matrix', resource: 'customer', action: 'read', landing: ['all'] },
  '/customers/new': { kind: 'matrix', resource: 'customer', action: 'create', landing: ['all'] },

  '/sales': { kind: 'matrix', resource: 'sale', action: 'read', landing: ['all', 'own'] },
  '/sales/new': { kind: 'matrix', resource: 'sale', action: 'create', landing: ['all', 'own'] },

  '/payments': { kind: 'matrix', resource: 'payment', action: 'read', landing: ['all', 'own'] },
  '/payments/new': { kind: 'matrix', resource: 'payment', action: 'create', landing: ['all', 'own'] },

  '/companies': { kind: 'matrix', resource: 'company', action: 'read', landing: ['all', 'own'] },
  '/companies/new': { kind: 'matrix', resource: 'company', action: 'create', landing: ['all', 'own'] },

  '/contracts': { kind: 'matrix', resource: 'contract', action: 'read', landing: ['all'] },
  '/contracts/new': { kind: 'matrix', resource: 'contract', action: 'create', landing: ['all'] },

  '/products': { kind: 'ownerOnly' },
  // OW.3: the catalogue's create doors. Owner-only like the lists they
  // hang off — the server's own door says the same (§6.4).
  '/products/new': { kind: 'ownerOnly' },
  '/services': { kind: 'ownerOnly' },
  '/services/new': { kind: 'ownerOnly' },

  '/employees': { kind: 'matrix', resource: 'employee', action: 'read', landing: ['all'] },
  '/employees/new': { kind: 'matrix', resource: 'employee', action: 'create', landing: ['all'] },

  '/location': { kind: 'matrix', resource: 'location.read', action: 'read', landing: ['all'] },

  '/cash': { kind: 'matrix', resource: 'cash.confirm', action: 'read', landing: ['all'] },
  '/cash/handover': { kind: 'matrix', resource: 'cash.declare', action: 'read', landing: ['all', 'own'] },

  '/profile': { kind: 'matrix', resource: 'employee', action: 'read', landing: ['all', 'own'] },
  '/profile/tracking': {
    kind: 'matrix',
    resource: 'location.health',
    action: 'read',
    landing: ['all', 'own'],
  },
  '/profile/settings': { kind: 'matrix', resource: 'employee', action: 'read', landing: ['all', 'own'] },
};

/** May this role open this route at all — RoleGate's runtime question. */
export function guardAllows(guard: RouteGuard, role: Role): boolean {
  switch (guard.kind) {
    case 'open':
      return true;
    case 'ownerOnly':
      return role === 'owner';
    case 'matrix':
      return permit(role, guard.resource, guard.action) !== 'none';
  }
}

/** Does this role's scope make the route a tab destination (cross-check). */
export function guardLands(guard: RouteGuard, role: Role): boolean {
  switch (guard.kind) {
    case 'open':
      return true;
    case 'ownerOnly':
      return role === 'owner';
    case 'matrix':
      return guard.landing.includes(permit(role, guard.resource, guard.action));
  }
}

/**
 * Runtime route check for RoleGate. Deep paths (`/jobs/123/complete`)
 * walk up to the nearest guarded ancestor (`/jobs`) — detail routes and
 * sheets inherit their section's permission, and row-level scoping is
 * the server's job. A path with no guarded ancestor is not a route this
 * app knows: forbidden, so the gate redirects instead of erroring.
 */
export function isRoutePermitted(role: Role, path: string): boolean {
  const segments = path.split('/').filter((s) => s !== '');
  for (let end = segments.length; end >= 1; end -= 1) {
    const candidate = `/${segments.slice(0, end).join('/')}`;
    const guard: RouteGuard | undefined = ROUTE_GUARDS[candidate];
    if (guard !== undefined) return guardAllows(guard, role);
  }
  return false;
}

/** True when `path` is `mapRoute` itself or hangs beneath it. */
export function routeIsCovered(mapRoute: string, path: string): boolean {
  return path === mapRoute || path.startsWith(`${mapRoute}/`);
}

/** Index of the tab whose routes cover `path`, or -1 (non-section route). */
export function coveringGroupIndex(role: Role, path: string): number {
  return NAV_GROUPS[role].findIndex((group) => group.routes.some((route) => routeIsCovered(route, path)));
}

/**
 * The ONE route the desk rail should light for this path — the most
 * specific match, not every match.
 *
 * `routeIsCovered` is a prefix rule, and sections nest inside each other:
 * `/jobs/new` is inside `/jobs`. Testing each rail item on its own lit
 * BOTH of the owner's Operations entries — pressing Dispatch left Jobs
 * highlighted too (owner, 2026-09-17) — because a link cannot know that a
 * sibling matches more precisely. Comparison is by length, which is the
 * only ordering the map guarantees: the more specific route is always the
 * longer one, and a true prefix can never be longer than its extension.
 */
export function activeRailRoute(role: Role, path: string): string | null {
  let best: string | null = null;
  for (const group of NAV_GROUPS[role]) {
    for (const route of group.routes) {
      if (!routeIsCovered(route, path)) continue;
      if (best === null || route.length > best.length) best = route;
    }
  }
  return best;
}

/**
 * The density seam (01-FOUNDATIONS.md §3.3): NavShell calls this once,
 * from role and platform — screens never set density. Field roles
 * (technician, sales rep) live in `field`; the dispatcher is the one
 * role where `field` would be wrong (05-DISPATCHER.md); the owner's web
 * desk presentation is `desk`, his Android five-group app `field`
 * (07-OWNER.md).
 */
export function densityForRole(role: Role, desk: boolean): Density {
  if (desk) return 'desk';
  return role === 'dispatcher' ? 'console' : 'field';
}

/** Display labels for rail routes (the desk presentation expands groups).
 * The owner's Operations section names the dispatch form "Dispatch"
 * (07-OWNER.md "The desktop rail"); these labels feed only the rail —
 * the phone tab bar renders group labels, never route labels. */
export const ROUTE_LABELS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/jobs': 'Jobs',
  '/jobs/new': 'Dispatch',
  '/jobs/logs': 'Job Logs',
  '/customers': 'Customers',
  '/customers/new': 'New customer',
  '/sales': 'Sales',
  '/sales/new': 'New sale',
  '/payments': 'Payments',
  '/payments/new': 'Record payment',
  '/companies': 'Companies',
  '/companies/new': 'New account',
  '/contracts': 'AMC',
  '/contracts/new': 'New AMC',
  '/products': 'Products',
  '/products/new': 'New product',
  '/services': 'Services',
  '/services/new': 'New service',
  '/employees': 'Employees',
  '/employees/new': 'New employee',
  '/location': 'Location',
  '/cash': 'Cash queue',
  '/cash/handover': 'Cash handover',
  '/profile': 'Profile',
  '/profile/tracking': 'Tracking',
  '/profile/settings': 'Settings',
};
