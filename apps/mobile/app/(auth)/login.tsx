/**
 * Login route (T0.14). Wires the §X1 screen to the singleton API
 * client, the device identity, and the session store. The routing
 * decision lives in `nextRouteFor` (screen module, pure); this file
 * only turns it into a `router.replace`.
 */
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { api } from '../../src/lib/api';
import { buildLoginDevice } from '../../src/lib/device';
import { landingRouteFor } from '../../src/routes/landing';
import { LoginScreen, nextRouteFor } from '../../src/screens/LoginScreen';
import { useSessionStore } from '../../src/state/sessionStore';

export default function LoginRoute() {
  const router = useRouter();
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      edges={['top', 'bottom', 'left', 'right']}
    >
      <LoginScreen
        signIn={async (username, password) =>
          api.login(username, password, await buildLoginDevice())
        }
        discardSession={() => api.logout()}
        onAuthenticated={(result, password) => {
          const store = useSessionStore.getState();
          store.setAuthenticated(result.employee, {
            consent: result.consent,
            tempPassword: result.mustChangePassword ? password : null,
          });
          const next = nextRouteFor(result);
          router.replace(next === 'landing' ? landingRouteFor(result.employee.role) : `/${next}`);
        }}
      />
    </SafeAreaView>
  );
}
