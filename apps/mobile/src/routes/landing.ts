/**
 * Role → redirect to that role's landing route (PLAN-FRONTEND.md §2).
 * Every role lands on /dashboard for now — one route, role-aware
 * content — so the map collapses to a constant until a role needs
 * otherwise. Kept as a function because NavShell (T0.13) shares it.
 */
import type { Role } from '../lib/types';

export function landingRouteFor(_role: Role): '/dashboard' {
  return '/dashboard';
}
