/**
 * Change password, from a profile (§T7/§D6/§O9). The signed-in person's own
 * way to replace their password — the volunteer's shape of
 * `ChangePasswordScreen`: it asks for the current password, offers a way
 * back, and changes nothing about the session.
 *
 * The forced flow keeps its own route (`(auth)/change-password`), because
 * that one is not dismissible and already holds the temporary password.
 * This route exists because the profiles used to push the forced one: with
 * no temporary password in the session it redirected to `/login`, so
 * "Change password" signed the user out (reported on the handset,
 * 2026-09-17).
 *
 * Guarded `open`: every signed-in role may change its own password, and
 * this screen reads nothing else.
 */
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { api } from '../../../src/lib/api';
import { ChangePasswordScreen } from '../../../src/screens/ChangePasswordScreen';
import { landingRouteFor } from '../../../src/routes/landing';
import { useSessionStore } from '../../../src/state/sessionStore';

export default function ProfilePasswordRoute() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);

  // The app's own ground, not the frame: `ChangePasswordScreen` is a form
  // (heading, fields, one primary) drawn for a light page — the same screen
  // the forced flow shows. A navy ground under it renders its text dark on
  // dark (seen on the handset, 2026-09-17).
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <ChangePasswordScreen
        api={api}
        onComplete={() => {
          // Straight back where he came from: the session is untouched, so
          // there is no flow to finish and no landing route to force.
          router.back();
        }}
        onCancel={() => {
          if (router.canGoBack()) router.back();
          else router.replace(actor === null ? '/login' : landingRouteFor(actor.role));
        }}
      />
    </SafeAreaView>
  );
}
