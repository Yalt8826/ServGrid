/**
 * `(auth)` group — login, consent, forced password change. Its layout
 * owns the QueryClientProvider: a role is known here (a stored actor
 * redirected in, or a login just succeeded), so the role-aware client
 * can exist.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { configureQueryClient } from '../../src/state/runtimeQueryClient';
import { useSessionStore } from '../../src/state/sessionStore';

/**
 * Never queried: nothing inside (auth) mounts a query before a role
 * exists. The provider must wrap the Stack on both sides of the first
 * login — flipping Fragment → Provider exactly when onAuthenticated
 * navigates to /consent remounts the Stack mid-navigation and the
 * action lands on a tree that no longer exists (a first tracked login
 * bounced back to a cleared login form, REPLACE {name: consent}
 * unhandled). Post-login configureQueryClient returns the real
 * idempotent-once singleton.
 */
const PRE_LOGIN_CLIENT = new QueryClient();

function QueryProvider({ children }: { children: ReactNode }) {
  const actor = useSessionStore((s) => s.actor);
  const client = actor !== null ? configureQueryClient(actor.role) : PRE_LOGIN_CLIENT;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export default function AuthLayout() {
  return (
    <QueryProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="consent" />
        <Stack.Screen name="ladder" />
        <Stack.Screen name="change-password" />
      </Stack>
    </QueryProvider>
  );
}
