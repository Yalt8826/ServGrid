/**
 * Root layout — providers, session bootstrap, splash hold
 * (PLAN-FRONTEND.md §2). Bootstrap reads the token store ONCE, locally:
 * no refresh call is awaited before first paint (§5.1). The splash gate
 * waits on that local read and nothing else; bundled fonts load behind
 * it (T0.12 adds the Plex faces). The role-aware QueryClientProvider
 * lives in (app)/_layout — it needs the role, which cold start may not
 * have yet.
 */
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { api } from '../src/lib/api';
import { bootstrapSession } from '../src/state/bootstrapSession';
import { configureQueryClient } from '../src/state/runtimeQueryClient';
import { useSessionStore } from '../src/state/sessionStore';

// Best-effort: a double-call or missing native module must not crash
// start-up — the splash is presentation, not state.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const status = useSessionStore((s) => s.status);

  useEffect(() => {
    let alive = true;
    bootstrapSession(api)
      .catch(() => ({ authenticated: false, actor: null }))
      .then((outcome) => {
        if (!alive) return;
        if (outcome.authenticated && outcome.actor !== null) {
          configureQueryClient(outcome.actor.role);
          useSessionStore.getState().setAuthenticated(outcome.actor);
        } else {
          useSessionStore.getState().setAnonymous();
        }
        return SplashScreen.hideAsync().catch(() => {});
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Splash holds until the local read lands; no network is involved.
  if (status === 'boot') return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
