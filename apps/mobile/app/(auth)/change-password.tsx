/**
 * Forced password change route (T0.14). Only reachable straight after a
 * login that said `mustChangePassword` — the temporary password lives in
 * the session store; anything else redirects to login rather than
 * improvise a third field. On success the flow continues to consent
 * when both are owed, otherwise straight to the role's landing route
 * (§X2: no interstitial).
 */
import { Redirect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { api } from '../../src/lib/api';
import { landingRouteFor } from '../../src/routes/landing';
import { ChangePasswordScreen } from '../../src/screens/ChangePasswordScreen';
import { useSessionStore } from '../../src/state/sessionStore';

export default function ChangePasswordRoute() {
  const router = useRouter();
  const tempPassword = useSessionStore((s) => s.tempPassword);
  const consent = useSessionStore((s) => s.consent);
  const actor = useSessionStore((s) => s.actor);

  if (tempPassword === null || actor === null) {
    return <Redirect href="/login" />;
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      edges={['top', 'bottom', 'left', 'right']}
    >
      <ChangePasswordScreen
        api={api}
        currentPassword={tempPassword}
        onComplete={() => {
          const store = useSessionStore.getState();
          store.clearTempPassword();
          const tracked = actor.role === 'technician' || actor.role === 'sales_rep';
          if (tracked && consent?.required) {
            router.replace('/consent');
          } else {
            router.replace(landingRouteFor(actor.role));
          }
        }}
      />
    </SafeAreaView>
  );
}
