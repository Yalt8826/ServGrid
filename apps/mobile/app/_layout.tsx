/**
 * Root layout — providers, session bootstrap, splash hold
 * (PLAN-FRONTEND.md §2). Bootstrap reads the token store ONCE, locally:
 * no refresh call is awaited before first paint (§5.1). The splash gate
 * waits on that local read **and** the Plex faces (T0.12: no frame
 * renders in a fallback face — the native splash stays up until both
 * land). The role-aware QueryClientProvider lives in (app)/_layout — it
 * needs the role, which cold start may not have yet.
 */
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { api } from '../src/lib/api';
import { initPush } from '../src/push/notifications';
import { registerPendingPushToken } from '../src/push/push';
import { PLEX_FONT_SOURCES } from '../src/fonts/sources';
import { bootstrapSession } from '../src/state/bootstrapSession';
import { configureQueryClient } from '../src/state/runtimeQueryClient';
import { useSessionStore } from '../src/state/sessionStore';

// Push registration is start-up-adjacent, not start-up-gating: fires
// once per launch, off the splash path (T0.15). `initPush` registers
// the background sync task and the foreground listener; the pending
// token ships after the bootstrap outcome is known.
initPush();

// Best-effort: a double-call or missing native module must not crash
// start-up — the splash is presentation, not state.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const status = useSessionStore((s) => s.status);
  const [fontsLoaded, fontError] = useFonts(PLEX_FONT_SOURCES);

  useEffect(() => {
    let alive = true;
    bootstrapSession(api)
      .catch(() => ({ authenticated: false, actor: null }))
      .then((outcome) => {
        if (!alive) return;
        if (outcome.authenticated && outcome.actor !== null) {
          configureQueryClient(outcome.actor.role);
          useSessionStore.getState().setAuthenticated(outcome.actor);
          // Session exists — ship any FCM token parked before login
          // (T0.15: token delivery is the failure-prone half of FCM).
          void registerPendingPushToken().catch(() => {});
        } else {
          useSessionStore.getState().setAnonymous();
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Splash holds until the local read lands AND the fonts are ready; no
  // network is involved. A font error degrades gracefully (warn and
  // proceed) rather than bricking start-up behind a permanent splash.
  useEffect(() => {
    if (fontError) {
      console.warn('[fonts] Plex failed to load:', fontError);
    }
    if (status !== 'boot' && (fontsLoaded || fontError)) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [status, fontsLoaded, fontError]);

  // No frame until the session is known and type is Plex.
  if (status === 'boot' || (!fontsLoaded && !fontError)) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
