/**
 * `(auth)` group — login, consent, forced password change. Its layout
 * owns the QueryClientProvider: a role is known here (a stored actor
 * redirected in, or a login just succeeded), so the role-aware client
 * can exist.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { configureQueryClient } from '../../src/state/runtimeQueryClient';
import { useSessionStore } from '../../src/state/sessionStore';

function QueryProvider({ children }: { children: ReactNode }) {
  const actor = useSessionStore((s) => s.actor);
  // configureQueryClient is idempotent-once: it builds the client the
  // first time a role exists and returns the same client after.
  const client = actor !== null ? configureQueryClient(actor.role) : null;
  if (client === null) return <>{children}</>;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export default function AuthLayout() {
  return (
    <QueryProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="consent" />
        <Stack.Screen name="change-password" />
      </Stack>
    </QueryProvider>
  );
}
