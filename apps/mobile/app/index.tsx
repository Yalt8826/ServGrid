/**
 * `index` — role → redirect to that role's landing route
 * (PLAN-FRONTEND.md §2). Deep links straight into guarded routes never
 * pass through here; the group layouts own guarding.
 */
import { Redirect } from 'expo-router';
import { landingRouteFor } from '../src/routes/landing';
import { useSessionStore } from '../src/state/sessionStore';

export default function Index() {
  const status = useSessionStore((s) => s.status);
  const actor = useSessionStore((s) => s.actor);

  if (status === 'authenticated' && actor !== null) {
    return <Redirect href={landingRouteFor(actor.role)} />;
  }
  return <Redirect href="/login" />;
}
