/**
 * Employee detail — route (UI/plan-2/07-OWNER.md §O7, T4.12). The
 * equipment record: identity, role, the health chip, and all eight
 * device diagnostics per install. Deactivation runs under `If-Match`;
 * the 409's blocking rows render as the linked list, not a message.
 */
import { useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { OwnerEmployeeDetailScreen } from '../../../src/screens/owner/EmployeeDetailScreen';
import { useDeactivateEmployee, useOwnerEmployeeDetail, useOwnerEmployees } from '../../../src/screens/owner/useOwnerData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerEmployeeDetailRoute({ employeeId }: { employeeId: string }): React.ReactNode {
  const router = useRouter();
  const detail = useOwnerEmployeeDetail(employeeId);
  const roster = useOwnerEmployees();
  const { busy, blocking, deactivate } = useDeactivateEmployee();
  const [dialogOpen, setDialogOpen] = useState(false);

  const health = roster.healthRows.find((h) => h.employeeId === employeeId) ?? null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerEmployeeDetailScreen
        identity={{
          fullName: detail.detail?.fullName ?? '',
          username: detail.detail?.username ?? '',
          role: detail.detail?.role ?? '',
          phone: detail.detail?.phone ?? null,
          isActive: detail.detail?.isActive ?? false,
          lastLoginAt: detail.detail?.lastLoginAt ?? null,
          createdAt: detail.detail?.createdAt ?? '',
        }}
        health={health}
        devices={detail.detail?.devices ?? []}
        error={detail.error}
        blocking={blocking}
        busy={busy}
        deactivateDialogOpen={dialogOpen}
        onDeactivate={() => setDialogOpen(true)}
        onConfirmDeactivate={() => {
          setDialogOpen(false);
          const version = detail.detail?.version;
          if (version !== undefined) {
            void deactivate(employeeId, version).then((ok) => {
              if (ok) detail.reload();
            });
          }
        }}
        onCancelDeactivate={() => setDialogOpen(false)}
        onOpenLink={(route) => router.push(route)}
        onRetry={detail.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const employeeId = Array.isArray(params.id) ? params.id[0] : params.id;
  if (actor === null || employeeId === undefined) return null;
  if (actor.role === 'owner') return <OwnerEmployeeDetailRoute employeeId={employeeId} />;
  return (
    <View style={styles.root}>
      <Text>Employee</Text>
    </View>
  );
}
