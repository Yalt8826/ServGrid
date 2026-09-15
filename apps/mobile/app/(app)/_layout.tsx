/**
 * `(app)` group — the authenticated shell (T0.13). RoleGate redirects a
 * route the role cannot reach to that role's landing route; NavShell
 * renders the role's group map as bottom tabs on a phone and a left rail
 * on the owner's desktop web build, and sets density exactly once. The
 * role-aware QueryClientProvider wraps both: it needs the role, which
 * cold start may not have yet.
 *
 * Online-only (decision 2026-09-15): no mirror session opens here any
 * more. The query cache is memory only, and a lost connection covers the
 * stack without unmounting it (PLAN-FRONTEND.md §5).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { NoConnectionGate } from '../../src/components/NoConnectionGate';
import { NavShell } from '../../src/navigation/NavShell';
import { RoleGate } from '../../src/navigation/RoleGate';
import { PushWakeBridge } from '../../src/notifications/PushWakeBridge';
import { configureQueryClient } from '../../src/state/runtimeQueryClient';
import { useSessionStore } from '../../src/state/sessionStore';

function QueryProvider({ children }: { children: ReactNode }) {
  const actor = useSessionStore((s) => s.actor);
  const client = actor !== null ? configureQueryClient(actor.role) : null;
  if (client === null) return <>{children}</>;
  return (
    <QueryClientProvider client={client}>
      {/* A data-only push wake refetches the technician's work (T2.6). */}
      <PushWakeBridge />
      {children}
    </QueryClientProvider>
  );
}

export default function AppLayout() {
  return (
    <QueryProvider>
      <NoConnectionGate>
        <RoleGate>
          <NavShell>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="dashboard" />
              <Stack.Screen name="jobs/index" />
              <Stack.Screen name="jobs/new" />
              <Stack.Screen name="jobs/logs" />
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
              <Stack.Screen name="payments/[id]" />
              <Stack.Screen name="companies/index" />
              <Stack.Screen name="companies/new" />
              <Stack.Screen name="companies/[id]" />
              <Stack.Screen name="contracts/index" />
              <Stack.Screen name="contracts/new" />
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
          </NavShell>
        </RoleGate>
      </NoConnectionGate>
    </QueryProvider>
  );
}
