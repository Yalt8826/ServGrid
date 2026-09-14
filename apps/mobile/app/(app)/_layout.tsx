/**
 * `(app)` group — the authenticated shell (T0.13). RoleGate redirects a
 * route the role cannot reach to that role's landing route; NavShell
 * renders the role's group map as bottom tabs on a phone and a left rail
 * on the owner's desktop web build, and sets density exactly once. The
 * role-aware QueryClientProvider wraps both: it needs the role, which
 * cold start may not have yet.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { NavShell } from '../../src/navigation/NavShell';
import { RoleGate } from '../../src/navigation/RoleGate';
import { api } from '../../src/lib/api';
import { MirrorProvider } from '../../src/sync/MirrorProvider';
import { systemTriggers } from '../../src/sync/triggers';
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
      {/*
       * T1.15: the mirror session opens here, off the splash path — the
       * root layout has already bootstrapped the session from the token
       * store (a local read), so nothing above or below this provider
       * awaits the network before first render. `send` and `triggers`
       * are the platform seams; Metro resolves `triggers` to its
       * `.native.ts` counterpart on the handset and this file's default
       * (inert) counterpart on web, where no offline role exists.
       */}
      <MirrorProvider send={api.request} triggers={systemTriggers}>
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
          </NavShell>
        </RoleGate>
      </MirrorProvider>
    </QueryProvider>
  );
}
