/**
 * Consent route (T0.14). Presented at first login and on a copy version
 * change, for the tracked roles (§X3). The version comes from this
 * login's response via the session store — arriving here without one
 * means no fresh login said consent was owed, so the honest redirect is
 * out, not a re-ask.
 */
import { Redirect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { api } from '../../src/lib/api';
import { landingRouteFor } from '../../src/routes/landing';
import { ConsentScreen } from '../../src/screens/ConsentScreen';
import { useSessionStore } from '../../src/state/sessionStore';

export default function ConsentRoute() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const consent = useSessionStore((s) => s.consent);

  if (actor === null) {
    return <Redirect href="/login" />;
  }
  const owed = consent !== null && consent.required && actor.role !== 'dispatcher' && actor.role !== 'owner';
  if (!owed) {
    return <Redirect href={landingRouteFor(actor.role)} />;
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      edges={['top', 'bottom', 'left', 'right']}
    >
      <ConsentScreen
        api={api}
        version={consent.version}
        onAccepted={() => router.replace(landingRouteFor(actor.role))}
      />
    </SafeAreaView>
  );
}
