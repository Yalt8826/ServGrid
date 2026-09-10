/**
 * RoleGate (T0.13, PLAN-FRONTEND.md §2, UI/plan-2/08-SHARED-SCREENS.md
 * §X6). One gate in `(app)/_layout.tsx` reading the same `permit()` the
 * API uses, via the guard table in `navmap.ts`. A route the role cannot
 * reach **redirects to that role's landing route** rather than rendering
 * an error — a technician deep-linked to `/companies` lands on his
 * dashboard, not on a wall.
 */
import { Redirect, usePathname } from 'expo-router';
import type { ReactNode } from 'react';

import { landingRouteFor } from '../routes/landing';
import { useSessionStore } from '../state/sessionStore';
import { isRoutePermitted } from './navmap';

export function RoleGate({ children }: { children: ReactNode }): ReactNode {
  const actor = useSessionStore((s) => s.actor);
  const pathname = usePathname();

  if (actor === null) return <Redirect href="/login" />;
  if (!isRoutePermitted(actor.role, pathname)) {
    return <Redirect href={landingRouteFor(actor.role)} />;
  }
  return <>{children}</>;
}
