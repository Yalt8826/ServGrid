/**
 * `(app)` group — the authenticated shell. NavShell (T0.13) replaces the
 * placeholder layout with tabs on Android and a left rail on web;
 * RoleGate lands there too. Until then a plain Stack renders the route
 * tree the same way on every platform.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { configureQueryClient } from '../../src/state/runtimeQueryClient';
import { useSessionStore } from '../../src/state/sessionStore';

function QueryProvider({ children }: { children: ReactNode }) {
  const actor = useSessionStore((s) => s.actor);
  const client = actor !== null ? configureQueryClient(actor.role) : null;
  if (client === null) return <>{children}</>;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export default function AppLayout() {
  return (
    <QueryProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="dashboard" />
        <Stack.Screen name="jobs/index" />
        <Stack.Screen name="jobs/new" />
        <Stack.Screen name="jobs/[id]/index" />
        <Stack.Screen name="jobs/[id]/complete" />
        <Stack.Screen name="jobs/[id]/cancel" />
        <Stack.Screen name="jobs/[id]/events" />
        <Stack.Screen name="customers/index" />
        <Stack.Screen name="customers/new" />
        <Stack.Screen name="customers/[id]/index" />
        <Stack.Screen name="customers/[id]/stack" />
        <Stack.Screen name="sales/index" />
        <Stack.Screen name="sales/new" />
        <Stack.Screen name="sales/[id]" />
        <Stack.Screen name="payments/index" />
        <Stack.Screen name="payments/new" />
        <Stack.Screen name="companies/index" />
        <Stack.Screen name="companies/[id]" />
        <Stack.Screen name="contracts/index" />
        <Stack.Screen name="contracts/new" />
        <Stack.Screen name="contracts/renewals" />
        <Stack.Screen name="contracts/[id]" />
        <Stack.Screen name="products/index" />
        <Stack.Screen name="products/[id]" />
        <Stack.Screen name="services/index" />
        <Stack.Screen name="employees/index" />
        <Stack.Screen name="employees/new" />
        <Stack.Screen name="employees/[id]" />
        <Stack.Screen name="location/index" />
        <Stack.Screen name="location/[employeeId]" />
        <Stack.Screen name="cash/index" />
        <Stack.Screen name="cash/handover" />
        <Stack.Screen name="profile/index" />
        <Stack.Screen name="profile/tracking" />
        <Stack.Screen name="profile/settings" />
      </Stack>
    </QueryProvider>
  );
}
